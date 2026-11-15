import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, FeaturesResponseSchema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserExtensionService } from '../extensions/service';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createConfiguredBrowserProfileStore } from '../profiles/configuredStore';
import { createBrowserRoutePublication } from '../control/routePublication';
import type { BrowserDaemonControlRoutes } from '../control/routes';
import { createProductBrowserSidecarControlAdapterFactory } from '../sidecar/productSource';
import { createDaemonSessionMutationCustody } from '../../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { withConfiguredDaemonTestHome } from '../../testkit/fakeDaemonLifecycle.testkit';

const fixtureSource = new URL('../../../../../../packages/tests/src/testkit/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

describe('browser extension runtime dispatch', () => {
  it('publishes stored extension and profile reads without a managed executable while runtime operations stay unavailable', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'browser-storage-without-runtime-' }, async () => {
      const seed = createConfiguredBrowserProfileStore();
      await seed.registerPersistentProfile({ profileId: 'saved', displayName: 'Saved', storageMode: 'user',
        owner: { kind: 'user', id: 'owner' } });
      const extension = { id: 'a'.repeat(32), name: 'Saved extension', version: '1', enabled: true,
        source: { kind: 'unpacked' as const, directory: '/fixture' }, directory: '/fixture/package',
        permissions: [], hostPermissions: [], actionPopup: 'popup.html' };
      await seed.setExtension('saved', extension);
      // The test home has no installed package. Use the real filesystem resolver,
      // binary-source policy, route publication and Action dispatcher throughout.
      expect(await createProductBrowserSidecarControlAdapterFactory({})({ machineId: 'machine' }))
        .toMatchObject({ ok: false, errorCode: 'managed_package_missing' });
      const credentials = { token: 'fixture', encryption: null } as const;
      const features = FeaturesResponseSchema.parse({ features: { browser: { enabled: true,
        viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } } });
      let control: BrowserDaemonControlRoutes | undefined;
      const publications: BrowserDaemonControlRoutes[] = [];
      const publication = createBrowserRoutePublication({ params: {
        machineId: 'machine', credentials, serverBaseUrl: 'http://127.0.0.1:3030', processEnv: {},
        getApiMachineForSessions: () => null,
        daemonSessionMutationCustody: createDaemonSessionMutationCustody({ credentials }),
        onBrowserControlRoutesReady: routes => { publications.push(routes); },
      }, runtimeActionRouteProviderTarget: { setBrowserDaemonControlRoutesProvider: provider => { control = provider?.() ?? undefined; } },
        readSessionAccountId: () => 'owner', setGuardBrowserResourceOwner: () => {},
        shutdownSignal: new AbortController().signal, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
      const execute = createBrowserDaemonRuntimeActionExecutor({ resolveControl: () => control,
        featureGate: { isEnabled: () => true, refresh: async () => {} } });
      try {
        await publication.refreshBrowserRouteOwners();
        expect(await execute({ actionId: 'browser.extensions.list', input: { machineId: 'machine' }, context: {} }))
          .toMatchObject({ status: 'ready', entries: [{ profileId: 'saved', extension }], profiles: [{ profileId: 'saved', displayName: 'Saved' }] });
        expect(await execute({ actionId: 'browser.profile.list', input: { machineId: 'machine' }, context: {} }))
          .toMatchObject({ status: 'ready', profiles: [{ profileId: 'saved', displayName: 'Saved' }] });
        expect(await execute({ actionId: 'browser.profile.create', input: { machineId: 'machine',
          profileId: 'created-without-runtime' }, context: {} }))
          .toMatchObject({ status: 'created', profile: { profileId: 'created-without-runtime' } });
        expect(await execute({ actionId: 'browser.profile.delete', input: { machineId: 'machine',
          profileId: 'created-without-runtime' }, context: {} }))
          .toEqual({ status: 'deleted', profileId: 'created-without-runtime' });
        expect(await execute({ actionId: 'browser.view.list', input: { machineId: 'machine',
          browserSessionId: 'session' }, context: {} })).toEqual({ protocolVersion: 1, views: [] });
        expect(await execute({ actionId: 'browser.extensions.openActionPopup', input: { machineId: 'machine',
          browserSessionId: 'session', viewId: 'popup', profileId: 'saved', extensionId: extension.id, commandId: 'popup' }, context: {} }))
          .toEqual({ status: 'unavailable', code: 'managed_browser_required' });
        // A settled refresh neither republishes the storage owner nor launches a browser.
        await publication.refreshBrowserRouteOwners();
        expect(publications).toHaveLength(1);
      } finally { await publication.dispose(); }
    });
  });

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
      await reopenedStore.registerPersistentProfile({ profileId: 'empty', storageMode: 'user',
        owner: { kind: 'user', id: 'person' }, displayName: 'Empty profile' });
      expect(await executor.execute('action.options.resolve', { actionId: 'browser.extensions.install',
        fieldPath: 'profileId', draftInput: { machineId: 'machine' } }, { ...context,
        surface: 'ui', authority: 'present_user' }))
        .toMatchObject({ ok: true, result: { options: expect.arrayContaining([
          { value: 'personal', label: 'personal' }, { value: 'empty', label: 'Empty profile' },
        ]) } });
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
