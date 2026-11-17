import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from '../../actionSettings.js';
import { createActionExecutor } from '../../actionExecutor.js';

describe('Delete through the public Stop Action', () => {
  it.each(['action-result', 'native-payload'] as const)('carries the reviewed Remove without cleanup choice to the native owner (%s)', async (responseShape) => {
    let skipped = false;
    const executor = createActionExecutor({
      sessionDelete: async ({ input, deleteFromHome }) => {
        skipped = input.skipCleanup === true;
        const deleted = await deleteFromHome();
        return responseShape === 'native-payload' && deleted.ok ? deleted.result : deleted;
      },
      homeDomainAction: async () => ({ success: true }),
    });
    const result = await executor.execute('session.delete', { sessionId: 'managed-session', skipCleanup: true }, {
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }), surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: 'home', presentUserConfirmation: { actionId: 'session.delete' },
    });
    expect(result).toEqual({ ok: true, result: { success: true } });
    expect(skipped).toBe(true);
  });
  it('keeps native cleanup before Home deletion and reuses Stop when the Session is active', async () => {
    const effects: string[] = [];
    let active = true;
    const executor = createActionExecutor({
      // Native transport and Home HTTP are genuine host boundaries.
      sessionDelete: async ({ deleteFromHome }) => deleteFromHome(async () => {
        if (active) return { ok: false, errorCode: 'session_active', error: 'session_active' };
        effects.push('cleanup');
      }),
      homeDomainAction: async () => { effects.push('home-delete'); return { success: true }; },
      sessionStop: async ({ sessionId }) => {
        effects.push('stop'); active = false;
        return { sessionId, stopped: true, success: true };
      },
    });
    const result = await executor.execute('session.delete', { sessionId: 'managed-session' }, {
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }), surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      presentUserConfirmation: { actionId: 'session.delete' },
    });
    expect(result).toEqual({ ok: true, result: { success: true } });
    expect(effects).toEqual(['stop', 'cleanup', 'home-delete']);
  });

  it('retains the Session when native cleanup is refused', async () => {
    let homeDeletes = 0;
    const executor = createActionExecutor({
      sessionDelete: async ({ deleteFromHome }) => deleteFromHome(async () => ({
        ok: false, errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required',
      })),
      homeDomainAction: async () => { homeDeletes++; return { success: true }; },
    });
    const result = await executor.execute('session.delete', { sessionId: 'managed-session' }, {
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }), surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      presentUserConfirmation: { actionId: 'session.delete' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'project_setup_consent_required' });
    expect(homeDeletes).toBe(0);
  });

  it.each([
    { code: 'session_stop_control_unavailable', recovery: 'retry_when_runtime_available' },
    { code: 'session_stop_requested', recovery: 'wait_for_inactive' },
  ])('retains the host lifecycle refusal: $code', async ({ code, recovery }) => {
    let deletes = 0;
    // The host ports stand for Home HTTP and physical runtime control. All Action
    // admission, reviewed-child dispatch and result projection remain real.
    const executor = createActionExecutor({
      homeDomainAction: async () => { deletes++; return { ok: false, errorCode: 'session_active', error: 'session_active' }; },
      sessionStop: async ({ sessionId }) => ({ sessionId, stopped: false, success: false, code, recovery, message: 'Runtime control unavailable' }),
    });
    const result = await executor.execute('session.delete', { sessionId: 'active-session' }, {
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }), surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      presentUserConfirmation: { actionId: 'session.delete' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: code,
      details: { sessionId: 'active-session', recovery } });
    expect(deletes).toBe(1);
  });
});
