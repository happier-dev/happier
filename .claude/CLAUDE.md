# Claude Code Project Notes

The root `CLAUDE.md` imports the repository constitution from `AGENTS.md`; do not reread it when it is already present in active context.

## Background subagents and permissions

Background subagents cannot prompt for missing tool permissions. If a tool call is denied because it is not allowed in `.claude/settings.json`, fail fast and report the exact tool, command, and missing permission. Do not retry permission-denied calls in a loop.

Run commands in the foreground when interactive approval may be required.

## Agent routing and Happier-managed runs

Use the current provider's native subagent facility for ordinary subagent, delegation, and parallel-agent requests. Native provider subagents remain the default.

Use a Happier-managed execution/delegation run only when:

- the user explicitly asks for a Happier-managed run, delegation, or subagent—including natural wording such as “Happier subagent,” “Happier delegation run,” or “Happier execution run”;
- the user explicitly requests another backend, provider, model, account, or service that the current provider's native facility cannot satisfy; or
- an enabled custom rule explicitly requires Happier.

Do not silently change backend, provider, model, account, or execution topology. A generic request remains native even if a Happier action is discoverable. If a native or Happier run fails, do not substitute another backend unless the user request or an enabled custom rule authorizes it.

Runtime prompt guidance and runtime action discovery are authoritative. After a Happier authorization condition applies, use `action_spec_search` / `action_spec_get` to discover the current action contract and `action_options_resolve` with the action's partial draft to resolve valid backend, model, configuration, and connected-service values. Do not duplicate the runtime action catalog here, guess values, or rely on hard-coded option-source ids.

For bounded Happier delegation, discover and use `subagents.delegate.start`; use `execution.run.start` when the requested work needs its lower-level controls. In an in-session call, omit `sessionId` to host the run in the current invoking session. An explicit `sessionId` remains supported for a deliberate authorized cross-session target.

Monitor runs through the discovered action contract: use start-and-wait or `execution.run.wait` for bounded observation, and use the action-based list/send/stop surfaces when needed. A wait timeout is observational and the run may still be active. Do not create filesystem watchers, completion ledgers, marker files, or report-file conventions to infer execution-run completion.

`session.spawn_new` creates an independent, persistent top-level Happier session. It remains valid for that purpose, but it is not routine delegation.

## Orchestration economy

- **Keep the orchestrator context lean:** detail lives in the workspace tracking docs, not in lane
  prompts or orchestrator prose. Every tracking-doc edit by a lane is auto-injected into the main
  context — that is the (worthwhile) tax of the living-ledger pattern; don't add to it with
  redundant status narration.
- **Lane reports live in per-lane files; ONLY the orchestrator writes the shared TRACKING.md.**
  This avoids the auto-injection tax entirely for lane detail: lanes write
  `subagents/<lane>.md`, the orchestrator merges one-line statuses into the ledger. (Proven on the
  2026-07-02 perf program: ~20 lanes, zero ledger injection churn.)
- **Subagent final messages ≤ 20 lines.** The final message is for the orchestrator, not the user;
  everything else belongs in the lane report file. Long final messages are pure orchestrator-context
  burn.
- **Reviewer ≠ author remains mandatory for corridor and ship gates.** Large plans reference the
  root constitution and repository skills rather than copying a private operating manual. Plan-local
  documents contain only product decisions, seam ownership, acceptance criteria, and evidence specific
  to that program.
- Any lane touching user-facing surfaces, components, or animations must load the
  `make-interfaces-feel-better` and `interface-details` skills before writing surface code, reuse
  existing components, themed tokens, and text primitives, and treat duplicate animation/UI primitives
  as a review finding.

## Delegation shape (what worked)

- **Corridor-sized lanes, never micro-tasks.** A lane owns a whole responsibility (a corridor, a
  full QA matrix, a full review) end to end: analysis, implementation, tests, validation, ledger
  updates. Micro-slicing (one-boolean extractions) provably grows god-files instead of shrinking
  them. A lane-specific net-negative LOC gate is allowed when measured god-file contraction is the
  explicit outcome; it is not a universal architecture or review rule.
- **Coordinate real collisions, not dirty files.** Uncommitted and concurrently edited files are
  normal shared state and do not reserve a file. Inspect current bytes and layer compatible changes;
  coordinate only overlapping hunks, incompatible decisions for one live seam, generated outputs
  with one producer, destructive moves/rewrites, or exclusive mutable runtime resources.
- **Record material transitions, not every thought.** Update the lane report and orchestrator
  ledger when scope, ownership, validation basis, finding disposition, validation state, or a
  blocker materially changes. Do not create per-microchange packets or ledger churn.
- **Stalled/killed agent ≠ lost work.** Before re-running, check its artifacts (report, evidence
  files, ledger rows, and native run/session). Resume through the current provider's native
  continuation facility instead of restarting; only fresh-start when the transcript/session is genuinely gone.
- **Verify lane claims.** Reports referencing files that don't exist, "green" suites that are red
  at the lane's own commit, and inflated LOC deltas all happened. Reviewers rerun the tests
  themselves against the current source basis and attribute concurrent churn explicitly.
- **Adversarial review at composed boundaries.** Authors run `.agents/skills/attack-conclusion` while
  building. Independent review and `.agents/skills/verify-claims` target load-bearing delegated claims and
  the consumed vertical, corridor gate, or ship gate—not every microchange. After
  accepted fixes, review the finding delta unless the validated source, contract, scope, or risk changed
  materially. Author ≠ reviewer remains mandatory for corridor and ship gates.

## Validation doctrine

Use the active root `AGENTS.md` rules ("Risk-weighted execution" and "Testing: contract value, not test volume") plus `.agents/skills/happier-testing`; do not maintain a Claude-only copy or reread the root file when it is already in context.

## Plan execution and recovery

Use `.agents/skills/happier-implement-plan` for generic approved-plan execution, parallelism, dirty-worktree
coordination, uncertainty resolution, status/evidence, QA/review boundaries, amendments, and
completion. This file owns only the Claude/Happier execution-run mechanics above and the
program-specific facts below; do not maintain a second copy of the cross-tool workflow here.

Use Git safety and the existing plan/review workspace as the normal recovery surface. Snapshot only
genuinely non-recoverable external/session evidence or when the user explicitly requests it; do not
tar transcript trees before routine lanes.

## Program-specific execution facts

- **Vocabulary coordination before introducing manifest/SDK/cross-package names:** plugin-sdk-v1
  DEC-4 + providers-first-class reserve bare `provider(s)`/`providerId` for model providers and
  mandate `agent*` for executable agents; voice/oauth/scm provider naming is on the keep-list.
  Exchange ledger pointers with the owning plan's orchestrator and run their deny-list greps before
  landing new vocabulary.
- **Real voice/audio QA is possible — don't hand-wave it.** Recipe (fixture WAVs + Chromium
  `--use-file-for-fake-audio-capture` + the `voiceQaController` injection seam + BlackHole for
  sim/emulator mic) lives in the dev repo at
  `.project/plans/2026-07-09-voice-deep-audit-and-provider-extensibility/VOICE-QA-STRATEGY.md`.
  AEC/audio-focus/route quality stays an explicit human device gate — never fake-PASS it.
