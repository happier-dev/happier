import { describe, expect, it } from 'vitest';

import { validateCodexAcpSpawnAvailability } from './spawnAvailability';

describe('validateCodexAcpSpawnAvailability', () => {
  it('rejects codex-acp spawn when codex-acp is not on PATH', () => {
    const res = validateCodexAcpSpawnAvailability(
      { command: 'codex-acp', args: [] },
      { env: { PATH: '' } as any },
    );
    expect(res.ok).toBe(false);
  });

  it('rejects absolute command paths that do not exist', () => {
    const res = validateCodexAcpSpawnAvailability(
      { command: '/tmp/missing-codex-acp', args: [] },
      { existsSyncFn: () => false },
    );
    expect(res.ok).toBe(false);
  });

  it('rejects absolute command paths that are not executable on Unix', () => {
    if (process.platform === 'win32') return;

    const res = validateCodexAcpSpawnAvailability(
      { command: '/tmp/codex-acp', args: [] },
      {
        accessSyncFn: () => {
          throw new Error('not executable');
        },
      },
    );
    expect(res.ok).toBe(false);
  });

  it('rejects PATH codex-acp shims that are not executable on Unix', () => {
    if (process.platform === 'win32') return;

    const res = validateCodexAcpSpawnAvailability(
      { command: 'codex-acp', args: [] },
      {
        env: { PATH: '/tmp/bin' } as any,
        existsSyncFn: () => true,
        accessSyncFn: () => {
          throw new Error('not executable');
        },
      },
    );
    expect(res.ok).toBe(false);
  });
});
