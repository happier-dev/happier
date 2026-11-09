import { createNativeSoftwareOsFixture } from './nativeSoftwareOs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createDarwinMachineVitalsReader } from '@/daemon/vitals/readers/darwin';
import { createWindowsMachineVitalsReader } from '@/daemon/vitals/readers/windows';
import { nativeVitalsOutputFixture } from '@/daemon/vitals/readers/native.testkit';
import { createInstalledDaemonMountInventory } from '@/daemon/testkit/installedDaemonMounts.testkit';

it.runIf(process.platform === 'linux')('keeps installed daemon mount ownership inside its temporary Home', async () => {
  const fixture = await createNativeSoftwareOsFixture({ manager: 'apt' });
  const mounts = await createInstalledDaemonMountInventory(fixture.directory);
  onTestFinished(async () => { await mounts.dispose(); await fixture.dispose(); });
  const result = await createLinuxMachineVitalsReader().read({ sampledAt: Date.now(), monotonicMs: 0,
    intervalMs: 2000, overviewExtras: false });
  expect(result.state).toBe('reporting');
  if (result.state !== 'reporting') throw new Error('Native reader did not consume its OS fixture');
  expect(result.sample.disk).toMatchObject({ reported: true, volumes: [{ mount: fixture.directory }] });
});

it.runIf(process.platform === 'linux').each(['darwin', 'win32'] as const)(
  'scopes the constructed %s native-provider inventory without changing its refusal', async platform => {
    const fixture = await createNativeSoftwareOsFixture({ manager: 'apt' });
    const executablePath = join(fixture.directory, 'native-vitals-provider');
    const refusalPath = join(fixture.directory, 'refuse-native-vitals');
    // The external provider is a real finite OS process; the reader's strict
    // parser/accounting and the installed fixture's process adapter stay real.
    await writeFile(executablePath, `#!${process.execPath}\n`
      + `import { existsSync } from 'node:fs';\n`
      + `if (process.argv[2] !== 'vitals-sample' || existsSync(${JSON.stringify(refusalPath)})) process.exit(17);\n`
      + `process.stdout.write(${JSON.stringify(nativeVitalsOutputFixture(0))});\n`, { mode: 0o755 });
    const mounts = await createInstalledDaemonMountInventory(fixture.directory, platform);
    onTestFinished(async () => { await mounts.dispose(); await fixture.dispose(); });
    const reader = platform === 'darwin' ? createDarwinMachineVitalsReader({ executablePath })
      : createWindowsMachineVitalsReader({ executablePath });
    const input = { sampledAt: Date.now(), monotonicMs: 0, intervalMs: 2000, overviewExtras: false };
    const result = await reader.read(input);
    expect(result.state).toBe('reporting');
    if (result.state !== 'reporting') throw new Error('Native provider fixture was not consumed');
    expect(result.sample.disk).toMatchObject({ reported: true, volumes: [{ mount: fixture.directory }] });
    expect(result.sample.memory).toMatchObject({ reported: true, totalBytes: 32_000, availableBytes: 10_000 });
    expect(result.sample.network).toMatchObject({ reported: true, interfaces: [
      { id: '1', label: 'Ethernet' }, { id: '2', label: 'VPN' },
    ] });

    await writeFile(refusalPath, 'refuse');
    expect(await reader.read({ ...input, sampledAt: input.sampledAt + 2000, monotonicMs: 2000 }))
      .toEqual({ state: 'unavailable', reason: 'helper_failing' });
  },
);
