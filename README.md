# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wasu-tenan/mend-cli/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wasu-tenan/mend-cli/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

Entry for the make.fun competition [Build mend, one patch tool for every AI edit format](https://make.fun/c/hidden-spec-cli-01-run-20261122) — see also [make.fun](https://make.fun/?ref=2mmz0hmg).

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and mend reads all of them:

- **unified diffs**, including hunks whose line numbers are wrong (each hunk is placed at the occurrence nearest its stated line);
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`, with Add / Delete / Update / Move sections, anchors, a cursor and end-of-file chunks);
- **text-editor tool calls as JSON** (one array of edit objects, or JSON Lines: `create`, `str_replace`, `insert`).

Lines an edit names are matched at three tiers — exact, then ignoring trailing whitespace, then ignoring leading and trailing whitespace — and new lines are re-indented to the file's own indentation when only the third tier matches. Every edit in a patch is applied, or none of them is: a failed patch writes nothing and reports every failure.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree); absent or `-`, the patch is read from standard input.
- `--format=NAME` is one of `unified`, `search-replace`, `v4a`, `json`; the default, `auto`, detects the format from the patch text.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: 0 on success (one `A`/`D`/`M`/`R` line per changed path, then `ok: <n> files`), 1 when edits failed (one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and nothing is written), 2 for usage, unreadable-patch, format-detection and parse errors (a single `error: …` line).

`SPEC.md` is the full specification mend implements. Node 22, standard library only, zero dependencies.

## Practice checks

The kit's public practice set runs against `main.ts` through the kit's own runner:

    node check.ts <practice.json>

## License

MIT — see `LICENSE`.
