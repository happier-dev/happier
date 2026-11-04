import { FeaturesResponseSchema, type BrowserCommandV1 } from '@happier-dev/protocol';
import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';

import { createProductBrowserSidecarControlAdapterFactory } from '../browser/sidecar/productSource';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '../browser/sidecar/launchOwner';
import { createBrowserProfileStore } from '../browser/profiles/store';
import { createBrowserStoragePartitionOwner } from '../browser/storage/partitions';
import { createLinuxVitalsFixture } from '../vitals/readers/linux.testkit';
import { createLinuxMachineVitalsReader } from '../vitals/readers/linux';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { join } from 'node:path';
import type { BrowserDaemonControlRoutes } from '../browser/control/routes';

it('wires canonical effective memory through startup into browser admission', async () => {
  const files = await createLinuxVitalsFixture();
  await files.put('/proc/meminfo', 'MemTotal: 134217728 kB\nMemAvailable: 67108864 kB\n');
  await files.put('/proc/self/mountinfo', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n');
  await files.put('/sys/fs/cgroup/memory.max', String(8 * 1024 ** 3));
  await files.put('/sys/fs/cgroup/memory.current', String(1024 ** 3));
  await files.put('/sys/fs/cgroup/memory.stat', 'inactive_file 0\n');
  const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: files.root }),
    historyStore: await createMinuteHistoryStore({ directory: join(files.root, 'history') }) });
  let startup: Awaited<ReturnType<typeof createAttachedManagedRunFixture>> | undefined;
  const registeredRoutes: { current: BrowserDaemonControlRoutes | null } = { current: null };
  try {
    await sampler.start();
    expect(MachineVitalsSampleV1Schema.parse(sampler.latest()).memory)
      .toMatchObject({ reported: true, totalBytes: 8 * 1024 ** 3, limitSource: 'cgroup' });
    const profiles = createBrowserProfileStore({ storageRootDirectory: files.root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: files.root }), removeDirectory: async () => {} });
    startup = await createAttachedManagedRunFixture({ browserStartup: {
      readMachineMemory: () => sampler.latest()?.memory ?? null,
      onBrowserControlRoutesReady: routes => { registeredRoutes.current = routes; },
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
          sidecar: { enabled: true }, automation: { enabled: true } } },
      }) }),
      browserSidecarControlAdapterFactory: createProductBrowserSidecarControlAdapterFactory({
        featureEnabled: true, profileStore: profiles, autoInstallWhenMissing: false,
        // Managed artifact, child process and CDP are external boundaries. Keep
        // startup, registration, vitals, profile lifecycle and admission real.
        resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
          discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
            pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
          spawnProcess: () => {
            const child = new EventEmitter();
            const stderr = new PassThrough();
            return Object.assign(child, { pid: process.pid, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()], kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
          },
          connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
            dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}) } }),
        }),
      }),
    } });
    await startup.runtime.refreshBrowserRouteOwners();
    const routes = registeredRoutes.current;
    if (!routes) throw new Error('Browser control routes not registered');
    const command = (browserSessionId: string): BrowserCommandV1 => ({ kind: 'openView', commandId: `open_${browserSessionId}`,
      browserSessionId, viewId: 'view', platform: 'web', focus: true,
      target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } });
    expect(await routes.dispatchCommand(command('first'))).toMatchObject({ status: 'dispatched' });
    expect(await routes.dispatchCommand(command('second'))).toMatchObject({ status: 'dispatched' });
    expect(BrowserCommandDispatchResultV1Schema.parse(await routes.dispatchCommand(command('third'))))
      .toMatchObject({ status: 'failed', error: { code: 'waiting_for_memory', retryable: true } });
  } finally { await startup?.cleanup(); await sampler.stop(); await files.cleanup(); }
});
