import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readCliAccessKey } from './cliAccessKey';
import { createRunDirs } from './runDir';

const run = createRunDirs({ runLabel: 'cli-access-key' });

describe('readCliAccessKey', () => {
  it('falls back to newest per-server access.key when legacy root file is missing', async () => {
    const dir = run.testDir('fallback-newest-per-server');
    const home = resolve(join(dir, 'cli-home'));
    await mkdir(join(home, 'servers', 'server-a'), { recursive: true });
    await mkdir(join(home, 'servers', 'server-b'), { recursive: true });

    const a = JSON.stringify({ token: 't-a', secret: 's-a' }) + '\n';
    const b = JSON.stringify({ token: 't-b', encryption: { publicKey: 'p-b', machineKey: 'm-b' } }) + '\n';
    await writeFile(join(home, 'servers', 'server-a', 'access.key'), a, 'utf8');
    // Ensure server-b has a strictly newer mtime.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(home, 'servers', 'server-b', 'access.key'), b, 'utf8');

    const key = await readCliAccessKey(home);
    expect(key).toEqual({ token: 't-b', encryption: { publicKey: 'p-b', machineKey: 'm-b' } });
  });

  it('prefers per-server access.key when settings.json activeServerId matches', async () => {
    const dir = run.testDir('prefers-active-server');
    const home = resolve(join(dir, 'cli-home'));
    await mkdir(join(home, 'servers', 'active'), { recursive: true });
    await mkdir(join(home, 'servers', 'other'), { recursive: true });

    const active = JSON.stringify({ token: 't-active', secret: 's-active' }) + '\n';
    const other = JSON.stringify({ token: 't-other', encryption: { publicKey: 'p-other', machineKey: 'm-other' } }) + '\n';
    await writeFile(join(home, 'servers', 'active', 'access.key'), active, 'utf8');
    await writeFile(join(home, 'servers', 'other', 'access.key'), other, 'utf8');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ schemaVersion: 5, activeServerId: 'active' }) + '\n', 'utf8');

    const key = await readCliAccessKey(home);
    expect(key).toEqual({ token: 't-active', secret: 's-active' });
  });
});
