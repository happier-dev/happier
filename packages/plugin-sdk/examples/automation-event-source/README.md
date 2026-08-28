# Automation Event source setup

This maintained external-plugin example focuses on the authoring half of an Automation Event
source: one semantic Event declaration, its ordinary setup Action, and optional custom setup
presentation. It intentionally does not claim to observe an upstream service. Happier owns
trigger persistence, strict Action validation, Event admission, dedupe, Run history, and
execution.

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

For the source-level runtime authoring half—background observation, current source listing,
checkpoint-safe admission requests, source status, and Run lifecycle subscription—see the
public-SDK-only `packages/tests/fixtures/plugin-platform/automation-event-observer` reference
and its CLI-host integration in
`apps/cli/src/plugins/authoring/automationEventExternalSource.fixture.test.ts`. That fixture
stops at the server transport boundary; persisted-Run and loaded-product proof belongs to the
composed Automation validation lane.
