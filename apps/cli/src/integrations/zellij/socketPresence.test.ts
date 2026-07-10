import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectZellijSessionSocketPresence } from './socketPresence';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.().catch(() => undefined);
  }
});

async function makeSocketDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zellij-sock-presence-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('inspectZellijSessionSocketPresence', () => {
  it('reports absent when the socket directory does not exist (server gone)', async () => {
    const socketDir = join(await makeSocketDir(), 'never-created');
    expect(await inspectZellijSessionSocketPresence({ socketDir, sessionName: 'happier-x' })).toBe('absent');
  });

  it('reports absent when no contract-version subdir holds a socket for the session', async () => {
    const socketDir = await makeSocketDir();
    await mkdir(join(socketDir, 'contract_version_1'), { recursive: true });
    // A different session's socket exists, but not ours.
    await writeFile(join(socketDir, 'contract_version_1', 'happier-other'), '');
    expect(await inspectZellijSessionSocketPresence({ socketDir, sessionName: 'happier-gone' })).toBe('absent');
  });

  it('reports present when a socket for the session exists under a contract subdir', async () => {
    const socketDir = await makeSocketDir();
    const contractDir = join(socketDir, 'contract_version_1');
    await mkdir(contractDir, { recursive: true });
    const sessionName = 'happier-live';
    await writeFile(join(contractDir, sessionName), '');
    expect(await inspectZellijSessionSocketPresence({ socketDir, sessionName })).toBe('present');
  });

  it('ignores the action-slot sibling directory when searching for the session socket', async () => {
    const socketDir = await makeSocketDir();
    await mkdir(join(socketDir, '.happier-action-slots'), { recursive: true });
    await mkdir(join(socketDir, 'contract_version_1'), { recursive: true });
    await writeFile(join(socketDir, 'contract_version_1', 'happier-present'), '');
    expect(await inspectZellijSessionSocketPresence({ socketDir, sessionName: 'happier-present' })).toBe('present');
    expect(await inspectZellijSessionSocketPresence({ socketDir, sessionName: 'happier-missing' })).toBe('absent');
  });

  it('does not claim death when presence cannot be determined', async () => {
    // Empty session name is not a determinable target.
    const socketDir = await makeSocketDir();
    expect(await inspectZellijSessionSocketPresence({ socketDir, sessionName: '' })).toBe('unknown');
  });
});
