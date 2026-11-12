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
    expect(fixture.debugLogs.filter(args => args[0] === 'Muse permission profile outcome')).toEqual([
      ['Muse permission profile outcome', { method: 'session/setPermissionProfile',
        sessionId: session.runtimeDescriptorV1?.agent.providerSessionId, status: 'rejected', applyOutcome: null,
        requestedProfileId: ':read-only', providerErrorCode: -32030, reason: 'permission_profile_ephemeral_fixed' }],
    ]);
    await fixture.closeSession();
    expect((await fixture.readAudit()).methods.filter(method => method === 'session/start')).toHaveLength(1);
  } finally { await fixture.dispose(); }
});

// Muse 1.4.15 PermissionProfileApplyOutcome is open: completed/noop are known
// successes, while an unknown word is retained without assuming application.
it.each([
  { name: 'noop', result: { applyOutcome: 'noop' }, applied: true },
  { name: 'unknown outcome', result: { applyOutcome: 'future-not-applied' }, applied: false },
  { name: 'missing outcome', result: {}, applied: false },
  { name: 'mismatched committed profile', result: { applyOutcome: 'completed', profileId: ':ask-me' }, applied: false },
])('interprets the native permission profile $name before advancing state', async ({ result, applied }) => {
  const fixture = await createAdmittedMuseSessionFixture({ native: { permissionProfileResult: result } });
  const configuration = { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} };
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration });
    const update = await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'read-only', updatedAtMs: 1 } });
    expect(update).toMatchObject(applied ? { status: 'applied' } : { status: 'unavailable', diagnostic: {
      code: 'PLUGIN_EXEC_PROTOCOL_ERROR', details: { method: 'session/setPermissionProfile',
        ...(result.applyOutcome ? { applyOutcome: result.applyOutcome } : {}) },
    } });
    const logs = fixture.debugLogs.filter(args => args[0] === 'Muse permission profile outcome');
    expect(logs).toEqual([['Muse permission profile outcome', {
      method: 'session/setPermissionProfile', sessionId: session.runtimeDescriptorV1?.agent.providerSessionId, status: 'accepted',
      applyOutcome: result.applyOutcome ?? null,
      requestedProfileId: ':read-only', effectiveProfileId: result.profileId ?? ':read-only',
    }]]);
    // An uncertain native effect invalidates the local projection. A later
    // explicit default choice must reach MSP, rather than falsely no-op using
    // the cached pre-command profile. The mismatched reply is valid for default.
    if (!applied) expect(await session.updateConfiguration?.(configuration)).toMatchObject({
      status: result.applyOutcome === 'completed' ? 'applied' : 'unavailable',
    });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.commandTargets.filter(command => command.method === 'session/setPermissionProfile')).toHaveLength(applied ? 1 : 2);
    expect(audit.commandTargets.filter(command => command.method === 'session/setApprovalMode'))
      .toHaveLength(applied || result.applyOutcome === 'completed' ? 1 : 0);
  } finally { await fixture.dispose(); }
});
