import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserExtensionService } from '../extensions/service';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';

const fixtureSource = new URL('../../../../../../packages/tests/src/testkit/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

describe('browser extension runtime dispatch', () => {
  it('requires agent approval before transport and persists one approved install through the real daemon owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-action-'));
    try {
      const directory = join(root, 'unpacked');
      await mkdir(directory);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3,
        name: 'Approved local fixture', version: '1.0', permissions: ['storage'] }));
      const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
      const profileStore = createStore();
      const daemonExecute = createBrowserDaemonRuntimeActionExecutor({
        control: createBrowserDaemonControlRoutes({ broker: createBrowserDaemonControlBroker(),
          extensions: createBrowserExtensionService({ profileStore }) }),
        featureGate: { isEnabled: () => true, refresh: async () => {} },
      });
      let runtimeDispatches = 0;
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        // Count the runtime transport port while keeping the daemon and domain owners real.
        runtimeActionExecute: async args => { runtimeDispatches++; return daemonExecute(args); },
      }));
      const input = { machineId: 'machine', profileId: 'personal', source: { kind: 'unpacked', directory },
        reviewedPermissions: { version: '1.0', permissions: ['storage'], hostPermissions: [] } };
      const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'home', runtimeAccountId: 'account', defaultSessionId: 'session',
        externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
      expect(await executor.execute('browser.extensions.install', input, context))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(runtimeDispatches).toBe(0);
      expect(await profileStore.loadPersistentProfile('personal')).toBeNull();

      expect(await executor.execute('browser.extensions.install', input, { ...context,
        surface: 'ui', authority: 'present_user', bypassApprovals: true }))
        .toMatchObject({ ok: true, result: { status: 'updated', entry: { profileId: 'personal',
          extension: { name: 'Approved local fixture', version: '1.0', enabled: true } } } });
      expect(runtimeDispatches).toBe(1);
      const reopenedStore = createStore();
      expect(await reopenedStore.loadPersistentProfile('personal')).toMatchObject({ profileId: 'personal' });
      expect(await reopenedStore.listExtensions('personal')).toMatchObject({ ok: true, extensions: [{
        id: expect.stringMatching(/^[a-p]{32}$/), name: 'Approved local fixture', version: '1.0', enabled: true,
        permissions: ['storage'], source: { kind: 'unpacked', directory },
      }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports an unavailable installed extension owner through the existing browser control family', async () => {
    const parsedId = ActionIdSchema.safeParse('browser.extensions.list');
    expect(parsedId.success).toBe(true);
    if (!parsedId.success) return;
    const actionId = 'browser.extensions.list';
    const execute = createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker: createBrowserDaemonControlBroker() }),
      featureGate: { isEnabled: () => true, refresh: async () => {} },
    });
    expect(await execute({ actionId, input: { machineId: 'machine' }, context: {} }))
      .toEqual({ status: 'unavailable', code: 'managed_browser_required' });
    expect(await execute({ actionId, input: { machineId: '' }, context: {} }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
});
