import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executePluginDevLoopAction } = vi.hoisted(() => ({
  executePluginDevLoopAction: vi.fn(),
}));

vi.mock('@/plugins/devLoop/actions', () => ({
  executePluginDevLoopAction,
}));

import { createCliActionExecutor } from './createCliActionExecutor';

function createExecutor(credentialProvenance: 'api_token' | 'stored_session') {
  const token = credentialProvenance === 'api_token'
    ? 'hap_v1_api-token'
    : 'stored-session-bearer';
  return createCliActionExecutor({
    token,
    credentials: {
      token,
      encryption: null,
      credentialProvenance,
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: null,
  });
}

describe('createCliActionExecutor credential authority', () => {
  beforeEach(() => {
    executePluginDevLoopAction.mockReset();
  });

  it('fails closed for API-token credentials before present-user actions reach their dependencies', async () => {
    executePluginDevLoopAction.mockResolvedValue({
      ok: true,
      kind: 'plugins_install',
      outcome: 'applied',
    });
    const executor = createExecutor('api_token');

    await expect(executor.execute(
      'plugins.install',
      { path: '/tmp/plugin' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
    expect(executePluginDevLoopAction).not.toHaveBeenCalled();

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
    executePluginDevLoopAction.mockResolvedValue({
      ok: true,
      kind: 'plugins_install',
      outcome: 'applied',
    });
    const executor = createExecutor('stored_session');

    await expect(executor.execute(
      'plugins.install',
      { path: '/tmp/plugin' },
      { surface: 'cli' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins_install',
        outcome: 'applied',
      },
    });
    expect(executePluginDevLoopAction).toHaveBeenCalledOnce();
  });
});
