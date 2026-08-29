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

`runRepositoryPushObserver` is the only provider-side observation owner. It passes each upstream
fact to `admitCheckpointedPluginEventObservationV1`, which performs the complete current source
scan, canonical admission, catalog reconciliation report, and per-source status report through
public SDK Actions. A real provider persists or advances its own ordered cursor only after the
helper returns `checkpointSafe`; an unsettled result must retain the same upstream occurrence for
retry. After the deterministic feed settles, the example stays idle until its exact plugin
generation is retired so the host never mistakes normal return for a healthy observer.

The adjacent behavior test invokes this source module directly and exercises that list → catalog
status → admit → source status sequence without assuming a prebuilt `dist` tree. The deeper CLI
host integration remains in
`apps/cli/src/plugins/authoring/automationEventExternalSource.fixture.test.ts`; persisted-Run and
loaded-product proof belongs to the composed Automation validation lane.
