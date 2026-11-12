import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from '../../actionSettings.js';
import { createActionExecutor } from '../../actionExecutor.js';

describe('Delete through the public Stop Action', () => {
  it.each([
    { code: 'session_stop_control_unavailable', recovery: 'retry_when_runtime_available' },
    { code: 'session_stop_requested', recovery: 'wait_for_inactive' },
  ])('retains the host lifecycle refusal: $code', async ({ code, recovery }) => {
    let deletes = 0;
    // The host ports stand for Home HTTP and physical runtime control. All Action
    // admission, reviewed-child dispatch and result projection remain real.
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
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
