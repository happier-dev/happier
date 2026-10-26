# Claude Feature Matrix

This document captures the current low-level Claude implementation across the CLI, daemon, UI, direct-session plumbing, and QA surfaces. It is an internal inventory for architecture work, not end-user docs.

## Status legend

- `supported`: primary current path
- `partial`: shipped, but split across multiple paths or missing parity on one path
- `legacy`: still wired, but no longer the preferred path
- `unsupported`: intentionally absent today

## Runtime surfaces

| Feature | Status | Exact source files | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Remote Agent SDK path (default remote runtime) | `supported` | `apps/cli/src/backends/claude/remote/claudeRemoteDispatch.ts`, `apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.ts`, `apps/cli/src/backends/claude/claudeRemoteLauncher.ts`, `apps/cli/src/backends/claude/remote/sessionStartPlan.ts`, `packages/agents/src/providerSettings/definitions/claudeRemote.ts` | Preferred remote path when `claudeRemoteAgentSdkEnabled === true`; supports setting-sources v2, partial streaming, slash-command capability publication, optional checkpoint capture, and advanced option allowlisting. | Make this the single remote runtime surface and remove the auth-error-only fallback contract from `claudeRemoteDispatch.ts`. |
| Legacy remote shim | `legacy` | `apps/cli/src/backends/claude/claudeRemote.ts`, `apps/cli/src/backends/claude/sdk/query.ts`, `apps/cli/src/backends/claude/sdk/index.ts`, `apps/cli/src/backends/claude/sdk/stream.ts`, `apps/cli/src/backends/claude/remote/claudeRemoteDispatch.ts` | Older stream-json runner still works and is the remote fallback when Agent SDK startup fails with a Claude auth error before additional prompts are consumed. | Retire after Agent SDK reaches full parity for all remaining startup/session-info edge cases. |
| Local interactive / attach path | `supported` | `apps/cli/src/backends/claude/runClaude.ts`, `apps/cli/src/backends/claude/claudeLocalLauncher.ts`, `apps/cli/src/backends/claude/claudeLocal.ts`, `apps/cli/src/backends/claude/session.ts`, `packages/agents/src/manifest.ts` | Canonical local path is Claude's own TUI; attach is tmux-oriented and exclusive-topology in metadata/UI contracts; `runClaude.ts` also has a fast-start attach path for terminal-local resumes. | Collapse local launch, attach, and fast-start attach behind one provider local-control descriptor instead of branching in `runClaude.ts`. |
| Execution runs | `supported` | `apps/cli/src/backends/claude/executionRuns/executionRunBackendFactory.ts`, `apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts`, `apps/cli/src/backends/claude/executionRuns/resolveClaudeExecutionRunPermissionPolicy.ts`, `apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts`, `apps/cli/src/capabilities/registry/toolExecutionRuns.ts` | Claude execution runs use a separate SDK-backed class and a temporary `settings.json`. Development source preserves the user's normal cache/data/state environment instead of allocating per-run XDG roots. | Converge user sessions and execution runs on one Claude runtime adapter so steering, capabilities, and checkpoint/sidechain behavior share the same plumbing. |
| Persisted Happier transcript ingestion | `supported` | `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/claudeLocalLauncher.ts`, `apps/cli/src/backends/claude/claudeRemoteLauncher.ts`, `apps/cli/src/backends/claude/utils/sessionScanner.ts`, `apps/cli/src/backends/claude/utils/readClaudeSessionJsonlMessages.ts` | Local mode tails Claude JSONL files through `createSessionScanner`; remote mode forwards streamed SDK messages and still updates `claudeSessionId` / `claudeTranscriptPath` metadata when hooks reveal exact session info. | Normalize transcript provenance so local-scanned, remote-streamed, and imported history use one transcript-source envelope. |
| Linked direct transcript source (`.claude/projects/...jsonl`) | `supported` | `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/directSessions/listClaudeSessionCandidates.ts`, `apps/cli/src/backends/claude/directSessions/pageClaudeTranscript.ts`, `apps/cli/src/backends/claude/directSessions/readAfterClaudeTranscript.ts`, `apps/cli/src/backends/claude/directSessions/resolveClaudeDirectSessionFile.ts` | When transcript storage is `direct`, `session.ts` writes `directSessionV1`; browse/tail reads provider-owned JSONL directly and supports backward paging plus forward tail-follow. | Replace `directSessionV1` and Claude-specific file cursors with a shared transcript-source contract used by browse, takeover, and handoff. |
| Sidechains, subagents, and team inbox | `partial` | `apps/cli/src/backends/claude/remote/sidechains/claudeTaskOutputSidechainImporter.ts`, `apps/cli/src/backends/claude/remote/sidechains/claudeRemoteSubagentFileCollector.ts`, `apps/cli/src/backends/claude/remote/teamInbox/claudeRemoteTeamInboxBridge.ts`, `apps/cli/src/backends/claude/utils/teamInbox/claudeTeamInboxCollector.ts`, `apps/ui/sources/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants.ts`, `apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.tsx` | Remote mode has dedicated collectors for `Task` / `Agent` JSONL sidechains and team-inbox messages; UI then reconstructs team state, shutdown pruning, and run previews from normalized tool calls plus imported sidechain messages. | Centralize Claude sidechain/team normalization so CLI collectors and UI participant derivation stop re-encoding the same lifecycle rules. |

In development source, Direct takeover preserves the current native config
environment when the linked transcript store is the configured store, including
an unset `CLAUDE_CONFIG_DIR`. A resolved transcript path alone does not select
native credentials. Explicit native overrides retain their value, and links to a
different store retain their pinned root. Existing-state handoff and bundle import
use the same native environment-overlay owner for their target environment.
These rules do not recover the original authentication environment of older links.

In development source, the remote launcher records unexpected launch failures
in the normal session file log, including failures before the SDK subprocess or
its debug log exists. The entry includes redacted error text and the existing
error disposition; user cancellation and owned teardown remain debug-only.
Resume validation and provider identity preservation are unchanged.

Development-source session discovery accepts `SessionStart` hooks and eventless
SDK/offline discoveries. Other hook events, including `SessionEnd`, continue to
reach lifecycle handling but cannot replace the active Claude resume identity,
transcript path, or owned-session lineage during local/remote handoff.

Development-source transcript ingestion and UI normalization share
`providers.claude.isClaudeInternalEventType` from `@happier-dev/agents` for
non-conversation records, including Claude SDK `command_lifecycle` status events.
Raw runtime observers receive these records before transcript filtering; filtering
does not establish message acceptance or foreground activity. UI normalization also
filters already-persisted internal records, while genuinely unknown output retains
the unsupported-output diagnostic.

In development source, native cross-session messages use the shared
`attachments/claudePeerMessageProjection.ts` conversation projector. Delivered
queued-command attachments become sender-labelled text with native peer provenance;
ordinary queued commands and queue operations remain internal. The JSONL parser,
scanner, direct-session reader and SDK converter consume that projection. Peer input
cannot acknowledge a pending human prompt.

The remote Agent SDK registers its live permission-mode control with the launcher's
existing metadata consumer. Registration re-reads current permission intent, and
metadata updates reach the streaming query while idle. Prompt-driven updates and
ExitPlanMode use the same runtime-settings owner. Metadata callbacks apply only permission
controls; model and thinking controls are applied once per explicit queued prompt.
If a prompt's settings are refused, the runner reports the redacted provider error
and current model, rejects delivery before effect through the existing pending-queue
owner, and leaves the prompt available for an explicit retry. It does not send the
prompt on the previous model or retry model controls on metadata wakes. The shared
Claude effective-model observer owns both current-model and Running metadata;
remote and unified-terminal prompt acknowledgments establish input acceptance only.
In development source, remote model confirmation reads genuine main-session assistant
messages before presentation normalization. Startup announcements, historical replay,
sidechains, provider errors and synthesized presentation messages cannot confirm a
requested model. Launch effort is paired with the first genuine assistant observation
only; later model observations do not reapply the old launch effort. Native control
verification also clears effort observed for a different model, so an effort request
for the new model must be verified again. A submitted but unverified native command
also invalidates its command verification, so restoring the previous selection is
not skipped. Verified Ultracode and ordinary effort controls update the same native
effort witness.
Claude still owns inbound delivery
policy: its [non-interactive messaging contract](https://code.claude.com/docs/en/cross-session-messaging#non-interactive-sessions)
does not expose the terminal approval dialog in `-p` sessions. Happier does not
override that policy or automatically accept held messages.

## Session lifecycle surfaces

In development source, Claude background activity and workflow history share
`taskNotifications/claudeTaskLifecycleEnvelope.ts` for native transcript task
notifications, task-status attachments, peer handbacks, and successful resumed
invocations. Handbacks report delivery; they do not prove execution completed.
Actual terminal task notifications or status snapshots close the exact native
task. Async Agent acknowledgements correlate that native task ID with its
tool-use ID, including notifications that omit the tool-use ID. Lifecycle
notifications require native USER `origin.kind: task-notification`, or a
queued-command attachment with that origin or `commandMode: task-notification`.
Copied user XML and bare queue-operation text cannot settle tasks: Claude logs
ordinary queued prompts with the same queue shape. Trusted native outcomes can
arrive before the async acknowledgement while parent hooks await; the existing
native correlation record retains that outcome until the actual launch binds
its alias, and the runtime ledger keeps terminal-before-launch ordering. Transcript
normalization preserves native provenance instead of inventing it from copied
XML. Provider acceptance also excludes native notification rows, including those
without `isMeta`, so notification text cannot consume a matching queued user input.
Conversation projection uses that same native envelope reader for queued-command
attachments and Agent SDK `system/task_notification` events. Settled notifications
replace the original Agent launch acknowledgement through the existing tool-result
reducer. The presentation alias record retains task-ID-only notifications received
before their acknowledgement, and a successful native `SendMessage` resume clears
the old presentation alias before a subsequent invocation binds. This record maps
conversation identities; it does not decide runtime activity. New projected results
omit `isMeta` so existing readers can display them. Current readers also recover
already-persisted native notification tool results marked `isMeta`; ordinary meta
messages and copied user XML remain filtered or ordinary user content.
Imported child transcripts use the same projector with their explicit child scope.
Main-delivered results can target an unambiguous imported child; scoped results stay
within that child. The existing reducer updates the parent card and reuses its
orphan-result buffer when the child transcript arrives later. Permission-only
mirrors retain their synthetic provenance and cannot redirect a child result onto
an unrelated foreground call.
UserPromptSubmit text alone remains a provisional hint: Claude supplies the same
hook shape for notifications and ordinary prompts; actual transcript provenance
and outgoing prompt acceptance decide foreground work.

Authenticated `SubagentStart` reopens an exactly correlated background invocation
in both runtime activity and workflow history. Background classification comes
from the native async Agent/Workflow acknowledgement, including its authenticated
PostToolUse hook and exact tool-use ID; a generic local-agent task type alone
does not admit foreground children. A task ID remembered only from a terminal
outcome also does not prove prior background membership; a real async launch
acknowledgement establishes that membership while retaining its earlier outcome.
SDK native `task_started` for `local_agent` can also establish background membership
when its explicit `is_backgrounded` field is exactly `true`. Claude 2.1.291 emits
this field and SDK 0.2.123 preserves it in JSON despite omitting it from its type
declaration. Missing or false fields retain the existing known-only admission rule.
The shared native classification handles this fact for both workflow and runtime
activity, including nested SDK agents that outlive their launching agent.
`SubagentStop` is progress evidence
because Claude can veto that stop and continue working. Synchronous children
finish on their tool results; asynchronous children finish on the provider's
settled task evidence. Claude 2.1.302 reports an Agent `completed` each time it
stops, including when it stops to wait on backgrounded work it still owns (SDK
`task_started` rows carrying `parent_task_id`). That terminal leaves the Agent
awaiting its children (a child Agent that is itself awaiting its own children still
counts): the children keep their own activity, and only the Agent's
own typed SDK `task_progress` after it wakes reactivates it until its next
terminal. Hook `SubagentStop` progress cannot reactivate an awaiting Agent, so an
Agent that never wakes cannot hold runtime activity open. A later stop or failure
settles an awaiting Agent and prevents typed progress from reactivating it.
Confirmed TaskOutput hooks retain the task's terminal status, while confirmed
TaskStop hooks settle it as stopped. Neither remembers unknown task identities;
a completed TaskOutput preserves the pending wake.
Workflow correlation folds every tool block in a message,
keeps each child's native task alias, and closes an implicit Agent activity group
when all children settle. A successful native resume can reopen that group.
A successful SendMessage `resumedAgentId` proves an asynchronous invocation,
including when the original child ran in the foreground; it updates the same
native background classification used by authenticated start hooks.

In development source, a native failed SendMessage response that explicitly
reports a user-stopped child which cannot resume supplies cancelled task evidence.
The shared task-envelope reader handles this response for transcript and authenticated
hook delivery, and the existing activity ledger retires only that child. Ordinary
delivery failures and copied response text do not establish cancellation; the failed
SendMessage tool result remains part of the conversation.

Development-source workflow activity publication retries failed records with the
existing session-mutation backoff. Fresh progress, terminal observations and flushes
preserve each failed record's retry delay; healthy records can still publish, and
the delayed retry reads the latest snapshot. Permanent request refusals remain
observable failures rather than automatic retry loops.

Historical replay reconstructs workflow history without asserting current
activity. When a provider observer is lost, unresolved task identities remain
available for exact task operations, but their previous membership no longer
proves current activity. Fresh execution evidence reconfirms only the exact observed task;
report delivery alone cannot reconfirm a lost observer's activity.
Agent SDK known resumes reconstruct native correlation before the query starts
through the existing awaited transcript-history seed. Its raw observation reads
the full history in pages, while team and display results retain their bounded
tail. SDK resume streams do not replay old launch acknowledgements. The current
Session identity takes precedence over cached metadata for an explicitly adopted
resume target. Missing or incomplete required history reports the existing
runtime-loss/process-error outcome instead of inventing current activity.
Unified startup buffers retain the hook's original receipt time and deliver
subagent facts after reconstructing the transcript baseline. Under the existing
wall-clock convention, an older start cannot reopen a newer saved terminal;
equal or unavailable timestamps leave the exact invocation unobserved/unknown.
A fresh sibling remains observed. Millisecond ties, clock changes, and delayed
hook delivery do not establish an unconditional provider invocation order.
Startup reconciliation also resolves active orphan roster entries when their
parent run is already terminal or absent from the retained workflow headline.

Development-source Unified Terminal delivery keeps observing canonical Pending
eligibility while its submitted prompt awaits provider acceptance. External manual
handling can retire that exact row without another Claude hook or terminal output;
the existing arbiter then releases the submitted head and admits the next prompt
without resending the retired input or manufacturing provider acceptance. The API
session client owns exact custody reconciliation and publishes the same Pending
wake when local custody changes.

The development-source Agent SDK and legacy remote runners also require exact
native input acknowledgment before reporting acceptance. Their shared settlement
owner and failed-startup replay retention are described in
[Pending delivery](pending-delivery.md#ui-settlement-convergence-development).

In development source, Unified Terminal publishes its exact-host stop capability
as soon as the attachment is persisted, before metadata publication or provider
initialization can block. Explicit stop still destroys only that owned attachment;
stale attachment identities cannot destroy a replacement host.

In development source, the remote Agent SDK runner treats a live root
`message_start` from its owned session after a result as renewed foreground work.
This covers resume streams that emit a prior result before processing the supplied
prompt. The launcher starts the canonical turn and resets ready-notification
tracking, and the runner restores thinking and steering state until the next
result. Late deltas, replay, foreign-session messages, and child output alone do
not reopen the foreground turn.

Both remote runners use `remote/resultTurnBoundary.ts` to recognize a result with
a positive integer `queued_turn_count`. That result ends one provider turn while
another user turn remains queued, including after a nonfatal failed turn. The
runners retain foreground ownership and continue consuming provider output until
the terminal result; they preserve intermediate output and error diagnostics.
Results from older providers without this field retain their existing behavior.

Development-source SDK and local permission hooks share
`utils/buildClaudePermissionHookResponse.ts` for response serialization.
`PermissionRequest` approvals include `updatedInput` only when the arguments
actually change: Claude rechecks supplied replacement arguments against ask and
deny rules before applying `updatedPermissions`. Echoing the original arguments
can therefore refuse an approved operation and skip its saved allow rule.
Genuine rewrites remain subject to Claude's checks; `PreToolUse` still carries
the input needed for `AskUserQuestion` answers. Claude's Auto classifier remains
the permission authority before a request reaches these hooks.

| Feature | Status | Exact source files | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Direct session browse/list | `supported` | `apps/cli/src/backends/claude/directSessions/listClaudeSessionCandidates.ts`, `apps/ui/sources/agents/providers/claude/directSessions/resolveClaudeBrowseSourceOptions.ts`, `apps/ui/sources/agents/providers/claude/uiBehavior.tsx` | UI exposes only one Claude direct source today: `{ kind: 'claudeConfig' }`; discovery walks `~/.claude/projects/**.jsonl` and lazily reads session titles. | Promote direct-source selection into the same provider runtime record used by resume/takeover instead of a Claude-only browse option. |
| Direct transcript import / takeover -> persisted Happier session | `supported` | `apps/cli/src/api/directSessions/import/importDirectSessionTranscript.ts`, `apps/cli/src/api/directSessions/takeover/resolveDirectTakeoverSpawnOptions.ts`, `apps/cli/src/api/machine/rpcHandlers.directSessions.ts`, `apps/cli/src/backends/claude/directSessions/getClaudeDirectSessionWorkingDirectory.ts`, `apps/cli/src/backends/claude/directSessions/resolveClaudeConfigDir.ts` | Claude takeovers import the direct transcript into Happier storage, delete `directSessionV1`, write `externalHistoryImportV1`, and respawn the same Happier session in `persisted` mode with `resume=<claudeSessionId>` plus `CLAUDE_CONFIG_DIR`. | Treat takeover as a first-class source transition on one session record, not as import + metadata surgery + respawn. |
| Manual cross-machine handoff | `supported` | `apps/cli/src/backends/claude/handoff/exportClaudeSessionBundle.ts`, `apps/cli/src/backends/claude/handoff/importClaudeSessionBundle.ts`, `apps/cli/src/session/handoff/exportSessionHandoffProviderBundle.ts`, `apps/cli/src/session/handoff/importSessionHandoffProviderBundle.ts` | Claude handoff exports raw transcript JSONL as base64, rehydrates it under the target machine's Claude config dir, and returns both a direct source and a vendor-resume plan. | Fold transcript copy, direct-source metadata, and resume plan into one canonical provider handoff payload. |
| Local <-> remote switching and attach | `supported` | `apps/cli/src/backends/claude/claudeLocalLauncher.ts`, `apps/cli/src/backends/claude/claudeRemoteLauncher.ts`, `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/utils/ensureSessionInfoBeforeSwitch.ts`, `apps/cli/src/agent/localControl/createLocalRemoteModeController.ts` | Both launchers register `switch`/`abort` RPC handlers; switching waits for hook-derived session info before aborting so remote resumes the correct Claude session/transcript after local forks or compaction. | Keep one transport-neutral attach/switch controller and move Claude-specific session-id stabilization behind provider hooks only. |
| Permissions and approval routing | `supported` | `apps/cli/src/backends/claude/utils/permissionHandler.ts`, `apps/cli/src/backends/claude/localPermissions/localPermissionBridge.ts`, `apps/cli/src/backends/claude/utils/startHookServer.ts`, `apps/cli/src/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime.ts`, `apps/ui/sources/agents/providers/claude/core.ts` | Remote mode uses Happier-managed tool approval routing; local mode can surface the same permission prompts via the experimental local permission bridge, but the local subprocess still needs a restart for some spawn-time flag changes. | Converge local bridge and remote approval handling on one provider permission contract with explicit live-vs-next-spawn semantics. |
| Session controls: modes, settings sources, checkpoints, remote extras | `partial` | `packages/agents/src/providerSettings/definitions/claudeRemote.ts`, `apps/ui/sources/agents/providers/claude/settings/plugin.ts`, `apps/ui/sources/agents/providers/claude/core.ts`, `apps/cli/src/backends/claude/remote/claudeRemoteMetaState.ts`, `apps/cli/src/backends/claude/remote/resolveInitialClaudeRemoteMetaState.ts`, `apps/cli/src/backends/claude/remote/agentSdk/claudeAgentSdkSlashCommands.ts` | Claude exposes build/plan mode, remote setting sources (`claudeRemoteSettingSources` + `claudeRemoteSettingSourcesV2`), partial streaming, local permission bridge toggles, checkpoint capture, max-thinking override, TODO suppression, strict MCP, and advanced JSON allowlist; some controls are Agent-SDK-only. | Rename transport-branded / legacy settings into one controls schema and stop carrying both v1 and v2 setting-source formats. |
| Manual resume (`happier resume`, explicit `resume`, vendor `--resume`) | `supported` | `apps/cli/src/rpc/handlers/registerSessionHandlers.ts`, `apps/cli/src/backends/claude/runClaude.ts`, `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/claudeLocal.ts`, `packages/agents/src/manifest.ts`, `packages/agents/src/sessionControls/vendorResumePolicy.ts` | Claude is a first-class vendor-resume provider keyed by `claudeSessionId`; local runs consume one-time `--resume` / `--continue` flags after spawn, and `session.ts` rewrites metadata when Claude forks to a new vendor session id. | Keep a single provider resume record carrying vendor id, transcript path, and source affinity instead of scattering them across session metadata fields. |
| Wake resume / background wake | `supported` | `apps/ui/sources/agents/runtime/resumeCapabilities.ts`, `apps/ui/sources/agents/providers/claude/core.ts`, `apps/ui/sources/agents/registry/registryUiBehavior.ts`, `packages/agents/src/sessionControls/vendorResumePolicy.ts` | Claude uses the generic vendor-resume wake path; unlike Codex/OpenCode there is no Claude-specific `buildWakeResumeExtras` override, so wake relies on persisted metadata plus the generic resume capability contract. | Replace generic wake heuristics plus provider-specific metadata fields with a serialized provider runtime descriptor that wake can replay directly. |

Development source caches Claude provider-title state in the direct-session title
reader and scans appended records after validating the cached prefix. Manual
titles retain precedence over AI titles. Identical concurrent Claude candidate
listings share their filesystem scan; other agent listings retain their existing
request lifecycle. Handoff imports publish complete transcripts through
`atomicFileWrite`, replacing file identity so incremental readers invalidate
their previous state. A failed import leaves the previous transcript intact.

## Installables, auth, and coverage

| Feature | Status | Exact source files | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Provider installables / runtime acquisition | `partial` | `packages/agents/src/providers/providerCliRuntime.ts`, `apps/cli/src/backends/claude/daemon/spawnHooks.ts`, `apps/ui/sources/capabilities/installablesRegistry.ts`, `apps/docs/content/docs/providers/claude.mdx` | Claude is `system-first`, accepts JS-file overrides, and uses Anthropic's vendor install recipe; there is no Happier-managed binary package comparable to Codex. | Make install policy explicit in one provider runtime catalog: system-first vendor-recipe, not an implicit absence of `managedInstall`. |
| CLI auth detection and local login launch | `supported` | `apps/cli/src/backends/claude/cli/auth/claudeCliAuthSpec.ts`, `apps/cli/src/backends/claude/index.ts`, `apps/cli/src/backends/claude/cli/command.ts`, `apps/ui/sources/agents/providers/claude/settings/plugin.ts` | Auth detection prefers `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then `~/.claude/.credentials.json`; provider settings can launch Claude's login flow through Happier. | Move all provider auth probing and launch behavior behind one transport-neutral auth-status/launch contract. |
| Cloud connect and connected-services materialization | `supported` | `apps/cli/src/backends/claude/cloud/connect.ts`, `apps/cli/src/backends/claude/cloud/authenticateClaudeSubscriptionOauth.ts`, `apps/cli/src/backends/claude/connectedServices/materializeClaudeSubscriptionConnectedServiceAuth.ts`, `apps/cli/src/backends/claude/connectedServices/materializeClaudeConnectedServiceAuth.ts`, `apps/cli/src/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn.ts` | Claude supports `claude-subscription` setup-token or OAuth materialization plus plain Anthropic API keys; Anthropic OAuth is intentionally rejected for the raw `anthropic` service. Development source updates credentials in the existing account/pool home without replacing that home; private history and configuration survive refresh and missing or malformed old credential markers. | Keep account selection, switching and refresh with their existing owners; credential provenance must not decide whether durable private state is disposable. |
| Automated provider tests / probes | `supported` | `apps/cli/src/backends/claude/e2e/providerSpec.json`, `apps/cli/src/backends/claude/e2e/providerScenarios.json`, `apps/cli/src/backends/claude/claudeRemoteLauncher.integration.test.ts`, `apps/cli/src/backends/claude/claudeLocalLauncher.integration.test.ts`, `apps/cli/src/backends/claude/executionRuns/claudeSdkExecutionRunSidechain.integration.test.ts`, `packages/tests/suites/providers/claude.agentTeams.subagents.jsonl.realProbe.test.ts` | Coverage spans launcher/runtime tests, direct-session tests, execution-run sidechains, provider scenario catalog, and real Claude provider probes for agent teams/subagent JSONL behavior. | Reorganize around shared provider-capability fixtures so local, remote, execution-run, and team-sidechain coverage reuse the same contracts. |
| Manual QA trackers and UI validation surfaces | `supported` | `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_DETAILED_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_E2E_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_LIVE_TRACKER_2026-03-01.md`, `apps/ui/sources/components/sessions/runs/launcher/SessionExecutionRunLauncherView.tsx`, `apps/ui/sources/agents/providers/claude/sessionSubagents/ClaudeAgentLaunchActionsCard.tsx` | The March 2026 tracker set already audited Claude teams/swarms, participant routing, structured `participant_message.v1` rendering, and execution-run recipient behavior; those docs are the authoritative manual-QA evidence surface today. | Convert the tracker scenarios into a provider-agnostic QA checklist so Claude-specific manual evidence can map directly onto the future unified capability matrix. |

## Cross-cutting migration themes

1. Claude still has three materially different runtime shapes: local TUI, Agent SDK remote, and legacy remote shim. The unified architecture should make transport and control-plane differences internal, not user-visible.
2. Session identity is fragmented across `claudeSessionId`, `claudeTranscriptPath`, `directSessionV1`, and `externalHistoryImportV1`. Browse, wake, takeover, and handoff all reconstruct the same source tuple differently.
3. Claude subagent/team behavior is split between CLI-side collectors (`TaskOutput`, JSONL followers, team inbox) and UI-side participant derivation. Those lifecycle rules should live in one normalized sidechain model.
4. Execution runs already use Claude SDK semantics, but through a separate backend (`ClaudeSdkAgentBackend`) instead of the normal remote-session runtime. That is the clearest remaining duplication inside the Claude stack.
5. Claude provider settings still carry a migration seam of their own (`claudeRemoteSettingSources` legacy v1 plus `claudeRemoteSettingSourcesV2`). The future control plane should publish one settings schema and one live capability surface.

## Claude Code history attribution (development source)

`claudeCodeIncludeInNativeHistory` is an additive, account-scoped boolean, default false, owned by `packages/agents/src/providerSettings/definitions/claudeRemote.ts`. The existing outgoing-message metadata owner carries it to the CLI; absent or malformed input cannot enable it. Existing clients and CLIs ignore the additive key.

`resolveClaudeSessionEnvOverlay` extends the existing Claude launch overlay with explicit `CLAUDE_CODE_ENTRYPOINT=happier` when enabled. Local, legacy remote, Agent SDK, unified terminal, execution runs, cached startup metadata probes, and non-persisted preflight probes consume that owner. Metadata probe cache fingerprints include explicit attribution; off preserves existing cache keys. `prepareClaudeSubprocessEnv` in `spawn/buildClaudeSubprocessEnv.ts` removes inherited nested-session markers and restores only an explicit child entrypoint overlay. Generic daemon-runner sanitation remains unchanged. Queue mode hashes include this launch-time choice; already-running Claude processes and existing JSONL are not rewritten.

Evidence basis: official Agent SDK 0.2.123 defaults a missing entrypoint to `sdk-ts` and honors `options.env`; official VS Code extension 2.1.296 excludes `sdk-cli`, `sdk-ts`, and `sdk-py` by default and independently excludes daemon session kinds. Official native binaries 2.1.283 and 2.1.296 were executed against a local API fixture with isolated homes: `cli` became `sdk-cli` in JSONL, while `happier` was preserved. The custom value avoids the SDK history exclusion but also changes client-platform attribution, question-preview defaults and built-in agent availability; it is not a documented billing or quota control. Same configuration directory/project and other native history filters still apply. Full validation requires a newly launched authenticated daemon session followed by listing from the matching VS Code workspace; launch-boundary tests do not prove that live composed flow.
