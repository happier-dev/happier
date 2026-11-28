import { expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import { withAdmittedSessionRun } from './testkit/admittedSessionRun.composed';
import { listExecutionRunMarkers, readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';

it('retains only the selected approval profile reference and persists attachment and detachment', async () => {
  await withAdmittedSessionRun({ directOwner: true, run: async fixture => {
    const started = await fixture.start({ approvalProfileId: 'builtin:apply-safe' });
    expect((await readRetainedExecutionRunRecord(started.runId))?.state)
      .toMatchObject({ approvalProfileId: 'builtin:apply-safe' });
    const bridge = fixture.bridge!;
    expect(bridge.getPublic(started.runId)).toMatchObject({ approvalProfileId: 'builtin:apply-safe' });
    expect(await bridge.applyAction(started.runId, { actionId: 'approval_profile.set',
      input: { approvalProfileId: { defaultMode: 'allow' } } })).toMatchObject({
      ok: false, errorCode: 'execution_run_invalid_action_input',
    });
    for (const approvalProfileId of ['custom:read-only', null]) {
      expect(await bridge.applyAction(started.runId, {
        actionId: 'approval_profile.set', input: { approvalProfileId },
      })).toMatchObject({ ok: true });
      expect(bridge.getPublic(started.runId)).toMatchObject({ approvalProfileId });
      expect((await readRetainedExecutionRunRecord(started.runId))?.state).toMatchObject({ approvalProfileId });
      expect((await listExecutionRunMarkers()).find(marker => marker.runId === started.runId))
        .toMatchObject({ approvalProfileId });
    }
  } });
});
