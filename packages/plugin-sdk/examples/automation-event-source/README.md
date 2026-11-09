# Automation Event source setup

This maintained external-plugin example shows one complete Automation Event source: a semantic
Event declaration, its ordinary setup Action, optional custom setup presentation, and a daemon
background observer. The observer uses a deterministic repository-push feed so the example needs
no credentials; replace `EXAMPLE_PUSHES` with the real provider poll in a production plugin.
Happier still owns trigger persistence, strict Action validation, Event admission, dedupe, source
and catalog status, Run history, and execution.

The Action schema is the default setup UI. The optional `setupSurface` uses one same-plugin
renderer chain through the existing plugin renderer host only to collect the same Action input:
the hosted-web picker completes through `hostApi.settleEphemeralInput({ kind: 'completed', input })`
or cancels the setup operation, and a build-artifact-free declarative renderer is declared as its
truthful unavailable fallback. The generic Action form remains the default whenever no usable
custom setup surface is projected; cancelling a mounted custom surface does not silently switch
input owners mid-operation. The chain
cannot write an Automation, choose a trigger identity, or bypass the host's setup Action and
result validation; the host admits both renderers and the Protocol-owned host-method union at
ingestion.

Remove `setupSurface` to use the generic Action form without changing the source or runtime
contract.

`runRepositoryPushObserver` supplies a finite adapter to the daemon-only public
`runCheckpointedPluginEventObserverV1` runner. The SDK owns the current source catalog,
host-stamped materialization assignment, admission, invalidation and cancellation. The adapter
uses the definitions admitted for that finite cycle; edits are adopted on the next
cycle, while the current invocation signal cancels local work. Server Event
admission and provider cursor CAS remain authoritative.
The adapter
decodes the selected repository and returns its deterministic feed once; it supplies no timer
or invented polling period. Its save port logs settlement only after all observations are safe;
this example has no durable provider cursor. A real source keeps its existing cursor/CAS there
and derives its next eligibility from provider headers or a deliberate source period. An
unsettled admission must retain the same occurrence for retry.
The settlement log preserves `disposition.admissions`: each observation's exact selector,
transport scope and server result. `checkpointSafe` alone does not prove execution: a filtered
or stale observation can safely settle without admitting a Run. Admission-only effects require
an exact matching `admitted` or `rejoined` result; absent metadata fails closed. `rejoined`
proves prior admission, not a new opening, so retain the effect owner's existing opening and
idempotency checks.
While durable push is absent or only Preview, recover a pre-durable loss by observing the
same provider occurrence again through redelivery or the next checkpointed pull. For GitHub-style
webhooks, normalize redeliveries to the same stable occurrence id and never use the webhook attempt
as the Automation dedupe key. After the deterministic feed settles, `nextEligibleAt: null` leaves
the SDK waiting for authenticated invalidation or cancellation, with no idle timer. An absent
or mismatched own materialization produces no occurrence, even if a caller claims another one.

The adjacent behavior test invokes this source module directly and checks assigned-source
admission, empty-catalog idleness and cancellation through public SDK Actions. The SDK owner
suite also checks the maintained example's wrong-host refusal. The deeper CLI
host integration remains in
`apps/cli/src/plugins/authoring/automationEventExternalSource.fixture.test.ts`; persisted-Run and
loaded-product proof belongs to the composed Automation validation lane.
