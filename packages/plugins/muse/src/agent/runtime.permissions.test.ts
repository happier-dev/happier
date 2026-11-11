import { expect, it } from 'vitest';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

it.each([
  ['default', ':ask-me', 'promptUnmatched'], ['read-only', ':read-only', 'promptUnmatched'], ['plan', ':read-only', 'promptUnmatched'],
  ['safe-yolo', ':ask-me', 'onRequest'], ['yolo', ':unrestricted', 'allowAll'],
] as const)('starts %s with its native profile', async (intent, profile, approvalMode) => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration: { model: { value: null, updatedAtMs: 0 },
        mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: intent, updatedAtMs: 0 }, options: {} } });
    expect(session.runtimeDescriptorV1?.agent.providerSessionId).toBeTruthy();
    await fixture.closeSession();
    expect((await fixture.readAudit()).commandTargets).toMatchObject([
      { method: 'session/start', permissionProfile: profile, approvalMode },
    ]);
  } finally { await fixture.dispose(); }
});

it('changes approval mode within the admitted profile and refuses unsupported in-place profile changes', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  const configuration = { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} };
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'safe-yolo', updatedAtMs: 1 } })).toMatchObject({ status: 'applied', changed: ['permissionIntent'] });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'yolo', updatedAtMs: 2 } })).toMatchObject({ status: 'unsupported' });
    expect(await fixture.publications.readActiveInputBinding()?.applyPermissionIntentDuringTurn('default'))
      .toMatchObject({ status: 'applied' });
    await fixture.closeSession();
    expect((await fixture.readAudit()).commandTargets.filter(command => command.method === 'session/setApprovalMode'))
      .toMatchObject([{ mode: 'onRequest' }, { mode: 'promptUnmatched' }]);
  } finally { await fixture.dispose(); }
});
