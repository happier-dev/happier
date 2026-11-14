import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import type { BrowserDaemonViewV1 } from '@happier-dev/protocol';

const fixtureSource = new URL('../../../../../../packages/tests/src/testkit/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

it('refuses an explicitly embedded browser open on the managed daemon before provisioning', async () => {
  let provisioned = false;
  const daemon = createBrowserDaemonRuntimeActionExecutor({
    featureGate: { isEnabled: () => true, refresh: async () => {} },
    provisionAutomationRuntime: async () => { provisioned = true; return 'ready'; },
  });
  expect(await daemon({ actionId: 'browser.view.open', input: {
    kind: 'openView', commandId: 'embedded', browserSessionId: 'session', viewId: 'view', platform: 'web',
    target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' }, engineOverride: 'embedded',
  }, context: {} })).toMatchObject({ status: 'failed', error: { code: 'unsupported_command' } });
  expect(provisioned).toBe(false);
});

it('creates and deletes saved profiles through admitted Actions and retains them across store reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-profile-action-'));
  try {
    const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const profiles = createStore();
    const daemon = createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker: createBrowserDaemonControlBroker(), profiles }),
      featureGate: { isEnabled: () => true, refresh: async () => {} },
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: daemon }));
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'account',
      externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
    const request = { machineId: 'machine', profileId: 'work', displayName: 'Work' };
    for (const profileId of ['../escape', 'CON']) {
      expect(await executor.execute('browser.profile.create', { ...request, profileId }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(await executor.execute('browser.profile.create', request, { ...context,
      surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await profiles.listPersistentProfiles()).toEqual([]);
    expect(await executor.execute('browser.profile.create', request, context)).toMatchObject({ ok: true,
      result: { status: 'created', profile: { profileId: 'work', displayName: 'Work', storageMode: 'user' } } });
    expect(await createStore().listPersistentProfiles()).toMatchObject([{ profileId: 'work', displayName: 'Work' }]);
    expect(await executor.execute('browser.profile.create', { ...request, displayName: 'Overwrite' }, context))
      .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'profile_exists' } });
    expect(await executor.execute('browser.profile.list', { machineId: 'machine' }, context)).toMatchObject({ ok: true,
      result: { status: 'ready', profiles: [{ profileId: 'work', displayName: 'Work' }] } });
    expect(await executor.execute('browser.profile.delete', { machineId: 'machine', profileId: 'work' }, context))
      .toMatchObject({ ok: true, result: { status: 'deleted', profileId: 'work' } });
    expect(await createStore().listPersistentProfiles()).toEqual([]);
    expect(await executor.execute('browser.profile.delete', { machineId: 'machine', profileId: 'work' }, context))
      .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'profile_not_found' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reopens the selected profile in the Action receipt after closing its previous logical view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-profile-reopen-'));
  const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'session', sidecarId: 'sidecar',
    // CDP is the process boundary; profile Actions, broker and view publication remain real.
    transport: { openPage: async () => ({ targetId: 'page' }), dispatchPageCommand: async () => ({}),
      dispatchBrowserCommand: async () => ({ success: true }) } });
  try {
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    await profiles.registerPersistentProfile({ profileId: 'work', storageMode: 'user', owner: { kind: 'user', id: 'work' } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const control = createBrowserDaemonControlRoutes({ broker, profiles });
    const target = { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } as const;
    await control.dispatchCommand({ kind: 'openView', commandId: 'initial', browserSessionId: 'session',
      viewId: 'view', platform: 'web', target });
    const daemon = createBrowserDaemonRuntimeActionExecutor({ control,
      featureGate: { isEnabled: () => true, refresh: async () => {} } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: daemon }));
    const result = await executor.execute('browser.profile.select', { machineId: 'machine', kind: 'openView',
      commandId: 'select', browserSessionId: 'session', viewId: 'view', platform: 'web', target, profileId: 'work' },
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'account', defaultSessionId: 'session', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
    expect(result).toMatchObject({ ok: true, result: { status: 'dispatched', events: expect.arrayContaining([
      expect.objectContaining({ kind: 'viewClosed', browserSessionId: 'session', viewId: 'view' }),
      expect.objectContaining({ kind: 'viewOpened', browserSessionId: 'session', viewId: 'view', target,
        adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface' }),
    ]) } });
  } finally { adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('selects a saved profile through the existing close/open owner and leaves views intact for a missing profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-profile-select-'));
  try {
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    await profiles.registerPersistentProfile({ profileId: 'work', storageMode: 'user', owner: { kind: 'user', id: 'work' } });
    const target = { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } as const;
    let views: BrowserDaemonViewV1[] = [{ browserSessionId: 'session', viewId: 'old', sourceId: 'source', target,
      platform: 'web', adapterKind: 'chromiumSidecar', events: [] }];
    let selectedProfile: string | undefined;
    let sandboxUnavailable = false;
    const broker = createBrowserDaemonControlBroker();
    // Substitute the browser process boundary; catalog, admission, routes, broker and profile store stay real.
    broker.registerAdapter({ adapterKind: 'chromiumSidecar', supportsOpenView: command => command.target.kind === 'externalUrl',
      ownsView: view => views.some(candidate => candidate.viewId === view.viewId), listViews: () => views,
      dispatchCommand: command => {
        if (command.kind === 'closeView') views = views.filter(view => view.viewId !== command.viewId);
        if (command.kind === 'openView') {
          if (views.length > 0) throw new Error('Previous profile still owns a view.');
          if (sandboxUnavailable) return { v: 1, commandId: command.commandId, status: 'failed',
            error: { code: 'sandbox_unavailable', message: 'Managed Chromium sandbox is unavailable.' } };
          selectedProfile = command.profileId;
          views = [{ browserSessionId: command.browserSessionId, viewId: command.viewId,
            sourceId: 'source', target: command.target, platform: command.platform, adapterKind: 'chromiumSidecar', events: [] }];
        }
        return { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] };
      } });
    let sidecarEnabled = true;
    const daemon = createBrowserDaemonRuntimeActionExecutor({ control: createBrowserDaemonControlRoutes({ broker, profiles }),
      featureGate: { isEnabled: feature => feature !== 'browser.sidecar' || sidecarEnabled, refresh: async () => {} } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: daemon }));
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'account', defaultSessionId: 'session', externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
    const request = { machineId: 'machine', kind: 'openView', commandId: 'select', browserSessionId: 'session',
      viewId: 'old', platform: 'web', target, profileId: 'missing' } as const;
    expect(await executor.execute('browser.profile.select', request, context)).toMatchObject({ ok: true,
      result: { status: 'unavailable', code: 'profile_not_found' } });
    expect(views.map(view => view.viewId)).toEqual(['old']);
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work', engineOverride: 'embedded' }, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_command' });
    expect(views.map(view => view.viewId)).toEqual(['old']);
    sidecarEnabled = false;
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work' }, context))
      .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(views.map(view => view.viewId)).toEqual(['old']);
    sidecarEnabled = true;
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work',
      target: { kind: 'streamedBrowser', targetId: 'source', streamId: 'source',
        daemonView: { browserSessionId: 'session', viewId: 'old' } } }, context))
      .toMatchObject({ ok: true, result: { status: 'dispatched' } });
    expect(selectedProfile).toBe('work');
    expect(views[0]?.target).toEqual(target);
    expect(views.map(view => view.viewId)).toEqual(['old']);
    sandboxUnavailable = true;
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work' },
      { ...context, actionRequestId: 'profile-sandbox-request' })).toMatchObject({ ok: false,
      errorCode: 'sandbox_unavailable', requestId: 'profile-sandbox-request',
      failureCause: { phase: 'browser.profile.select', errorCode: 'sandbox_unavailable' } });
    expect(views).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
