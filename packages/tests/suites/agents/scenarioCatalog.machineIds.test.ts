import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveMachineRegistrationPath } from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';
import { readDaemonMachineIds } from '../../src/testkit/uiE2e/daemonMachineId';

describe('daemon Machine registration discovery', () => {
  it('prefers the active Home and ignores a different Account at that Home', async () => {
    const cliHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-machines-'));
    try {
      const settingsPath = join(cliHomeDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ activeServerId: 'home-active' }));
      const serversDir = join(cliHomeDir, 'servers');
      const fixtures = {
        'a-other': { machineId: 'other-home-machine' },
        'home-active': { accountId: 'current', machineIdByAccountId: {
          current: 'active-home-machine', previous: 'previous-account-machine',
        } },
      };
      for (const [serverId, registration] of Object.entries(fixtures)) {
        const path = resolveMachineRegistrationPath(serversDir, serverId);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(registration));
      }
      expect(await readDaemonMachineIds(settingsPath)).toEqual(['active-home-machine', 'other-home-machine']);
    } finally {
      await rm(cliHomeDir, { recursive: true, force: true });
    }
  });
});
