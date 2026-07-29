import { describe, expect, it, vi } from 'vitest';

import {
  clearPromotedManagedLocalServiceMarkerAttachment,
} from './clearPromotedManagedLocalServiceMarkerAttachment';

const ownership = {
  happySessionId: 'PID-200',
  processCommandHash: 'a'.repeat(64),
  processStartTimeMs: 2_000,
};
const attachment = {
  v: 1 as const,
  process: {
    pid: 9_001,
    processStartTimeMs: 1_000,
    processCommandHash: 'b'.repeat(64),
  },
  endpoint: { host: '127.0.0.1' as const, port: 8317 },
  materialization: {
    rootDir: '/tmp/managed-runtime',
    materializationId: 'managed-runtime',
  },
};

describe('clearPromotedManagedLocalServiceMarkerAttachment', () => {
  it.each(['cleared', 'already_absent'] as const)(
    'accepts the promotion when canonical target attachment is %s',
    async (result) => {
      const clear = vi.fn(async () => result);
      await expect(
        clearPromotedManagedLocalServiceMarkerAttachment({
          toPid: 200,
          ownership,
          canonicalSessionId: 'session-canonical',
          attachment,
          clear,
        }),
      ).resolves.toBe(true);
      expect(clear).toHaveBeenCalledOnce();
    },
  );

  it('falls back to exact placeholder ownership and refuses a true mismatch', async () => {
    const clear = vi.fn()
      .mockResolvedValueOnce('mismatch' as const)
      .mockResolvedValueOnce('mismatch' as const);
    await expect(
      clearPromotedManagedLocalServiceMarkerAttachment({
        toPid: 200,
        ownership,
        canonicalSessionId: 'session-canonical',
        attachment,
        clear,
      }),
    ).resolves.toBe(false);
    expect(clear).toHaveBeenCalledTimes(2);
  });
});
