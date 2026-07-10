import { describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));
const ensureCliActionPolicySettings = vi.fn();

vi.mock('./createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('./ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  resolveSessionEncryptionContextFromCredentials: vi.fn(() => ({ kind: 'legacy' })),
}));

describe('createCliActionExecutorFromCredentials', () => {
  it('loads action policy settings lazily before delegated action execution', async () => {
    const events: string[] = [];
    ensureCliActionPolicySettings.mockImplementationOnce(async () => {
      events.push('settings');
    });
    execute.mockImplementationOnce(async () => {
      events.push('execute');
      return { ok: true, result: { ok: true } };
    });

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const credentials = {
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };

    const executor = createCliActionExecutorFromCredentials({ credentials });

    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    await executor.execute('session.status.get', { sessionId: 'sess-1' }, { surface: 'cli' });

    expect(createCliActionExecutor).toHaveBeenCalledTimes(1);
    expect(ensureCliActionPolicySettings).toHaveBeenCalledWith(credentials);
    expect(events).toEqual(['settings', 'execute']);
  });
});
