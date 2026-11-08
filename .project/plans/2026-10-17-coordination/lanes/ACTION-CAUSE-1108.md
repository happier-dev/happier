# ACTION-CAUSE-1108

Implemented all four source corrections; focused tests and entry-loads 7/7 pass. [blocked] Generated CLI help publication waits on another operation's live lock; broader adjacent tests failed as recorded below. No stack lifecycle action or push.

## Delivered behavior

- Session Account Action catch: unknown exceptions return `internal_error` with the canonical secret-free `failureCause`; explicit target refusals and carried envelopes remain intact. Logs contain Action id and projected class/code/status, never exception prose.
- Compact Doc proposal: resolve the existing thread-anchored input through `prepareDocEditProposalInputV1` before signing and deriving child-publication metadata. The resolved passage/revision is retained through approval; the executor does not read the root again.
- Discovery: existing `doc.edit.propose` description now matches “suggest a rewrite of this passage” and explains `threadRef` → `discussionRef`, `docRef` → `doc.read`, replacement text and optional reason. Existing thread context already supplies those references.
- Draft decline: the real Home review-reply transport retains typed failures or projects HTTP class/code/status. The approval handler carries them to the existing alert presenter, which exposes safe technical details and reuses refresh-and-check recovery copy. No retries.

## Diagnosis and deciding evidence

- Observed/reproduced: compact `{discussionRef, localId, after}` reached the Session executor's resolved-only mutation parser before passage preparation, throwing `$ZodError` for missing resolved fields. `propose-session-red.log` → `propose-session-green.log` (5/5), and all five Doc scenarios pass in the adjacent run.
- Observed/constructed: the real private Session dispatch receives `TypeError` or Prisma `P2028` from a Home HTTP boundary. Both previously became `target_unavailable`; carried target refusal control passes. `daemon-red-valid.log`: 2 failed / 1 passed. Earlier fixture failures in `daemon-red.log` are not RED evidence.
- Observed/reproduced: actual decline makes one POST to `/v2/sessions/:id/messages/by-local-id/:id/reply`; its non-ok adapter discarded a 503 database-transaction cause. `approval-decline-red.log` fails for the missing cause; `approval-green.log` passes 41/41 across three suites, including bare unavailable/503 recovery and private-value exclusion.
- Observed/constructed: real catalog search finds `doc.edit.propose` in the first five for plain rewrite and Doc-suggestion queries; discovery 2/2 and protocol Doc executor 33/33 passed. This proves catalog reachability, not a model's eventual tool choice.
- Historical loaded capture lacks proposal tool arguments and typed decline response. Therefore neither the compact parser defect nor P2028 is proven to be the original incident's exact first cause. A new loaded replay must decide that.

## Validation

- Evidence directory: `.project/tmp/ACTION-CAUSE-1108/`.
- Daemon GREEN: 3/3 pass, `daemon-green.log` (native-XxRoPY-3-1794112218, terminal exit 0).
- Entry-loads: 7/7 pass, `entry-loads.log` (native-DwSTLu-4-1794112203, terminal exit 0).
- [blocked] Generated help: canonical `generateBundledPluginEntries.ts --mode write --aggregate` still waiting, `generate.log`; queued behind live PID2700895's workspace publication lock (queued compilation admission for installedServices/workflowSessionConversation/relay.access integration tests). Coordination/Systemic ASK posted 04:33 UTC; no lock/process changed. Original generator handle80200/PID2015697 remains alive; resume it, do not launch another writer.
- Adjacent Session/Discussion suites: 30 failed / 130 passed (`propose-session-adjacent.log`). All touched Doc cases pass; notification/SCM/managed/client/source-admission failures remain unattributed.
- Adjacent protocol exposure suite: 35 passed / 2 failed (computer-secret-fill API projection and final desktop/browser/deployments/discussion-post projections), `propose-discovery-green-adjacent.log`; discovery RED is `propose-discovery-red.log`. No claim failures are pre-existing.
- Scoped diff whitespace check passed. Package typechecks were not run: brief's explicit lane gate is focused tests + entry-loads; package diagnostics remain the integration owner's background lane.

## Ownership and simplification

- Canonical owners: protocol failure projector; Session Account Action admission/preparation; protocol Doc passage resolver and Action description; UI review transport and approval failure presenter.
- Removed the catch's fabricated target-refusal fallback. Reused the existing failure envelope/cause schemas, passage resolver, approval state, alert presenter and recovery translation. No parallel resolver, prompt machinery or retry path.
- Explicit Doc input remains a supported path through the same resolver. Approved publication reads already-resolved stored input, so it is not another passage authority.
- Compact input inside a tampered raw approval record is outside the legitimate producer path; no new approval-record repair mechanism was added.
- Net mechanisms: +2 owner boundary cause projections, −1 fabricated refusal fallback; +1 pre-signing resolver call for compact proposals (prevents resolved-only parse failure; one root read); +1 existing approval recovery branch for unavailable/503. States +0/−0, error codes +0/−0, timers +0/−0, retries +0/−0; production files +0/−0, test files +2/−0.
- Existing Docs already describe compact proposal resolution; descriptions are updated at the Action owner. No wire/persistence schema or compatibility transition changed.

## Handoff and residual risk

- Runtime fixes committed: `a36c29da0967dffaa800c60a0adf717dc33fb2fd`; private-index fast path, machine identity, shared index preserved. Discovery source/report follow separately; generated help is not claimed published.
- Coordination: load the change through the lifecycle owner, then replay plain rewrite → compact proposal in A's own passage thread → inspect/decline draft. Capture typed response and technical details if a failure remains. This lane was forbidden stack actions.
- Coordination/Systemic must unblock the existing publication owner, collect the generator terminal result, and commit its current-source projection closure. Unverified: loaded runtime/model tool selection, original incident first cause, package-wide diagnostics and physical-platform behavior. No platform-specific runtime code was added.
