import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { waitForDaemonMachineIdFromCliSettings } from './daemonMachineId';

const tempDirs: string[] = [];

async function createTempCliHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-ui-e2e-machine-id-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('waitForDaemonMachineIdFromCliSettings', () => {
  it('resolves the active server machine id from CLI settings without requiring daemon state to contain it', async () => {
    const cliHomeDir = await createTempCliHome();
    await mkdir(join(cliHomeDir, 'servers', 'server-one'), { recursive: true });
    await writeFile(
      join(cliHomeDir, 'settings.json'),
      `${JSON.stringify({
        schemaVersion: 5,
        activeServerId: 'server-one',
        machineIdByServerId: {
          'server-one': 'machine-from-settings',
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(cliHomeDir, 'servers', 'server-one', 'daemon.state.json'),
      `${JSON.stringify({ pid: 123, httpPort: 456 })}\n`,
      'utf8',
    );

    await expect(waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 1 })).resolves.toBe(
      'machine-from-settings',
    );
  });
});
