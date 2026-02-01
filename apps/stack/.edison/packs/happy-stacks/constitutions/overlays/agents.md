<!-- EXTEND: pack-constitution -->
## Hapsta execution discipline (MANDATORY)

- **Task structure is mandatory (fail-closed via guards)**:
  - Create a **parent task** first (`hs_kind: parent`) that declares:
    - `components: [happy, happy-cli, ...]`
    - (Parent tasks can span multiple tracks/stacks and are **not claimable**.)
  - Create **one track task per track** (`hs_kind: track`) as a child of the parent:
    - **One stack per track**: `stack: <name>`
    - `track: upstream|fork|integration`
    - `components: [...]` (what this stack pins)
    - `base_task: <parent-task-id>`
  - Create **one component task per component** (`hs_kind: component`) as a child of a track task:
    - `stack` must match the track task stack
    - `component: happy` (exactly one)
    - `base_task: <parent-task-id>`
    - `base_worktree: edison/<task-id>`
  - **Never claim/finish the parent task**; claim a track or component task instead.

- **Only run project commands via `hapsta ...`**.
  - Do **not** run `yarn/npm/npx/expo/tsc/docker compose` directly inside repo checkouts/worktrees.
  - Route everything through `hapsta` so stacks/env/worktrees/ports stay isolated.
  - Do **not** run `edison ...` directly in this repo:
    - Use `hapsta edison -- <edison args...>`
    - Use `hapsta edison --stack=<stack> -- <edison args...>` for task/evidence/validation
    - See: `.edison/guidelines/agents/HAPPIER_STACK_EDISON_WRAPPER.md`
  - If any core Edison docs mention “worktree confinement” or `edison exec` workflows:
    - Treat them as **not applicable** to happier-dev (Edison worktrees are disabled here).
    - Hapsta rules override.

- **Develop in monorepo worktrees only**.
  - Do **not** work directly on the primary monorepo checkout; use a git worktree for changes.
  - Use `hapsta wt new ...` / `hapsta wt pr ...` and open/edit the worktree under `<workspace>/.worktrees/...` (default: `~/.happier-stack/workspace/.worktrees`).

- **Test changes inside an isolated stack** (not `main`).
  - Create a stack: `hapsta stack new <name> --interactive`
  - Point the stack at your worktree: `hapsta stack wt <name> -- use <owner/branch|path|default|main>`
  - Recommended (one-shot): scaffold the whole structure + stacks + worktrees:
    - `hapsta edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes`
  - **Fail-closed**: Edison task transitions require running inside the correct stack context:
    - `hapsta edison --stack=<stack> -- <edison command>`
  - Helpful reads:
    - `hapsta edison -- read START_PLAN_FEATURE --type start`
    - `hapsta edison -- read START_VALIDATE_TASK --type start`
    - `hapsta edison -- read START_HAPSTA_NEW_SESSION --type start`

- **Auth failures: prefer copy-from your configured seed stack** (non-interactive, safe).
  - Recommended seed: `dev-auth` (set by developers via `HAPPIER_STACK_AUTH_SEED_FROM=dev-auth`).
  - `hapsta stack auth <stack> copy-from dev-auth`
  - If you don't know the seed stack, fall back to: `hapsta stack auth <stack> copy-from main`

- **Dev UI login key (agents should only consume, not create)**:
  - Print the UI-accepted dev key format: `hapsta auth dev-key --print`

- **Multiple daemons are expected** with multiple stacks.
  - Do **not** kill all daemons. Diagnose per stack.

## Evidence (trusted runner)

- Capture required evidence via Edison:
  - `hapsta edison --stack=<stack> -- evidence capture <task-id>`
  - This runs stack-scoped `hapsta stack typecheck/lint/build/test` and fingerprints the *actual* repo/worktree used by that stack.

## Happy component translations (MANDATORY where applicable)

These rules apply **only** when the task’s target component repo has an i18n system. Today:

- **`happy`**: translated ✅ (mandatory)
- **`happy-cli`**: not translated (no i18n system)
- **`happy-server` / `happy-server-light`**: not translated (no i18n system)

### Component: `happy` (translated UI — MUST translate)

- **Do not ship new user-facing strings without translations**.
  - Any new UI copy must use `t('...')` from `@/text` (not hardcoded string literals in JSX).
  - If you touch screens/components and add new labels, headers, help text, errors, etc., you must add translation keys.

- **Source-of-truth & file layout**:
  - **Keys + runtime English + types** live in `sources/text/_default.ts` (`export const en = {...} as const`).
  - **Language registry** lives in `sources/text/_all.ts` (`SupportedLanguage`, `SUPPORTED_LANGUAGES`, `DEFAULT_LANGUAGE`).
  - **Per-language translations** live in `sources/text/translations/<lang>.ts` and must match `TranslationStructure` from `_default.ts`.
  - **Keep `sources/text/translations/en.ts` in sync** with `_default.ts` (it exists and is used by tooling/scripts even if runtime English comes from `_default.ts`).

- **How to add / change translatable strings (required workflow)**:
  - **Add/modify the key in `sources/text/_default.ts`** under the most appropriate existing section.
  - **Mirror the same key change in every supported language file** under `sources/text/translations/`:
    - `ca`, `en`, `es`, `it`, `ja`, `pl`, `pt`, `ru`, `zh-Hans`
  - **If the translation is dynamic**:
    - Use a function value that takes a **single typed object param** (e.g. `({ count }: { count: number }) => ...`).
    - Keep **parameter names and types identical across all languages** for the same key.
    - Follow existing per-language pluralization helpers (some languages have custom plural rules).

- **Allowed “same as English” cases** (do not translate blindly):
  - Keep common technical/proper tokens in English where appropriate (examples seen in repo patterns): `GitHub`, `URL`, `API`, `CLI`, `OAuth`, `QR`, `JSON`, `HTTP`, `HTTPS`, `ID`, `PID`.

- **Verification (must be stack-scoped via Hapsta)**:
  - Run a stack-scoped typecheck for the `happy` component (or capture evidence). Missing keys/shape mismatches must fail the typecheck due to `TranslationStructure`.

### Component: `happy-cli` (not translated — do NOT “half-translate”)

- There is **no enforced i18n system** in this repo today.
- Do **not** introduce partial translation patterns (no ad-hoc locale maps, no scattered i18n helpers) as part of unrelated work.
- If you believe i18n should be introduced, treat it as an **explicit feature/architecture change** and update these constitution rules accordingly.

### Component: `happy-server` / `happy-server-light` (not translated)

- These repos do **not** use the `happy` UI translation system.
- Do **not** translate server logs/errors piecemeal unless/until a dedicated server-side i18n system exists.

{{include:constitutions/includes/HAPPY_CRITICAL_PRINCIPLES.md}}
<!-- /EXTEND -->
