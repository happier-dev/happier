import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createInstalledDaemonMountInventory } from './installedDaemonMounts.testkit';

it.runIf(process.platform === 'linux')('scopes and restores the plain installed daemon filesystem boundary', async () => {
  const homeDirectory = await filesystem.mkdtemp(join(tmpdir(), 'happier-installed-mounts-'));
  const readFile = filesystem.readFile;
  let mounts: Awaited<ReturnType<typeof createInstalledDaemonMountInventory>> | undefined;
  try {
    mounts = await createInstalledDaemonMountInventory(homeDirectory);
    const result = await createLinuxMachineVitalsReader().read({ sampledAt: Date.now(), monotonicMs: 0,
      intervalMs: 2000, overviewExtras: false });
    expect(result.state).toBe('reporting');
    if (result.state !== 'reporting') throw new Error('Native reader did not consume its mount fixture');
    expect(result.sample.disk).toMatchObject({ reported: true, volumes: [{ mount: homeDirectory }] });
  } finally {
    try { await mounts?.dispose(); } finally { await filesystem.rm(homeDirectory, { recursive: true, force: true }); }
  }
  expect(filesystem.readFile).toBe(readFile);
});
