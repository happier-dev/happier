VERDICT: Implemented locally; targeted RED→GREEN and entry loads 7/7. Partial commit only: owner-result speech is coherent; the Local playback continuation commit is [blocked] by uncommitted SDK/handler producers. Loaded replay remains owed; reload the UI, do not restart a stack.

Lane: VOICE-SPOKEN-SETTING-1101, 2026-11-01. Development source, not released availability.

Observed defect basis: `HANDOFF-OTHER-PROGRAMS.md`, exact 14:18 UTC RUN62D heading; `evidence/final62d/restart83-row17-{exact-answer,request-outcome,pending-check}.json` and `restart83-row3-stable-answer.json` under this program. Speech claimed Balanced; independent read stayed Short; request 55bdfdd8 remained open.

Derived cause, falsified through the real composed path: Local's tool-result callback played the host summary and armed a binding, then depended on a second model tool call to consume it. The shared `executeSpokenAction` already owns playback → captured invocation continuation, but Local did not supply its `playHostText` capability. Separately, Local streamed/finalized model completion prose even when the settings owner refused a value.

Changes and canonical owners:
- `apps/ui/sources/voice/local/sendVoiceTextTurn.ts:462` supplies existing host speech playback to the shared dispatcher; removes Local's separate binding-completion path.
- `apps/ui/sources/voice/local/runVoiceAgentTurnWithTools.ts:182` forwards that capability. Settings-write and approval-decision completion speech comes from the typed result projection, including refusal/pending outcomes, rather than action-bearing or follow-up model prose.
- `apps/ui/sources/voice/context/spokenActionOutcome.ts` projects canonical settings output and approval statuses. The existing `resolveVoiceToolResultHumanSummary` consumes the same projection; direct tools and `action_execute` share it.
- The unchanged `executeSpokenAction` → confirmed front door → settings/approval executors retain sole execution authority and `voice.canApproveRequests`. No tap is added. Realtime already uses this capability; Local now consumes it. Current-UI overrides already forward the capability; no parallel decision owner was added there.
- `docs/actions.md` documents shared continuation and owner-result completion. Direct-session transport, native vendor playback and wire/persistence formats are unchanged by this lane.

Evidence actually run through `./apps/stack/bin/hstack-exec`; logs in `.project/tmp/voice-spoken-setting-1101/`:
- `red.log`: composed setting and existing-request regressions both failed, fresh value Short instead of Balanced. The provider never repeated a confirmation call.
- `grounding-red.log`: playback wiring fixed execution; all three setting/approval/refusal cases still spoke the provider's unsupported success claim.
- `pending-red.log`: flattened created-approval result was not reported Pending; fixed transport metadata projection before parsing the owner's schema.
- `target-final.log`: exit 0, 13 passed / 40 intentionally unselected. Both requested paths, invalid-setting refusal, direct/enveloped pending results, unrelated model speech, completed playback, barge-in, End, no-start and playback error.
- The settings assertion performs a fresh real `settings_get`; existing approval asserts stored `executed`, `decidedVia: voice`, execution success and saved Balanced. Tests retain real internal owners; HTTP, daemon RPC and OS speech are boundaries.
- `summary-final.log`: exit 0, 31/31 human-summary tests passed on final source, including both pending transport shapes. The dispatch wrapper recovered a transient remote sync staging error before running the suite.
- `entry-loads.log`: all seven graphs passed: entry preparation, daemon, CLI, Voice inference worker, server, UI catalog, SDK browser. Exit 0.
- `focused.log`: broader eight-file run ended 117 passed / 31 failed. Twenty fail in binding admission before the changed tool loop; six concern direct-session Resume/delivery; five concern approval-origin/result expectations and internal Artifact access. Those failures remain open; no whole-suite green or clean-baseline attribution is claimed. The new regressions and all playback controls passed in this run.
- `git diff --check` passed on all touched tracked source/tests/docs. Shared UI package typecheck was not duplicated, per the 10-31 lane-closeout owner ruling; no package-green claim.

Commit disposition:
- Private-index own-hunk candidate `de234b55dc9377df1907e6e9336491c7c62a2fee` against `abda6407010fcd5bbd25e8a5e137b84b5a20c4a8` failed `checkCommitTypeCoherence.mjs`: missing public `VoiceHostTextPlayback` export and its two dependent callback implicit types. See `commit-coherence-final.log`.
- [blocked] Commit of the Local continuation and composed regression changes: the native/spoken-confirm owners must first commit their existing SDK playback export and handler/shared-dispatch producer. These bytes already exist in the worktree and were not authored or staged by this lane. Do not import their whole dirty files into this commit.
- `grounding-coherence.log`: exit 0, `COHERENT`, zero new diagnostics for the independent four-code-file tree. The requested Markdown report adds no compiler input.
- The independent owner-result speech packet uses a private index, current machine identity, type-coherence check and HEAD compare-and-swap. Other staged paths are unrelated and remain untouched. No push.
- Own pre-edit baselines and selected patch preparation are outside the repository at `/tmp/voice-spoken-setting-1101-blta6zvk/`; source and deciding logs above are the durable result.

Self-simplification: removed the competing Local binding-completion path and model-delivered confirmation requirement. Pending transport metadata handling was the additional reproduced correction. No new authority rechecks, settings, persistence, gates, queues, limits or polling.
Net mechanisms across the local change: output-schema projections +3/−0 (saved setting, created approval, decision); presentation routing +1/−0 (reproduced false success); presentation states +2/−0; Local completion owners +0/−1; error codes/timers/retries +0/−0; files +2/−0 (one production helper and this requested report).

Residual risk / next action: reload the existing UI bundle and replay both exact requests on restart83 with Local Codex. Verify fresh Balanced and closure of the existing request after the host read-back; then exercise setting-off tap and barge-in. This lane ran no loaded browser/device replay and changed no stack lifecycle. Native audio/vendor completion remains the native lane's evidence obligation. Commit the continuation after its producer dependency lands; the broader failing tests remain integration work.
