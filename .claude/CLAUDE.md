# Claude Code Project Notes

The root `CLAUDE.md` imports the repository constitution from `AGENTS.md`; do not reread it when it is already present in active context.

## Background subagents and permissions

Background subagents cannot prompt for missing tool permissions. If a tool call is denied because it is not allowed in `.claude/settings.json`, fail fast and report the exact tool, command, and missing permission. Do not retry permission-denied calls in a loop.

Run commands in the foreground when interactive approval may be required.

## Model economy (Fable sessions + delegation)

Proven on the 2026-07-02/03 transcript corridor program; these are defaults, not suggestions.

- **Fable is the orchestrator and the corridor-gate reviewer — nothing else.** The main Fable
  session orchestrates authorized work, writes lane briefs, validates deliverables, and steers;
  it authors a repository plan only when the user explicitly requests planning. Independent reviews of
  completed corridors/critical changes run on Fable or Opus.
- **Never use Sonnet** for reviews, implementation, or QA/diagnosis/fix — its claims/diagnostics are unreliable. Use **gpt-5.5-high (Codex)** or **Fable** for everything, including browser/live/device QA lanes (Codex drives the agent-browser/agent-device CLI and owns the fixes). Subagents inherit the parent (Fable) model by default — always set `model` explicitly on Agent calls so a QA lane doesn't silently burn Fable budget; QA/evidence/mechanical → Codex; DEEP/independent reviews (adversarial passes, ship gates) → FABLE specifically.
- **Implementation lanes go to Codex (gpt-5.5, high reasoning), driven RAW** — no Claude wrapper
  babysitting a codex process:
  `codex exec -s workspace-write -C <repo-dir> -m gpt-5.5 -c 'model_reasoning_effort="high"' [resume <session-id>] "$(cat prompt.txt)"`
  as a background Bash task. Session ids live in `~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`
  (identify by cwd + keywords; record the id in the tracking doc at launch). The codex-companion
  wrapper's job registry lives in a happier-managed dir and gets wiped — do not rely on it for
  long lanes. Prompts always go through a file + `"$(cat …)"`: zsh executes backticks inside
  double-quoted inline prompts and shreds the brief.
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
- **Codex model id caveat:** this account rejects `gpt-5.5-high` as a model id — use
  `-m gpt-5.5 -c 'model_reasoning_effort="high"'` (the form above), or accept the account default.
- **Repeatedly-killed Fable lanes get handed to Codex, not resumed again.** Each SendMessage resume
  replays the lane's full transcript uncached; after the second kill, the cheaper path is a Codex
  handoff whose brief is the lane's on-disk report + `git status` of its files (proven with the
  IMPL-E lane). Design lane briefs so the report file alone is a sufficient restart brief.
- **Never use Haiku.** Model ranking and full routing policy live in the project memory
  (`model-delegation-policy.md`): bulk/mechanical → gpt-5.5; read-only search/exploration → sonnet
  (QA/diagnosis/fix stays Codex — never Sonnet, per the rule above); taste ≥ 7 for
  user-facing work; reviews → fable/opus; intelligence > taste > cost for anything that ships.
- **Deep/independent reviews, ship gates, corridor-gate reviewing, and taste-critical decisions run
  on Fable or Opus.** Reviewer ≠ author is absolute; never Codex-reviews-Codex on a gate. Large
  plans reference the root constitution and repository skills rather than copying a private
  operating manual. Plan-local documents contain only product decisions, seam ownership,
  acceptance criteria, and evidence that are specific to that program.
- **Large UI implementation goes to OPUS, not Codex** (proven better UI taste). Any lane touching
  user-facing surfaces/components/animations MUST load the `make-interfaces-feel-better` +
  `interface-details` skills before writing surface code, reuse existing components/themed tokens/
  text primitives exclusively, and treat a duplicate animation/UI primitive as a review finding.
  Taste-critical UI decisions: Fable or Opus.

## Delegating via the Happier MCP subagent runs (VERIFIED 2026-07-08 — prefer this over raw `codex exec` AND over spawning new sessions)

The Happier MCP (`mcp__happier__action_execute`, plus `action_spec_search` / `action_options_resolve` to discover actions + resolve field options) is the delegation surface. Enabled backends (verified): `agent:codex`, `agent:claude`, `agent:gemini`, `agent:opencode`, `agent:cursor`, `agent:copilot`, `agent:qwen`, `agent:kimi`, `agent:pi`, and more. Prefer it over raw `codex exec`: runs are UI-visible, fleet-managed, resumable across orchestrator compaction, model-economy-honored, and — critically — you can read the delegate's **own tool calls/results** to VERIFY what it actually did (anti-fake-DONE).

**The subagent primitive is an EXECUTION RUN within a session — NOT a new session.** Use `subagents.delegate.start` / `execution.run.start`, which parent a bounded, ephemeral subagent run (a sidechain) under the ORCHESTRATOR's session. Do NOT use `session.spawn_new` for lane delegation — that creates a heavy independent top-level session and loses fleet management. (Round-trip verified live 2026-07-08: a `subagents.delegate.start` codex run succeeded in ~16s and `execution.run.wait` returned the structured result inline — `summary` + `deliverablesDigest` — no cold start, no separate transcript fetch.)

Round-trip (every action below confirmed working):
- **Delegate a lane (ergonomic default)** → `action_execute` `subagents.delegate.start` `{ sessionId, backendTargetKeys: ["agent:codex", …], instructions: "<lane brief>" }` → returns per-target `{ runId, callId, sidechainId }`. Fans out to multiple backends in one call. `subagents.plan.start` (`/h.plan`) is the planning variant and is used only for an explicit user-requested planning task; `review.start` runs parallel review engines (each engine = its own run).
- **Delegate with full control** → `execution.run.start` `{ sessionId, intent, backendTarget: { kind:"builtInAgent", agentId:"codex" }, instructions, permissionMode, retentionPolicy, runClass, ioMode, initialContextMode }` when you need to set permission mode / retention / run class / io mode explicitly.
- **Await + get result (best — returns result inline)** → `execution.run.wait` `{ sessionId, runId, timeoutSeconds, pollIntervalMs }` → `{ status, result: { run, latestToolResult: { summary, deliverablesDigest } } }`. Polls to terminal status; no separate transcript read needed for the headline result.
- **Fleet monitor / continue / stop** → `execution.run.list` `{ sessionId, status:"running"|"succeeded"|… }`, `execution.run.send` `{ runId, message, resume:true }` (iterate/continue a run), `execution.run.stop` `{ runId }`. For deep verification of what a run DID, read its sidechain: `session.transcript.get`/`session.events.get` `{ sessionId, scope:"sidechain", sidechainId, kinds:["tool_call","tool_result"] }`.
- **Record the `runId` + `sidechainId` in the lane Ledger at launch** — survives your compaction; reattach with `execution.run.send`/`wait`.

**CRITICAL — Happier execution runs do NOT emit `<task-notification>` (arm a watcher or you will never know they finished).** The auto `<task-notification>` only fires for Claude Code **Agent/Task-tool** subagents. Happier execution runs (`subagents.delegate.start` / `execution.run.start`) are sidechains — the harness does NOT re-invoke your session when they complete. Do not `sleep`-poll in the foreground (it blocks your turn and hits limits). Instead, the moment you launch runs, **arm a harness-tracked watcher that exits on a completion signal — its exit re-invokes your session:**
- **Preferred: `Bash` with `run_in_background: true`** and an `until`-loop that exits when the durable completion signal appears. Runs write durable signals on progress/finish: a new `### ` heading in `execution/LEDGER.md`, a lane file's markers going terminal, or a new `*-REVIEW.md` report. Example: snapshot `base=$(grep -c '^### ' execution/LEDGER.md)`, then `while [ "$(grep -c '^### ' execution/LEDGER.md)" -le "$base" ]; do sleep 20; done; echo "ledger grew"` — exits and re-invokes you when a run posts its section. Give it a total time cap (e.g. `for i in $(seq 1 180)`) so a silently-dead run still wakes you to re-check via `execution.run.list`/`execution.run.wait`. Widen the exit condition to cover ALL completion shapes you're waiting on (per-lane marker counts, report files) — silence is not success (a dead run must still wake you via the timeout).
- **Alternative: `execution.run.wait`** blocks to terminal status and returns the result inline — but a long run can exceed the MCP client idle timeout (~1800s), which aborts the *wait call* (not the run). If you rely on it, raise the per-server `timeout` in the MCP config or `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`. The background-Bash watcher is more robust for multi-run fleets.
- After a watcher wakes you: triage what landed, verify claims in the worktree (never trust markers/ledger alone), then **re-arm the watcher** for whatever is still running. Repeat until the fleet is drained.

Resolve inputs with `action_options_resolve`: `execution.backends.enabled` (backend keys), and for the parent session (if spawning one) `sessions.spawn.machines.available` / `sessions.spawn.paths.recent`.

Parent session: runs need a `sessionId` to parent them. Use the current orchestrator session, or create ONE long-lived orchestrator session via `session.spawn_new` and hang all lane runs off it as sidechains.

Caveats (observed): a cold backend's FIRST run can take minutes to boot (CLI + ACP handshake) — give `execution.run.wait` a generous `timeoutSeconds` (600+) and don't read a timeout as failure; poll `execution.run.list` or the sidechain. If a run stays output-silent, check the target machine (there can be >1 — pick the one hosting the worktree) and that the backend is authed there. `session.spawn_new` remains valid only for a genuinely independent, persistent top-level session (e.g. a long-lived QA workspace driving the UI), never for routine lane delegation. Raw `codex exec` stays a fallback only if the MCP is unavailable in a headless/cron run.

## Connected services in execution runs (pick the account/pool a delegated run authenticates as)

A delegated/execution run inherits the runner's account by default. To bind a run to a specific
connected account or pool, pass `connectedServices` on the run-start surfaces
(`execution.run.start`, `subagents.delegate.start`, `subagents.plan.start`, `voice_agent.start`).
The field accepts a **simple string** (normalized to canonical bindings at the action boundary):

- `"openai-codex:group:<poolId>"` — bind to a pool/account-group. **Pools with autoSwitch enabled
  auto-rotate** the run past rate-limited members; prefer this to survive usage limits.
- `"openai-codex:<profileId>"` — pin to a single connected account (profile). No rotation.
- `"openai-codex:native"` — opt out; use the runner's inherited account.
- Omit the field — use the account's **configured default exactly as stored** (LITERAL): a profile
  default binds to that profile, a pool default binds to that pool. There is no silent profile→pool
  upgrade at resolution time. To rotate past rate limits, either set your stored default to a pool
  OR pass a pool selection (`"openai-codex:group:<poolId>"`) explicitly on the run.

You can also pass the full `{ v: 1, bindingsByServiceId: { ... } }` object, and on the fan-out
actions a per-target override `connectedServicesByBackendTargetKey` (e.g.
`{ "agent:codex": "openai-codex:group:happier" }`) that wins over the blanket `connectedServices`.

Enumerate valid selections (services, connected accounts, and pools with their autoSwitch status)
with `action_options_resolve` against the option source `execution.runs.connected_services.available`
(pass `backendTargetKey` / `agentId`, e.g. `"agent:codex"`). Malformed selections fail with a typed
`invalid_parameters` error naming the valid forms — they are never silently dropped. Prefer a healthy
account or an autoSwitch pool; if runs keep hitting limits, bind to the pool (group), not a lone
profile.

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
  files, ledger rows, codex session). Resume with context (SendMessage / `codex exec resume`)
  instead of restarting; only fresh-start when the transcript/session is genuinely gone.
- **Verify lane claims.** Reports referencing files that don't exist, "green" suites that are red
  at the lane's own commit, and inflated LOC deltas all happened. Reviewers rerun the tests
  themselves against the current source basis and attribute concurrent churn explicitly.
- **Adversarial review at composed boundaries.** Authors run `skills/attack-conclusion` while
  building. Independent review and `skills/verify-claims` target load-bearing delegated claims and
  the consumed vertical, corridor gate, or ship gate—not every microchange. After
  accepted fixes, review the finding delta unless the validated source, contract, scope, or risk changed
  materially. Author ≠ reviewer remains mandatory for corridor and ship gates.

## Validation doctrine

Use the active root `AGENTS.md` rules ("Risk-weighted execution" and "Testing: contract value, not test volume") plus `skills/happier-testing`; do not maintain a Claude-only copy or reread the root file when it is already in context.

## Plan execution and recovery

Use `skills/happier-implement-plan` for generic approved-plan execution, parallelism, dirty-worktree
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
