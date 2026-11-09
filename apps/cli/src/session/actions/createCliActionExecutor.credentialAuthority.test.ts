import { describe, expect, it } from 'vitest';

import { createCliActionExecutor } from './createCliActionExecutor';
import { bindRequesterSessionCredentialScope, type StoredCredentials } from '@/persistence';

function createExecutor(actor: 'api_token' | 'stored_session' | 'session_custody') {
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
  });
}

describe('createCliActionExecutor credential authority', () => {
  it.each(['api_token', 'session_custody'] as const)('refuses present-user approval preparation for %s even with an authority claim', async actor => {
    const executor = createExecutor(actor);
    await expect(executor.prepare('approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli', authority: 'present_user' },
    )).resolves.toMatchObject({
      kind: 'settled', result: { ok: false, errorCode: 'present_user_required' },
    });
    await expect(executor.execute(
      'approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
  });

  it('keeps an authenticated stored CLI session eligible for present-user actions', async () => {
    const executor = createExecutor('stored_session');
    expect((await executor.prepare('approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' }, { surface: 'cli' },
    )).kind).toBe('ready');
  });
});
