import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-review-1' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));
const createCliActionExecutor = vi.fn(() => ({ execute }));
const resolveSessionTransportContext = vi.fn();
const ensureCliActionPolicySettings = vi.fn();

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));
vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

describe('happier session review start command', () => {
  it('selects the public Action transport before legacy Session bootstrap for API tokens', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { results: [{ key: 'review-1' }] } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['review', 'start', 'sess-review', '--engines', 'engine-1', '--instructions', 'Review.', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-review');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'review.start',
        { engineIds: ['engine-1'], instructions: 'Review.' },
        { defaultSessionId: 'sess-review-1' },
      );
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_review_start' }));
    } finally {
      output.restore();
    }
  });
});
