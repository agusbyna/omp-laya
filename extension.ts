import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Laya instance is cached after the first call in this process. Lazy import
// keeps `omp` startup fast and avoids the ~1.7GB model download until use.
let laya: { systemOne(state: unknown, questions: Record<string, unknown>): Promise<unknown> } | null = null;

async function getLaya(modelDir?: string) {
	if (laya) return laya;
	const { Laya } = await import("@receptron/laya");
	laya = await Laya.load(modelDir ? { modelDir } : undefined);
	return laya;
}

export default function ompLaya(pi: ExtensionAPI) {
	pi.registerCommand("laya", {
		description: "System-1 decision: /laya '<state-as-JSON-or-text>' '<questions-as-JSON>'",
	handler: async (args, ctx) => {
		const parsed = parseArgs(String(args || ""));
		if (!parsed) {
			const received = String(args || "");
			const shown = received.length > 200 ? received.slice(0, 200) + "…" : received;
			ctx.ui.notify(
				`Usage: /laya '<state JSON or text>' '<questions JSON>'\nExample: /laya '{"subject":"refund","body":"..."}' '{"department":{"type":"choice","instructions":"Which team?","criteria":["billing","support"]}}'\nReceived: ${shown || "(empty)"}\nReason: ${parseArgsReason(String(args || "")) || "unknown"}`,
				"info",
			);
			return;
		}
			try {
				const model = await getLaya(process.env.LAYA_MODEL_DIR || undefined);
				const result = await model.systemOne(parsed.state, parsed.questions);
				return JSON.stringify(result, null, 1);
			} catch (err) {
				ctx.ui.notify(`laya failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// Pre-screen every prompt through laya before it reaches the LLM. The returned
	// message is appended to the turn's context right after the user prompt.
	// LAYA_HOOK=off disables it. A slow first model load or a laya error degrades
	// to "no pre-screen" (omp catches handler errors/timeouts) — the prompt always flows.
	pi.on("before_agent_start", async (event) => {
		if (process.env.LAYA_HOOK === "off") return;
		const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
		if (!prompt) return;
		try {
			const model = await getLaya(process.env.LAYA_MODEL_DIR || undefined);
			const result = (await model.systemOne({ prompt }, HOOK_QUESTIONS)) as {
				answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; score?: number; noul?: number }>;
			};
			return { message: `[laya pre-screen, automated] ${formatAnswers(result.answers)}` };
		} catch (err) {
			console.error(`laya before_agent_start: ${(err as Error).message}`);
		}
	});
}

// Fixed triage schema for the hook: what the prompt wants, and whether it is actionable.
const HOOK_QUESTIONS = {
	intent: {
		type: "choice",
		instructions: "Primary intent of this user message to a coding assistant",
		criteria: {
			question: "asks how/why — explanation only, no changes",
			task: "requests a change, build, or fix",
			bug: "reports an error, failure, or unexpected behavior",
			chat: "greeting, thanks, or small talk",
		},
	},
	underspecified: {
		type: "noul",
		instructions: "The request lacks details needed to act on it without asking clarifying questions",
	},
};

function fmt(n: unknown): string {
	return typeof n === "number" ? n.toFixed(2) : "?";
}

function formatAnswers(answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; score?: number; noul?: number }>): string {
	const parts: string[] = [];
	for (const [name, a] of Object.entries(answers)) {
		if (a?.type === "choice")
			parts.push(`${name}=${a.choice} (p=${fmt(a.probabilities?.[a.choice ?? ""])}, conf=${fmt(a.confidence)})`);
		else if (a?.type === "score") parts.push(`${name}=${fmt(a.score)} (conf=${fmt(a.confidence)})`);
		else if (a?.type === "noul") parts.push(`${name}=${fmt(a.noul)}`);
	}
	return parts.join(" | ");
}

// Split args into [state, questions]; each may be single- or double-quoted JSON, or bare text (state only).
// Tolerates TUI stripping outer quotes: falls back to brace-matching when splitArgs fragments the JSON.
export function parseArgs(args: string): { state: unknown; questions: Record<string, unknown> } | null {
	return parseInner(args.trim()).value;
}

// Null when valid; otherwise a specific reason (used in Usage message + tests).
export function parseArgsReason(args: string): string | null {
	return parseInner(args.trim()).reason;
}

function parseInner(s: string): { value: { state: unknown; questions: Record<string, unknown> } | null; reason: string | null } {
	if (!s) return fail("kurang argumen: butuh <state> dan <questions JSON>");
	const parts = splitArgs(s);
	if (parts.length >= 2) {
		const qRaw = parts.length === 2 ? parts[1] : parts.slice(1).join(" ");
		try {
			return ok(parseState(parts[0]), parseQuestions(qRaw));
		} catch (e) {
			// Wrong-type questions (array/string) is already specific — keep it. Only
			// malformed-JSON falls through to brace-matching (stripped quotes fragment JSON with spaces).
			if (!(e as Error).message.startsWith("questions bukan JSON")) return fail((e as Error).message);
		}
	}
	// Fallback: outer quotes stripped → splitArgs fragmented or fused the two JSON objects.
	const objs = extractJsonObjects(s);
	if (objs.length >= 2) {
		try {
			return ok(parseState(objs[0].text), parseQuestions(objs[objs.length - 1].text));
		} catch (e) {
			return fail((e as Error).message);
		}
	}
	if (objs.length === 1) {
		const prefix = s.slice(0, objs[0].start).trim();
		const suffix = s.slice(objs[0].end).trim();
		if (prefix && !suffix) {
			try {
				return ok(parseState(prefix), parseQuestions(objs[0].text));
			} catch (e) {
				return fail((e as Error).message);
			}
		}
		// Single fused part like {...}{...} with no gap mis-scanned as one? try split inside.
		const inner = splitFused(objs[0].text);
		if (inner) {
			try {
				return ok(parseState(inner[0]), parseQuestions(inner[1]));
			} catch (e) {
				return fail((e as Error).message);
			}
		}
	}
	return fail(parts.length < 2 && objs.length === 0 ? "kurang argumen: butuh <state> dan <questions JSON>" : "questions bukan JSON valid — bungkus questions dengan quote, mis. '{\"a\":{...}}'");
}

function ok(state: unknown, questions: Record<string, unknown>) {
	return { value: { state, questions }, reason: null } as const;
}

function fail(reason: string) {
	return { value: null, reason } as const;
}

function parseState(raw: string): unknown {
	try {
		return JSON.parse(stripOuter(raw));
	} catch {
		return stripOuter(raw);
	}
}

function parseQuestions(raw: string): Record<string, unknown> {
	const src = stripOuter(raw.trim());
	let q: unknown;
	try {
		q = JSON.parse(src);
	} catch {
		// Loose single-quote JSON: {'a':1} → {"a":1}. Only runs after strict parse fails.
		try {
			q = JSON.parse(singleToDouble(src));
		} catch (e) {
			throw new Error(`questions bukan JSON valid (${(e as Error).message}) — bungkus questions dengan quote, mis. '{"a":{...}}'`);
		}
	}
	if (!q || typeof q !== "object" || Array.isArray(q))
		throw new Error(`questions harus object JSON, dapat: ${Array.isArray(q) ? "array" : typeof q}`);
	return q as Record<string, unknown>;
}

function stripOuter(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0])
		return t.slice(1, -1);
	return t;
}

// Safely convert single-quoted strings to double-quoted (ignores apostrophes inside double quotes).
function singleToDouble(s: string): string {
	let out = "", i = 0, q = "";
	while (i < s.length) {
		const c = s[i];
		if (q === "'") {
			if (c === "\\" && i + 1 < s.length) { out += c === "'" ? "'" : c + s[i + 1]; i += 2; continue; }
			if (c === "'") { q = ""; out += '"'; i++; continue; }
			out += c === '"' ? '\\"' : c; i++; continue;
		}
		if (q) { out += c; if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; } if (c === q) q = ""; i++; continue; }
		if (c === "'") { q = "'"; out += '"'; i++; continue; }
		if (c === '"' || c === "{") { if (c === '"') q = '"'; out += c; i++; continue; }
		out += c; i++;
	}
	return out;
}

// Balanced {...} ranges, string-aware (both quotes + escapes). Used when outer quotes were stripped.
function extractJsonObjects(s: string): { start: number; end: number; text: string }[] {
	const objs: { start: number; end: number; text: string }[] = [];
	let depth = 0, start = -1, q = "", i = 0;
	while (i < s.length) {
		const c = s[i];
		if (q) {
			if (c === "\\" && i + 1 < s.length) { i += 2; continue; }
			if (c === q) q = "";
			i++; continue;
		}
		if (c === "'" || c === '"') { q = c; i++; continue; }
		if (c === "{") { if (depth === 0) start = i; depth++; i++; continue; }
		if (c === "}") {
			if (depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push({ start, end: i + 1, text: s.slice(start, i + 1) }); start = -1; } }
			i++; continue;
		}
		i++;
	}
	return objs;
}

// Split fused '{"a":1}{"b":2}' (no gap scanned as needed) into two object texts.
function splitFused(obj: string): [string, string] | null {
	let depth = 0, q = "";
	for (let i = 0; i < obj.length; i++) {
		const c = obj[i];
		if (q) {
			if (c === "\\") i++;
			else if (c === q) q = "";
			continue;
		}
		if (c === "'" || c === '"') q = c;
		else if (c === "{") depth++;
		else if (c === "}") { depth--; if (depth === 0 && i < obj.length - 1) return [obj.slice(0, i + 1), obj.slice(i + 1)]; }
	}
	return null;
}

function splitArgs(s: string): string[] {
	const out: string[] = [];
	let cur = "", quote = "", i = 0;
	while (i < s.length) {
		const c = s[i];
		if (quote) {
			if (c === "\\" && i + 1 < s.length) { cur += c + s[i + 1]; i += 2; continue; }
			if (c === quote) { quote = ""; i++; continue; }
			cur += c; i++; continue;
		}
		if (c === "'" || c === '"') { quote = c; i++; continue; }
		if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } i++; continue; }
		cur += c; i++;
	}
	if (cur) out.push(cur);
	return out;
}

// ponytail: no registerTool — examples show command-only plugins work; add when agents need direct calls.
