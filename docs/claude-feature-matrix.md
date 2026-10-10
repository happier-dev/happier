# Archived: Claude Feature Matrix

> **Historical snapshot — not current implementation guidance.** This matrix predates the completed Agent/Provider vocabulary split and plugin-owned UI migration. Its `provider` terminology, removed `packages/agents/src/providerSettings/**` paths, and retired `apps/ui/sources/agents/providers/**` paths are preserved only to explain older migration decisions. Use [Agents catalog](./agents-catalog.md) for executable Agent ownership and [Providers](./providers.md) for model-source architecture.

The tables must not be used to locate current owners or plan new changes. Re-derive any historical claim from the current plugin contribution, Agent catalog, and Provider contracts before acting on it. The development lifecycle notes below describe current unreleased source; the tables remain historical.

## Status legend

- `supported`: primary current path
- `partial`: shipped, but split across multiple paths or missing parity on one path
- `legacy`: still wired, but no longer the preferred path
- `unsupported`: intentionally absent today

## Runtime surfaces

| Feature | Status | Current owner / source areas | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Remote Agent SDK path (default remote runtime) | `supported` | `packages/plugins/claude/src/agent/**`, `packages/agents/src/providerSettings/definitions/claudeRemote.ts` | Preferred remote path when `claudeRemoteAgentSdkEnabled === true`; supports setting-sources v2, partial streaming, slash-command capability publication, optional checkpoint capture, and advanced option allowlisting. | Make this the single remote runtime surface and remove the auth-error-only fallback contract from `claudeRemoteDispatch.ts`. |
| Legacy remote shim | `legacy` | `packages/plugins/claude/src/agent/**` | Older stream-json runner still works and is the remote fallback when Agent SDK startup fails with a Claude auth error before additional prompts are consumed. | Retire after Agent SDK reaches full parity for all remaining startup/session-info edge cases. |
| Local interactive / attach path | `supported` | `packages/plugins/claude/src/agent/**`, `packages/agents/src/manifest.ts` | Canonical local path is Claude's own TUI; attach is tmux-oriented and exclusive-topology in metadata/UI contracts; `runClaude.ts` also has a fast-start attach path for terminal-local resumes. | Collapse local launch, attach, and fast-start attach behind one provider local-control descriptor instead of branching in `runClaude.ts`. |
| Execution runs | `supported` | `packages/plugins/claude/src/agent/**`, `apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts`, `apps/cli/src/capabilities/registry/toolExecutionRuns.ts` | Claude execution runs already use an SDK-backed runtime, but it is a separate backend class with isolated `settings.json` and XDG roots rather than the normal remote-session launcher. | Converge user sessions and execution runs on one Claude runtime adapter so steering, capabilities, and checkpoint/sidechain behavior share the same plumbing. |
| Persisted Happier transcript ingestion | `supported` | `packages/plugins/claude/src/agent/**` | Local mode tails Claude JSONL files through `createSessionScanner`; remote mode forwards streamed SDK messages and still updates `claudeSessionId` / `claudeTranscriptPath` metadata when hooks reveal exact session info. | Normalize transcript provenance so local-scanned, remote-streamed, and imported history use one transcript-source envelope. |
| Linked direct transcript source (`.claude/projects/...jsonl`) | `supported` | `packages/plugins/claude/src/agent/**` | When transcript storage is `direct`, `session.ts` writes `directSessionV1`; browse/tail reads provider-owned JSONL directly and supports backward paging plus forward tail-follow. | Replace `directSessionV1` and Claude-specific file cursors with a shared transcript-source contract used by browse, takeover, and handoff. |
| Sidechains, subagents, and team inbox | `partial` | `packages/plugins/claude/src/agent/**`, `apps/ui/sources/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants.ts`, `apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.tsx` | Remote mode has dedicated collectors for `Task` / `Agent` JSONL sidechains and team-inbox messages; UI then reconstructs team state, shutdown pruning, and run previews from normalized tool calls plus imported sidechain messages. | Centralize Claude sidechain/team normalization so CLI collectors and UI participant derivation stop re-encoding the same lifecycle rules. |

In development source, native cross-session delivery is classified by
`packages/plugins/claude/src/agent/transcripts/nativeSemanticProjection.ts`.
Direct history, the Unified transcript source and remote SDK output share
sender-labelled ACP text. Ordinary queue operations and copied human wrappers
remain internal or human input. Native peer input cannot accept a queued human
prompt or start a human turn.

The remote SDK runtime applies permission configuration changes to its live
queries through the existing native control transport. Normal sessions permit
runtime permission switching at launch; an explicit tool permission policy
remains authoritative. Claude still owns inbound delivery policy: its
[non-interactive messaging contract](https://code.claude.com/docs/en/cross-session-messaging#non-interactive-sessions)
does not expose the terminal approval dialog in `-p` sessions. Happier does not
override that policy or automatically accept held messages.

## Session lifecycle surfaces

In development source, Claude background activity and workflow history share
`packages/plugins/claude/src/agent/transcripts/taskNotification.ts` for native
execution facts. Handbacks report delivery; they do not prove settlement.
Lifecycle notifications require USER `origin.kind: task-notification`, or a
queued-command attachment with that origin or `commandMode: task-notification`.
Copied user XML and bare queue-operation text cannot settle tasks. Normalization
preserves native provenance; native notification text cannot accept a matching
queued human prompt, including when the native row has no `isMeta` field.

Current development conversation projection consumes the same native envelope
reader. The ordered Unified source observer publishes a trusted terminal result
once; its initial replay seeds correlation without emitting fresh results. SDK
conversion uses the same presentation correlation record for exact task/tool
identity, terminal-before-ACK delivery, and typed task-start identity. Successful
native SendMessage resume clears obsolete presentation aliases. Projected results
use the existing nonmeta tool-result shape; session-core also accepts previously
persisted native-origin meta tool results. Copied XML remains ordinary user text.

SDK child messages retain their exact parent tool-use identity through existing
session-scoped output. A root task-ID notification can therefore settle its
imported nested call. The generic reducer resolves explicit child scope and
requires a unique owner for an unscoped result, then republishes the parent child
projection. Permission-only mirrors remain distinct from foreground calls.
The current Unified runtime does not import separate child JSONL files; the
archived collector tables below describe the older implementation.

Claude 2.1.291 emits an explicit `is_backgrounded` field on native local-agent
starts, and SDK 0.2.123 retains it in its JSON transport. Exact true admits work
through the existing task admission owner; missing or false remains known-only.
The SDK loop publishes the final child tool result before retiring observation
when the last background task settles after the parent result. Native failed and
stopped/cancelled outcomes retain their outcome through conversation and roster
projection. These are development-source corrections, not release certification.

Async acknowledgements link the exact native task ID to its tool-use ID. Trusted
outcomes can arrive before that acknowledgement while parent hooks await; the
existing native correlation record retains the outcome until its alias binds.
Authenticated `SubagentStart` reopens a known background invocation. A terminal
identity alone does not prove background membership. Async Agent/Workflow
acknowledgements prove membership; successful SendMessage `resumedAgentId` proves
an asynchronous resume even when the original child was foreground.
`SubagentStop` is progress because Claude can veto it and continue. Synchronous
children finish on their tool results; asynchronous children finish on settled
native evidence. Every tool block is folded and an implicit group closes when
its children settle. Failed results retain failure, including tagged tool errors.

Historical observations reconstruct correlation without fresh activity admission
or foreground prompt acceptance. Ordered source import retains raw child facts
from discarded display branches; branch selection remains a presentation concern.
SDK and Unified startup bind the existing ordered source baseline before draining
captured native Start receipts. Current ordered imports inherit display-history
budgets; complete historical correlation beyond these budgets and through oversized
rows is not yet validated. If required SDK or Unified ordered history cannot be
imported, Activity becomes unknown before the original admission error is reported.
Unified uses its existing observation-loss owner and publishes the updated inventory
for hook attachment, known-session resume, and status-line binding failures. Under the existing wall-clock convention, older
receipts cannot reopen newer saved terminals; equal or unavailable ordering keeps
the exact invocation unobserved/unknown. A fresh sibling remains observed. Clock
changes, millisecond ties, and delayed delivery do not establish a total native
invocation order.

Observer loss retains unresolved task identities for exact task operations while
clearing their observed activity. Fresh execution evidence reconfirms the exact
identity; report delivery cannot do so. Startup reconciliation resolves active
orphan roster entries when their parent is terminal or absent from the retained
headline, preserving titles and sidechains. No expiry timer or second lifecycle
inventory is used.

In development source, the Claude terminal provider operations retain the exact host handle immediately after the host service persists and returns its attachment. The existing session-close disposal operation can destroy that owned host while initial readiness is still pending; it does not depend on a provider-ready callback. The host service enforces attachment identity before destruction.

| Feature | Status | Current owner / source areas | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Direct session browse/list | `supported` | `packages/plugins/claude/src/agent/**`, `apps/ui/sources/agents/providers/claude/directSessions/resolveClaudeBrowseSourceOptions.ts`, `apps/ui/sources/agents/providers/claude/uiBehavior.tsx` | UI exposes only one Claude direct source today: `{ kind: 'claudeConfig' }`; discovery walks `~/.claude/projects/**.jsonl` and lazily reads session titles. | Promote direct-source selection into the same provider runtime record used by resume/takeover instead of a Claude-only browse option. |
| Direct transcript import / takeover -> persisted Happier session | `supported` | `apps/cli/src/api/directSessions/import/importDirectSessionTranscript.ts`, `apps/cli/src/api/session/external/takeover/resolveExternalTakeoverSpawnOptions.ts`, `apps/cli/src/api/machine/rpcHandlers.directSessions.ts`, `packages/plugins/claude/src/agent/**` | Claude takeovers import the direct transcript into Happier storage, delete `directSessionV1`, write `externalHistoryImportV1`, and respawn the same Happier session in `persisted` mode with `resume=<claudeSessionId>` plus `CLAUDE_CONFIG_DIR`. | Treat takeover as a first-class source transition on one session record, not as import + metadata surgery + respawn. |
| Manual cross-machine handoff | `supported` | `packages/plugins/claude/src/agent/**`, `apps/cli/src/session/handoff/exportSessionHandoffProviderBundle.ts`, `apps/cli/src/session/handoff/importSessionHandoffProviderBundle.ts` | Claude handoff exports raw transcript JSONL as base64, rehydrates it under the target machine's Claude config dir, and returns both a direct source and a vendor-resume plan. | Fold transcript copy, direct-source metadata, and resume plan into one canonical provider handoff payload. |
| Local <-> remote switching and attach | `supported` | `packages/plugins/claude/src/agent/**`, `apps/cli/src/agent/localControl/createLocalRemoteModeController.ts` | Both launchers register `switch`/`abort` RPC handlers; switching waits for hook-derived session info before aborting so remote resumes the correct Claude session/transcript after local forks or compaction. | Keep one transport-neutral attach/switch controller and move Claude-specific session-id stabilization behind provider hooks only. |
| Permissions and approval routing | `supported` | `packages/plugins/claude/src/agent/**`, `apps/ui/sources/agents/providers/claude/core.ts` | Remote mode uses Happier-managed tool approval routing; local mode can surface the same permission prompts via the experimental local permission bridge, but the local subprocess still needs a restart for some spawn-time flag changes. | Converge local bridge and remote approval handling on one provider permission contract with explicit live-vs-next-spawn semantics. |
| Session controls: modes, settings sources, checkpoints, remote extras | `partial` | `packages/agents/src/providerSettings/definitions/claudeRemote.ts`, `apps/ui/sources/agents/providers/claude/settings/plugin.ts`, `apps/ui/sources/agents/providers/claude/core.ts`, `packages/plugins/claude/src/agent/**` | Claude exposes build/plan mode, remote setting sources (`claudeRemoteSettingSources` + `claudeRemoteSettingSourcesV2`), partial streaming, local permission bridge toggles, checkpoint capture, max-thinking override, TODO suppression, strict MCP, and advanced JSON allowlist; some controls are Agent-SDK-only. | Rename transport-branded / legacy settings into one controls schema and stop carrying both v1 and v2 setting-source formats. |
| Manual resume (`happier resume`, explicit `resume`, vendor `--resume`) | `supported` | `apps/cli/src/rpc/handlers/registerSessionHandlers.ts`, `packages/plugins/claude/src/agent/**`, `packages/agents/src/manifest.ts`, `packages/agents/src/session/controls/vendorResumePolicy.ts` | Claude is a first-class vendor-resume provider keyed by `claudeSessionId`; local runs consume one-time `--resume` / `--continue` flags after spawn, and `session.ts` rewrites metadata when Claude forks to a new vendor session id. | Keep a single provider resume record carrying vendor id, transcript path, and source affinity instead of scattering them across session metadata fields. |
| Wake resume / background wake | `supported` | `apps/ui/sources/agents/runtime/resumeCapabilities.ts`, `apps/ui/sources/agents/providers/claude/core.ts`, `apps/ui/sources/agents/registry/registryUiBehavior.ts`, `packages/agents/src/session/controls/vendorResumePolicy.ts` | Claude uses the generic vendor-resume wake path; unlike Codex/OpenCode there is no Claude-specific `buildWakeResumeExtras` override, so wake relies on persisted metadata plus the generic resume capability contract. | Replace generic wake heuristics plus provider-specific metadata fields with a serialized provider runtime descriptor that wake can replay directly. |

## Installables, auth, and coverage

| Feature | Status | Current owner / source areas | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Provider installables / runtime acquisition | `partial` | `packages/agents/src/cli/runtime.ts`, `packages/plugins/claude/src/agent/**`, `apps/ui/sources/capabilities/installablesRegistry.ts`, `apps/docs/content/docs/providers/claude.mdx` | Claude is `system-first`, accepts JS-file overrides, and uses Anthropic's vendor install recipe; there is no Happier-managed binary package comparable to Codex. | Make install policy explicit in one provider runtime catalog: system-first vendor-recipe, not an implicit absence of `managedInstall`. |
| CLI auth detection and local login launch | `supported` | `packages/plugins/claude/src/agent/**`, `apps/ui/sources/agents/providers/claude/settings/plugin.ts` | Auth detection prefers `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then `~/.claude/.credentials.json`; provider settings can launch Claude's login flow through Happier. | Move all provider auth probing and launch behavior behind one transport-neutral auth-status/launch contract. |
| Cloud connect and connected-services materialization | `supported` | `packages/plugins/claude/src/agent/**`, `apps/cli/src/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn.ts` | Claude supports `claude-subscription` setup-token or OAuth materialization plus plain Anthropic API keys; Anthropic OAuth is intentionally rejected for the raw `anthropic` service. | Normalize Claude auth materialization as a declared env contract so runtime spawn, cloud connect, and connected-services stop looking like separate auth systems. |
| Automated provider tests / probes | `supported` | `packages/plugins/claude/src/agent/**`, `packages/tests/suites/agents/claude.agentTeams.subagents.jsonl.realProbe.test.ts` | Coverage spans launcher/runtime tests, direct-session tests, execution-run sidechains, provider scenario catalog, and real Claude provider probes for agent teams/subagent JSONL behavior. | Reorganize around shared provider-capability fixtures so local, remote, execution-run, and team-sidechain coverage reuse the same contracts. |
| Manual QA trackers and UI validation surfaces | `supported` | `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_DETAILED_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_E2E_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_LIVE_TRACKER_2026-03-01.md`, `apps/ui/sources/components/sessions/runs/launcher/SessionExecutionRunLauncherView.tsx`, `apps/ui/sources/agents/providers/claude/sessionSubagents/ClaudeAgentLaunchActionsCard.tsx` | The March 2026 tracker set already audited Claude teams/swarms, participant routing, structured `participant_message.v1` rendering, and execution-run recipient behavior; those docs are the authoritative manual-QA evidence surface today. | Convert the tracker scenarios into a provider-agnostic QA checklist so Claude-specific manual evidence can map directly onto the future unified capability matrix. |

## Cross-cutting migration themes

1. Claude still has three materially different runtime shapes: local TUI, Agent SDK remote, and legacy remote shim. The unified architecture should make transport and control-plane differences internal, not user-visible.
2. Session identity is fragmented across `claudeSessionId`, `claudeTranscriptPath`, `directSessionV1`, and `externalHistoryImportV1`. Browse, wake, takeover, and handoff all reconstruct the same source tuple differently.
3. Claude subagent/team behavior is split between CLI-side collectors (`TaskOutput`, JSONL followers, team inbox) and UI-side participant derivation. Those lifecycle rules should live in one normalized sidechain model.
4. Execution runs already use Claude SDK semantics, but through a separate backend (`ClaudeSdkAgentBackend`) instead of the normal remote-session runtime. That is the clearest remaining duplication inside the Claude stack.
5. Claude provider settings still carry a migration seam of their own (`claudeRemoteSettingSources` legacy v1 plus `claudeRemoteSettingSourcesV2`). The future control plane should publish one settings schema and one live capability surface.
