import { expect, it, vi } from 'vitest';

const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  import('@/plugins/projection/registry/builtIn/locators.testkit')
));

// Filesystem publication is the installed-plugin boundary; admission and selection stay real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

import { runRequesterAttributionCase } from './testkit/admittedSessionRun.composed';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

it('consumes the detached Account-default choice while retaining its materialized native bindings', async () => {
  await runRequesterAttributionCase('protected child', false, { directOwner: true, run: async fixture => {
    // Control: the same installed host admits an explicit native detached Run.
    const control = await fixture.start({ sessionId: null, intent: 'task',
      requesterWorkAttributionV1: fixture.requesterWorkAttributionV1 });
    expect(control.runId).toEqual(expect.any(String));
    await fixture.bridge!.stop(control.runId);

    const started = await fixture.start({ sessionId: null, intent: 'task', childSelection: 'agentDefault',
      modelSelection: undefined, connectedServices: undefined,
      requesterWorkAttributionV1: fixture.requesterWorkAttributionV1 });
    const retained = await readRetainedExecutionRunRecord(started.runId);
    expect(retained?.state.launch?.connectedServicesSelection).toEqual({ v: 2, bindingsByServiceId: {} });
    await fixture.bridge!.stop(started.runId);
  } });
});

it('retains the saved Account model when consuming its detached default choice', async () => {
  const agentTargetKey = buildBackendTargetKeyV2({ kind: 'agent',
    identity: { pluginId: 'test.c42.attribution', localId: 'agent' } });
  await runRequesterAttributionCase('protected child', false, { directOwner: true,
    accountSettings: { providerDefaultModelSelectionsByAgentTargetKeyV1: {
      [agentTargetKey]: { v: 1, updatedAt: 1, ref: {
        agentTargetKey, providerConnectionId: null, modelId: 'account-default-model',
      } },
    } }, run: async fixture => {
      const started = await fixture.start({ sessionId: null, intent: 'task', childSelection: 'agentDefault',
        modelSelection: undefined, connectedServices: undefined,
        requesterWorkAttributionV1: fixture.requesterWorkAttributionV1 });
      const retained = await readRetainedExecutionRunRecord(started.runId);
      expect(retained?.state.launch?.modelSelection).toMatchObject({ agentTargetKey,
        providerConnectionId: null, modelId: 'account-default-model' });
      expect(retained?.state.launch?.connectedServicesSelection).toEqual({ v: 2, bindingsByServiceId: {} });
      await fixture.bridge!.stop(started.runId);
    } });
});

it('still rejects an Account-default choice combined with an explicit native reset', async () => {
  await runRequesterAttributionCase('protected child', false, { directOwner: true, run: async fixture => {
    await expect(fixture.start({ sessionId: null, intent: 'task', childSelection: 'agentDefault',
      modelSelection: null, connectedServices: undefined,
      requesterWorkAttributionV1: fixture.requesterWorkAttributionV1 }))
      .rejects.toThrow('Account default choice conflicts with an explicit child selection');
    expect(fixture.nativeDetachedOpen).not.toHaveBeenCalled();
  } });
});
