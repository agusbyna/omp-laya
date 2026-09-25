# omp-laya

Thin omp wrapper around [@receptron/laya](https://github.com/receptron/laya) — fast System-1 decisions (choice / score / noul) inside omp.

## Install

```sh
omp plugin install github:omp-laya/omp-laya
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

## First-use download

The first `/laya` call runs `Laya.load()`, which downloads the ~1.7GB ONNX bundle from Hugging Face into `~/.cache/receptron-laya`. Later calls reuse the cached bundle (and the in-process instance). Installing or starting omp never downloads anything — the import is lazy inside the command handler.
