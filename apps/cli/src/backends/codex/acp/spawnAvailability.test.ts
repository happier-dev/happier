import { describe, expect, it } from 'vitest';

import { validateCodexAcpSpawnAvailability } from './spawnAvailability';

describe('validateCodexAcpSpawnAvailability', () => {
  it('rejects npx spawn when npx is not on PATH', () => {
    const res = validateCodexAcpSpawnAvailability(
      { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
      { env: { PATH: '' } as any },
    );
    expect(res.ok).toBe(false);
  });

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
});

