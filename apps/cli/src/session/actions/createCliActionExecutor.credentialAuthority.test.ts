import { describe, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { createCliActionExecutor } from './createCliActionExecutor';
import { bindRequesterSessionCredentialScope, type StoredCredentials } from '@/persistence';

function createExecutor(actor: 'api_token' | 'stored_session' | 'session_custody',
  sessionActionConfirmation?: ActionExecutorDeps['sessionActionConfirmation']) {
  const credentialProvenance = actor === 'session_custody' ? 'stored_session' : actor;
  const token = credentialProvenance === 'api_token'
    ? 'hap_v1_api-token'
    : 'stored-session-bearer';
  const credentials: StoredCredentials = { token, encryption: null, credentialProvenance };
  if (actor === 'session_custody') bindRequesterSessionCredentialScope(credentials, {
    serverId: 'home', serverHttpBaseUrl: 'https://home.test', requesterSession: { sessionId: 'sess-1',
      attribution: { serverId: 'home', accountId: 'person', machineId: 'machine', installationId: 'installation' } },
  });
  return createCliActionExecutor({
    token,
    credentials,
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: null,
    pluginActionExecutionOwner: 'current_process',
    getCurrentSessionMetadata: () => ({}),
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      actions: { 'session.activity.get': { approvalRequiredSurfaces: ['agent'] } },
    }) },
    sessionActionConfirmation,
  });
}

describe('createCliActionExecutor credential authority', () => {
  it.each(['api_token', 'session_custody'] as const)('keeps %s at automation authority despite a present-user claim', async actor => {
    // The Session permission response is the human transport boundary. Exercise
    // canonical admission and inspect the authority delivered to that boundary.
    const confirm = vi.fn<NonNullable<ActionExecutorDeps['sessionActionConfirmation']>>(async () => ({
      decision: 'reject', isCurrent: () => true,
    }));
    const executor = createExecutor(actor, confirm);
    for (const method of ['prepare', 'execute'] as const) {
      const result = await executor[method]('session.activity.get', { sessionId: 'sess-1' }, {
        surface: 'agent', authority: 'present_user', defaultSessionId: 'sess-1',
      });
      expect('kind' in result && result.kind === 'settled' ? result.result : result)
        .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    }
    expect(confirm.mock.calls).toHaveLength(2);
    for (const [request] of confirm.mock.calls) {
      expect(request.context.authority).toBe('account_automation');
    }
  });

  it('keeps an authenticated stored CLI session eligible for present-user actions', async () => {
    const executor = createExecutor('stored_session');
    expect((await executor.prepare('approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' }, { surface: 'cli' },
    )).kind).toBe('ready');
  });
});
