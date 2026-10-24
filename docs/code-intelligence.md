# Code intelligence

Code intelligence is a daemon-local observer: it notices coding-agent sessions and git activity on one machine, records them in a local store, optionally sends a bounded, redacted diff of each new commit to a model the user configures, and serves the result to clients over daemon RPC.

Status: **experimental, opt-in**. The client feature gate is `codeIntelligence` (`packages/protocol/src/features/catalog.ts`, `representation: 'client'`, UI toggle default off). The daemon worker additionally stays inert until the user turns observation on for that machine (`settings.codeIntelligence.enabled`, default `false`).

## Canonical owners

| Concern | Owner |
| --- | --- |
| Wire and settings contracts | `packages/protocol/src/codeIntelligence/**`, RPC names in `packages/protocol/src/rpc.ts` (`daemon.codeIntelligence.*`) |
| Lifecycle (start, stop, enable/disable, watchers, cadence, retention) | `apps/cli/src/daemon/codeIntelligence/codeIntelligenceWorker.ts`, composed with real boundaries in `startDaemonCodeIntelligenceWorker.ts` and started/stopped by `startDaemon.ts` |
| Persistence (single writer) | `apps/cli/src/daemon/codeIntelligence/store/codeIntelligenceStore.ts` — SQLite WAL at `<activeServerDir>/code-intelligence/code-intelligence.sqlite` |
| Repository and worktree identity | `observedGit.ts#resolveObservedCheckout`, built on `scm/backends/git/checkoutIdentity.ts`; `repositoryId` hashes the canonical git common dir, so linked worktrees share one repository |
| Commit observation | `commits/observeCheckout.ts` + `commits/buildCommitObservation.ts` |
| Changed symbols | `symbols/declarationScan.ts` + `symbols/detectChangedSymbols.ts` |
| External session discovery | the existing direct-sessions provider ops (`apps/cli/src/backends/*/directSessions/providerOps.ts`), swept by `sessions/sweepExternalSessions.ts` |
| Remote analysis admission and routing | `analysis/selectAnalysisRoute.ts` (the only place that decides whether a request may be sent and to whom) |
| Settings persistence and API keys | `apps/cli/src/settings/codeIntelligenceSettings.ts`; keys are sealed with the settings secrets key (`sealSecretsDeepV1`) and opened only per request |
| Client | `apps/ui/sources/components/codeIntelligence/**`, `apps/ui/sources/sync/domains/codeIntelligence/**`, route `/intelligence` |

There is no second event store, lifecycle manager or provider registry. Discovery of sessions started outside Happier reuses direct sessions; observation never grants control — taking a session over remains the direct-sessions takeover flow.

## Data flow

1. **Sessions.** Every sweep (30 s) lists the newest candidates (20 per provider, last 24 h) from each provider that declares `passiveObservationSource` — currently Claude Code and Codex — with `searchMode: 'fast'`, which reads only the provider's own files (for Codex: rollouts, never an app-server). OpenCode does not declare a source, because listing its sessions without an explicit server URL can start a managed OpenCode server. Status comes from the direct-sessions activity owner; live provider processes (`matchesProviderProcess`, cross-platform patterns ported from AgentMonitor, matched on the executable and an interpreter's script only) strengthen recent activity to `running` only when there are at least as many of them as recently written sessions, and never wake an idle session. Sessions that drop out of a successful listing settle to their timestamp-derived status; a provider whose listing fails keeps its sessions as they were. Unresolved working directories are retried on later sweeps.
2. **Repositories.** A session's working directory (provider-owned `getWorkingDirectory`) or a manually registered path resolves to repository + worktree. A path registered over RPC is authorized with the machine RPC filesystem access policy (`authorizeFilesystemPath`, the same policy as the file browser and terminal) and rejected with `path_not_allowed` outside it. Session working directories go through the same policy before git runs in them, and every resolved worktree and git common dir must be inside it too. The first observation of a worktree is a baseline: history is never back-filled.
3. **Commits.** A worktree's HEAD checkpoint advances only after every commit it covers is recorded; a git read that fails part-way is retried on the next observation, and a repository registered before its first commit records that commit as a root commit. Each worktree's reflog directory (`<git-dir>/logs`) is watched; changes are debounced (750 ms) and reconciled through one serialized work chain. The periodic sweep re-reads every known worktree as a backstop for dropped watch events. New commits are those reachable from the new HEAD and not from the previous one (`git rev-list new ^old`), so fast-forwards, merges and rebases are covered and a branch pointer moving onto an existing commit observes nothing. Commits are keyed by `(repositoryId, sha)`. At most 50 commits are observed per ref update; the omitted count is put on the event.
4. **Facts.** Per commit: changed files (`diff-tree -M -z`, first parent for merges), changed symbols (declaration scan over the old/new blob and zero-context hunks, at most 40 files, 512 KiB each), and textual impact (`git grep -w` at the commit for modified/deleted symbols ≥ 4 characters, at most 15 symbols × 10 files). All git commands run with `GIT_OPTIONAL_LOCKS=0`, so observation never contends with an agent's index lock.
5. **Analysis.** New commits enter `queued`. Admission happens before any diff is read: remote analysis must be globally enabled and the repository explicitly allowed. The prompt holds the commit subject, structural facts and up to 48 KiB (UTF-8) of per-file diffs; no further diffs are read once the budget is spent. Excluded paths (dependency/build trees, lockfiles, `.env`/key files, configured prefixes where `*`, `**` and `?` act as globs) are omitted — for a rename, when either side is excluded — and likely secrets are redacted. Every completed paid exchange is charged, with the full output allowance when the provider reports no usage, and paid admission estimates input tokens by UTF-8 bytes. Output must validate against the finding schema; every finding is stored as `suspected`.
6. **Clients.** `daemon.codeIntelligence.snapshot.get` returns repositories, sessions, recent commits and events. Without `afterSeq` it returns the newest events; with it, the events after it. `latestSeq` is the resume cursor (the last event returned), so paging never skips events. `eventsTruncated` tells a client its cursor fell behind retention and it must replace its state. The screen asks for the delta every 5 s while focused and visible.

## Remote analysis policy

- Billing class is user-declared per configured model (`free`, `subscription`, `paid`; undeclared means `paid`). Nothing is inferred from a provider's name.
- `free_only` (default) admits only `free`; `free_and_subscription` adds `subscription` (for example OpenCode Go, a paid plan); `lowest_cost` and `manual` may also admit `paid`.
- A `paid` model is admitted only with `allowPaid`, declared prices, and remaining monthly budget for the worst case of the request (`maxOutputTokens` at declared prices). Spend is recorded per request in the store.
- Fallback walks only the admitted candidate list, so it can never reach a model the policy did not already admit.
- `429` honours `Retry-After` (seconds or HTTP date); unavailability without an instruction backs off exponentially (30 s doubling, capped at 1 h). When every admitted provider is unavailable, the commit stays `queued` with `retryAfterMs`; other failures are `failed` with a reason. Manual "review again" resets the schedule but uses the same admission.
- Only the chat-completions protocol is spoken. Default endpoints: Groq `https://api.groq.com/openai/v1`, OpenRouter `https://openrouter.ai/api/v1`, OpenCode Zen `https://opencode.ai/inference/openai/v1`, OpenCode Go `https://opencode.ai/inference/go/openai/v1` (checked 2026-10). Models those services expose only through `responses`/`messages`/Google endpoints are not usable here.

## Bounds

Stopping the worker waits at most 2 s for the current unit of work so a remote request cannot hold daemon shutdown; an analysis interrupted that way is re-queued (`reason: interrupted`) when the worker next starts.

Every limit above protects a named resource: provider store reads per sweep, git processes per commit, feed size, remote prompt size/cost, and store size. Retention (`retentionDays`, default 30) prunes events, commits and sessions every 6 h. The UI keeps at most 500 feed events in memory and renders the newest 40 events and 20 commits; the store keeps the rest.

## Decisions

- **AgentMonitor (`jiweiyeah/AgentMonitor`, MIT).** Its Rust adapters for Claude, Codex, OpenCode and Gemini re-implement session discovery that Happier already owns in TypeScript (direct sessions). Shipping them would create a second, divergent discovery owner and a new cross-platform native helper in the daemon's binary-safe packaging. Only the cross-platform process-recognition patterns were ported, into the direct-sessions provider leaves, with attribution in `apps/cli/src/backends/directSessions/processMatch.ts`. A Rust sidecar remains an option for capabilities TypeScript cannot reach (for example per-process working directories on Windows); it needs an explicit packaging decision first.
- **Symbol extraction** is a deterministic declaration scan labelled `declaration_scan`, not a parser. It is silent rather than inventive for code it cannot recognise. Replacing it with a Tree-sitter-backed scanner is a change inside `symbols/**`; callers and the wire contract do not change.
- **Commit attribution.** `plausibleSessionIds` lists sessions active in the same worktree when the commit was observed. It is a hint, never authorship.

## Feature-gap matrix (against the "coding intelligence platform" brief)

| Capability | Status |
| --- | --- |
| External Claude Code / Codex session discovery, repository + worktree association, read-only | Implemented |
| OpenCode / Gemini passive discovery | Not implemented (OpenCode listing can start a server; Gemini has no direct-sessions provider ops) |
| Background operation with the window closed, restart recovery, dedupe | Implemented in the daemon; events and analyses persist across daemon and client restarts |
| Commit detection across worktrees, merges, rebases; branch switch events | Implemented |
| Changed symbols and textual impact | Implemented (declaration scan) |
| Persistent structural knowledge graph (CALLS/IMPORTS/TESTS edges, graph queries, explorer UI) | Not implemented |
| Remote commit review with free-only routing, budgets, Retry-After, redaction, validated findings | Implemented for chat-completions endpoints; UI setup covers Groq only |
| Provider model discovery, health checks, latency/usage dashboard | Not implemented |
| Lifeguard deep review, verification, repair worktrees, agent delegation | Not implemented |
| Worktree task graph, conflict detection across agents | Not implemented |
| Tray summary, notifications for findings | Not implemented |
| Fluent UI desktop dashboard, graph explorer | Not implemented; the screen uses Happier's shared primitives |
