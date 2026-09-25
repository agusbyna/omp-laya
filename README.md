# omp-laya

Thin omp wrapper around [@receptron/laya](https://github.com/receptron/laya) — fast System-1 decisions (choice / score / noul) inside omp.

## Install

```sh
omp plugin install github:agusbyna/omp-laya
```

Requires Node >= 20.

## Usage

```
/laya '<state JSON or text>' '<questions JSON>'
```

Choice:

```
/laya '{"subject":"refund","body":"cancelled two weeks ago, no refund yet"}' '{"department":{"type":"choice","instructions":"Which team?","criteria":["billing","support"]}}'
```

Score:

```
/laya '{"text":"server down, all users affected"}' '{"urgency":{"type":"score","instructions":"How urgent?","criteria":["low","high"]}}'
```

Noul (boolean):

```
/laya '{"text":"customer paid twice"}' '{"is_billing":{"type":"noul","instructions":"Is this a billing issue?"}}'
```

Returns the `systemOne` result as JSON (answers + probabilities + confidence).

`LAYA_MODEL_DIR` env var: use a local ONNX bundle instead of the Hugging Face download.

## Prompt pre-screen hook

Every prompt is classified by laya **before** it reaches the LLM. The plugin registers a
`before_agent_start` handler that runs `systemOne` on the prompt and appends one line to the turn's
context:

```
[laya pre-screen, automated] intent=bug (p=0.86, conf=0.65) | underspecified=0.31
```

- `intent` (choice): `question` / `task` / `bug` / `chat` — primary intent of the message.
- `underspecified` (noul): P(the request needs clarifying questions before acting).

The schema is a fixed `HOOK_QUESTIONS` constant in `extension.ts`; edit it there to change the
classification. First prompt of a session pays the model load (~12s warm cache); later prompts cost
one inference (~100ms).

Failure is always safe: a laya error or a handler timeout is logged and dropped, and the prompt
continues to the LLM unchanged. `LAYA_HOOK=off` disables the pre-screen entirely (the `/laya`
command keeps working).

## First-use download

The first `/laya` call (or the first prompt, if the hook is enabled) runs `Laya.load()`, which
downloads the ~1.7GB ONNX bundle from Hugging Face into `~/.cache/receptron-laya`. Later calls
reuse the cached bundle (and the in-process instance). Installing or starting omp never downloads
anything — the import is lazy inside the handler.
