import { describe, expect, it, vi } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';

const bootstrapAccountSettingsContext = vi.fn(async () => ({
  source: 'network' as const,
  settings: { schemaVersion: 6 },
  settingsVersion: 1,
  loadedAtMs: Date.now(),
  settingsSecretsReadKeys: [],
  whenRefreshed: null,
}));

const execute = vi.fn(async () => ({
  ok: true,
  result: { ok: true, sessionId: 'sess-1', title: 'New title' },
}));

const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('handleSessionCommand account settings bootstrap', () => {
  it('does not force a global account settings refresh before running session action commands', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleText();
    try {
      await handleSessionCommand(['set-title', 'sess-1', 'New title'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(bootstrapAccountSettingsContext).not.toHaveBeenCalled();
      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
    }
  });
});
