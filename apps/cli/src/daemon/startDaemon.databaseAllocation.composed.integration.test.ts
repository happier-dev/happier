import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { startInstalledDaemonFixture } from './testkit/installedDaemon.composed.testkit';

const pluginId = 'acme.retained-capture';
const filesystem = vi.hoisted(() => ({ capacityAvailable: false, failedProbe: false, recoveredProbe: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: (...args: Parameters<typeof actual.statfs>) => {
      const path = String(args[0]);
      if (basename(path) === 'databases' && basename(dirname(path)) === pluginId) {
        if (!filesystem.capacityAvailable) {
          filesystem.failedProbe = true;
          return Promise.reject(Object.assign(new Error('Filesystem unavailable'), { code: 'EIO' }));
        }
        filesystem.recoveredProbe = true;
      }
      return actual.statfs(...args);
    },
  };
});

it('prepares retained databases after Machine binding and recovers on reconnect', async () => {
  const fixture = await startInstalledDaemonFixture({ plugins: [{
    manifest: createPluginManifestV2Fixture({
      id: pluginId,
      activation: { events: [{ kind: 'startup' }] },
      contributes: {
        daemonDatabases: [{
          id: 'capture',
          migrations: [{ version: 1, id: 'create-events' }],
          incumbentQueryFixtureId: 'events-readable',
          retention: [{ table: 'events', timeColumn: 'at' }],
        }],
        backgroundServices: [{ id: 'writer', title: 'Capture', placement: 'daemon', activation: 'continuous' }],
      },
    }),
    files: { 'daemon.mjs': `
      import { writeFile } from 'node:fs/promises';
      import { basename, dirname, join } from 'node:path';
      const capture = {
        migrations: [{ version: 1, id: 'create-events', async up(tx) {
          await tx.execute('CREATE TABLE events (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
        } }],
        incumbentQueryFixture: { id: 'events-readable', async run(tx) {
          await tx.query('SELECT id FROM events');
        } },
        retention: [{ table: 'events', timeColumn: 'at' }],
      };
      export const daemonDatabases = { capture };
      export function activate(api) {
        api.backgroundServices.register('writer', async context => {
          const marker = join(process.env.HAPPIER_HOME_DIR, 'capture-status.json');
          try {
            const database = await context.services.storage.daemon.database('capture', capture);
            await database.execute('INSERT INTO events VALUES (?, ?)', ['captured', Date.now()]);
            await writeFile(marker, JSON.stringify(await database.query('SELECT id FROM events')));
          } catch (error) {
            await writeFile(marker, JSON.stringify(error.code));
            throw error;
          }
        });
      }
    ` },
  }] });
  const status = async (): Promise<unknown> => JSON.parse(await readFile(join(fixture.homeDirectory, 'capture-status.json'), 'utf8'));
  await vi.waitFor(async () => {
    expect(filesystem.failedProbe).toBe(true);
    expect(await status()).toBe('daemon_database_policy_unavailable');
  }, { timeout: 10_000 });
  const reconnect = await fixture.home.pauseInstalledMachineNetwork();
  filesystem.capacityAvailable = true;
  await reconnect();
  await fixture.home.waitForMachineRpc(fixture.machineId, RPC_METHODS.CAPABILITIES_DESCRIBE);
  await vi.waitFor(async () => {
    expect(filesystem.recoveredProbe).toBe(true);
    expect(await status()).toEqual([{ id: 'captured' }]);
  }, { timeout: 40_000 });
}, 120_000);
