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

it('changes running permission profiles and approval modes through the startup mapping', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  const configuration = { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} };
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'safe-yolo', updatedAtMs: 1 } })).toMatchObject({ status: 'applied', changed: ['permissionIntent'] });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'read-only', updatedAtMs: 2 } })).toMatchObject({ status: 'applied', changed: ['permissionIntent'] });
    expect(await fixture.publications.readActiveInputBinding()?.applyPermissionIntentDuringTurn('default'))
      .toMatchObject({ status: 'applied' });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'default', updatedAtMs: 3 } })).toMatchObject({ status: 'applied', changed: [] });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.commandTargets.filter(command => command.method === 'session/setPermissionProfile'))
      .toMatchObject([{ sessionId: session.runtimeDescriptorV1?.agent.providerSessionId, profileId: ':read-only' },
        { sessionId: session.runtimeDescriptorV1?.agent.providerSessionId, profileId: ':ask-me' }]);
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect((await fixture.readAudit()).commandTargets.filter(command => command.method === 'session/setApprovalMode'))
      .toMatchObject([{ mode: 'onRequest' }, { mode: 'promptUnmatched' }, { mode: 'promptUnmatched' }]);
  } finally { await fixture.dispose(); }
});

// Native 1.4.15 documents this no-effect refusal for --no-session-log.
it('retains the typed ephemeral-profile refusal without reporting success or restarting', async () => {
  const fixture = await createAdmittedMuseSessionFixture({ native: { permissionProfileRefusal: true } });
  const configuration = { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} };
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'read-only', updatedAtMs: 1 } })).toMatchObject({ status: 'rejected',
        diagnostic: { code: 'provider_request_rejected', details: {
          method: 'session/setPermissionProfile', providerErrorCode: -32030,
          reason: 'permission_profile_ephemeral_fixed',
        } } });
    expect(await session.updateConfiguration?.(configuration)).toMatchObject({ status: 'applied', changed: [] });
    await fixture.closeSession();
    expect((await fixture.readAudit()).methods.filter(method => method === 'session/start')).toHaveLength(1);
  } finally { await fixture.dispose(); }
});
