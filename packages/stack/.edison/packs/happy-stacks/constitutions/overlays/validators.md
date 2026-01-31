<!-- EXTEND: pack-constitution -->
## Happy Stacks validation guardrails (MANDATORY)

- **Do not recommend killing all daemons**. Multiple daemons are expected (one per stack).
- **Do not recommend bypassing `happys`** (no direct `pnpm/yarn/expo/docker compose`).
- **Do not run `edison ...` directly**:
  - Use `happys edison --stack=<stack> -- <edison args...>`
- **Validate stack-scoped behavior**:
  - Evidence should come from `happys edison --stack=<stack> -- evidence capture <task-id>`.
  - If evidence is missing, instruct operators to rerun with the correct `--stack` (fail-closed).

## Happy Stacks scope discipline (CRITICAL)

- **Validate only the repos/worktrees targeted by the task** (the component repos pinned by the stack).
  - For `hs_kind=component` tasks, the scope is the single `component:` repo in the task frontmatter.
  - For `hs_kind=track` tasks, the scope is the `components:` list in the task frontmatter.
- **Do not validate the happy-local orchestration repo by default**.
  - In multi-session development, the happy-local root worktree may be `gitDirty` with unrelated, in-flight work.
  - Treat root `git status` / `git diff` as **non-blocking context** unless the task explicitly targets the orchestration repo.
- **Fail-closed only on targeted repos**:
  - Reject if the *target component worktree* is dirty (uncommitted diffs) or evidence is missing/failing.
  - Do **not** reject just because happy-local root is dirty when the task does not include `happy-local` / `happy-stacks` as a component.
- **How to review the right code**:
  - Use the stack-resolved component dirs printed by the wrapper (`[edison] component dirs (from stack env): ...`).
  - If you need git status/diff, run them inside the component worktree directory (or via `happys wt git <component> ...`).
  - If the validator prompt lists “Changed Files (Detected)” in happy-local root that are unrelated to the targeted component repos, **ignore them** for scope/risk decisions.

## Diff review: validate against the correct base branch (MANDATORY)

When reviewing code changes, do **not** rely on `git diff` from the happy-local root.

- **The ONLY acceptable way to review a component’s task diff is command evidence**: `command-task-diff.txt`.
  - If it is missing, **fail-closed** and instruct the operator to re-run:
    - `happys edison --stack=<stack> -- evidence capture <task-id> --only task-diff`
  - Do **not** substitute ad-hoc `git diff` output from other repos/dirs as a replacement.

- **What `command-task-diff.txt` represents**:
  - A **per-component PR-style diff** computed *inside the stack-pinned component repos*.
  - The diff base is the stack’s configured remote **default branch** (derived from `HAPPY_STACKS_STACK_REMOTE` and that remote’s `HEAD`/default branch).
  - Each component section includes `baseRef: <remote>/<defaultBranch>` (examples: `upstream/main`, `origin/main`, `fork/happy-server-light`).

- **Multi-component tasks**:
  - For `hs_kind=track` tasks, `command-task-diff.txt` includes a section for **every component** listed in the task’s `components:` frontmatter.
  - This is the intended way to review “the diff for the whole track” across multiple repos.

- **How to view it (MUST use evidence commands; do NOT browse snapshot dirs)**:
  - Check freshness + completeness:
    - `happys edison --stack=<stack> -- evidence status <task-id> --preset <preset>`
  - View the diff evidence:
    - `happys edison --stack=<stack> -- evidence show <task-id> --command task-diff`
      - Use `--head N` / `--tail N` if needed.

- **Evidence must NOT be written into component repos/worktrees**:
  - Do not request “write the diff file in the repo/worktree”.
  - All evidence artifacts are produced via `edison evidence capture` and should be viewed via `edison evidence show`.

This ensures validators review the change set **as a PR diff on top of the targeted base branch**, rather than whatever happens to be dirty in the orchestration repo.

---

## Git command ban for validators (MANDATORY)

- **Do not run `git status` / `git diff` / `git log` / `git range-diff`** during validation in happy-local.
- Validators must use **trusted evidence** instead:
  - `command-task-diff.txt` for diffs
  - `command-track-coherence.txt` for cross-track patch checks
  - `command-type-check.txt`, `command-lint.txt`, `command-build.txt`, `command-test.txt` for automation

## TDD validation: do NOT police git commits for “TDD markers” (MANDATORY)

- This project enforces **TDD behavior**, not “TDD-looking commit history”.
- **Do not reject** a task because git commits/messages do not contain explicit “RED/GREEN/REFACTOR” markers.

## Happy component translations (MANDATORY where applicable)

Only enforce translation requirements for components that actually have an i18n system. Today:

- **`happy`**: translated ✅ (must enforce)
- **`happy-cli`**: not translated (no i18n system)
- **`happy-server` / `happy-server-light`**: not translated (no i18n system)

### Component: `happy` (translated UI — FAIL-CLOSED if missing)

- **Reject any UI copy changes that are not translated**.
  - If a diff adds/changes user-facing strings in `happy` UI code, you must see translation-key usage (`t('...')` via `@/text`) rather than hardcoded literals.

- **Translation source-of-truth** (what to verify in diffs):
  - `sources/text/_default.ts`: canonical keys + runtime English + types
  - `sources/text/translations/<lang>.ts`: per-language files matching `TranslationStructure`
  - `sources/text/translations/en.ts` must remain in sync with `_default.ts` (it exists and is used by tooling/scripts)

- **What “complete” means (minimum bar)**:
  - Any new/changed translation key added to `sources/text/_default.ts` is mirrored across **all supported languages** under `sources/text/translations/`:
    - `ca`, `en`, `es`, `it`, `ja`, `pl`, `pt`, `ru`, `zh-Hans`
  - Dynamic translations use a function with a single typed object parameter; **parameter names/types must match** across languages for the same key.

- **Allowed unchanged tokens**:
  - It is acceptable for common technical/proper tokens to remain in English where appropriate (examples aligned with repo conventions): `GitHub`, `URL`, `API`, `CLI`, `OAuth`, `QR`, `JSON`, `HTTP`, `HTTPS`, `ID`, `PID`.
  - Otherwise, “left in English” in non-English language files should be treated as missing translation and rejected.

- **Evidence expectations**:
  - Ensure `command-type-check.txt` (or the equivalent typecheck evidence for the `happy` component) is present and passing for the stack pinned to the task.
  - Translation-shape mismatches should fail typecheck due to `TranslationStructure`; if typecheck evidence is missing, fail-closed and request re-capture via Edison evidence.

### Component: `happy-cli` (not translated)

- Do not fail a task for “missing translations” in this repo (no i18n system).
- Do not request ad-hoc/partial translation infrastructure changes unless the task explicitly proposes adopting i18n.

### Component: `happy-server` / `happy-server-light` (not translated)

- Do not fail a task for “missing translations” in these repos (no i18n system).
  - Server logs/errors are not localized today; do not demand localized variants unless a server-side i18n system is introduced as an explicit feature.

{{include:constitutions/includes/HAPPY_CRITICAL_PRINCIPLES.md}}
<!-- /EXTEND -->

