import { describe, expect, it, vi } from 'vitest';
import { MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY } from '@happier-dev/protocol/features/payload/capabilities/machineTransferCapabilities';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveServerRoutedTransferMaxBytes } from './serverRoutedTransferPolicy';

describe('server-routed transfer Session policy', () => {
  it('uses the concurrent Session policy while preserving explicit Machine policy', async () => {
    vi.stubEnv(MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY, '999');
    const observe = (limit: number) => runAddedHostedSession({
      environment: { NODE_ENV: 'test', [MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY]: String(limit) }, workingDirectory: '/session/transfer', end() {},
    }, async () => {
      await Promise.resolve();
      expect(resolveServerRoutedTransferMaxBytes()).toBe(limit);
      expect(resolveServerRoutedTransferMaxBytes({ NODE_ENV: 'test', [MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY]: '777' })).toBe(777);
    });
    try { await Promise.all([observe(123), observe(456)]); }
    finally { vi.unstubAllEnvs(); }
  });
});
