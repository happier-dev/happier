import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';

describe('daemon testkit portability', () => {
  it('fails fast with a clear error when hard-kill requires ps inspection but ps is unavailable', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-testkit-'));
    const happyHomeDir = join(testDir, 'home');
    await mkdir(happyHomeDir, { recursive: true });

    await writeFile(
      join(happyHomeDir, 'daemon.state.json'),
      JSON.stringify({ pid: process.pid, httpPort: 1 }),
      'utf8',
    );

    await expect(
      stopDaemonFromHomeDir(happyHomeDir, {
        gracefulTimeoutMs: 0,
        hardKill: true,
        inspectProcess: () => ({ ok: false, reason: 'ps_missing' }),
      }),
    ).rejects.toThrow(/ps/i);
  });
});

