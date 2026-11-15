import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import type { BrowserSidecarCdpControlTransport } from '../sidecar/controlAdapter';
import { createProductBrowserSidecarControlAdapterFactory } from '../sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '../sidecar/launchOwner';

const fixtureSource = new URL('../../../../../../packages/tests/src/testkit/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

function createProfileRuntime(profiles: ReturnType<typeof createBrowserProfileStore>, transport: BrowserSidecarCdpControlTransport) {
  return createProductBrowserSidecarControlAdapterFactory({ platform: 'linux', profileStore: profiles,
    resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
      discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
        pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
    createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
      // Chromium processes and CDP are the only substituted boundaries.
      spawnProcess: () => {
        const child = new EventEmitter();
        const stderr = new PassThrough();
        return Object.assign(child, { pid: 84, stderr, stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
          kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
      },
      connectTransport: async () => ({ transport }),
    }),
  })({ machineId: 'machine' });
}

it.each([false, true])('retains the logical view through a real profile restart and closes only on failure (%s)', async failReplacement => {
  const root = await mkdtemp(join(tmpdir(), 'happier-profile-replacement-'));
  const profiles = createBrowserProfileStore({ storageRootDirectory: root,
    partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
  await profiles.registerPersistentProfile({ profileId: 'work', displayName: 'Work', storageMode: 'user', owner: { kind: 'user', id: 'work' } });
  let opens = 0;
  let releaseOpen!: () => void;
  let enteredOpen!: () => void;
  const pendingOpen = new Promise<void>(resolve => { releaseOpen = resolve; });
  const opening = new Promise<void>(resolve => { enteredOpen = resolve; });
  const runtime = await createProfileRuntime(profiles, {
    openPage: async () => {
      if (++opens === 3) { enteredOpen(); await pendingOpen; if (failReplacement) throw new Error('CDP open failed'); }
      return { targetId: `page-${opens}`, sessionId: 'cdp' };
    }, dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({ success: true }),
  });
  if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed Browser fixture unavailable');
  try {
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(runtime.adapter);
    const control = createBrowserDaemonControlRoutes({ broker, profiles });
    const target = { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } as const;
    for (const viewId of ['view', 'other']) expect(await control.dispatchCommand({ kind: 'openView', commandId: `initial-${viewId}`,
      browserSessionId: 'session', viewId, platform: 'web', target })).toMatchObject({ status: 'dispatched' });
    const observed: import('@happier-dev/protocol').BrowserEventV1[] = [];
    runtime.contextCapture.subscribeBrowserEvents?.(event => observed.push(event));
    const daemon = createBrowserDaemonRuntimeActionExecutor({ control, featureGate: { isEnabled: () => true, refresh: async () => {} } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: daemon }));
    const selected = executor.execute('browser.profile.select', { machineId: 'machine', kind: 'openView', commandId: 'select',
      browserSessionId: 'session', viewId: 'view', platform: 'web', target, profileId: 'work' },
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account',
      defaultSessionId: 'session', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
    await opening;
    expect.soft(observed.filter(event => event.kind === 'viewClosed').map(event => event.viewId)).toEqual(['other']);
    expect.soft(control.listViews('session').map(view => view.viewId)).toEqual(['view']);
    releaseOpen();
    const result = await selected;
    if (failReplacement) {
      expect(result).toMatchObject({ ok: false, errorCode: 'adapter_unavailable' });
      expect(control.listViews('session')).toEqual([]);
      expect(observed.filter(event => event.kind === 'viewClosed').map(event => event.viewId)).toEqual(['other', 'view']);
    } else {
      expect(result).toMatchObject({ ok: true, result: { status: 'dispatched', events: expect.arrayContaining([
        expect.objectContaining({ kind: 'sessionCreated', profileId: 'work' }),
        expect.objectContaining({ kind: 'viewOpened', viewId: 'view' }),
      ]) } });
      expect(control.listViews('session')).toMatchObject([{ viewId: 'view', events: expect.arrayContaining([
        expect.objectContaining({ kind: 'sessionCreated', profileId: 'work' }),
      ]) }]);
      expect(observed.filter(event => event.kind === 'viewClosed').map(event => event.viewId)).toEqual(['other']);
    }
  } finally { releaseOpen(); await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
});

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

it('refuses profile replacement without a process owner and keeps the original CDP view', async () => {
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
    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_command' });
    expect(control.listViews('session')).toMatchObject([{ viewId: 'view', target }]);
  } finally { adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('selects a saved profile through the process replacement owner and preserves refusal and failure outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-profile-select-'));
  let dispose: (() => void | Promise<void>) | undefined;
  try {
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    await profiles.registerPersistentProfile({ profileId: 'work', storageMode: 'user', owner: { kind: 'user', id: 'work' } });
    const target = { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } as const;
    let openUnavailable = false;
    const runtime = await createProfileRuntime(profiles, {
      openPage: async () => { if (openUnavailable) throw new Error('CDP open unavailable'); return { targetId: 'page' }; },
      dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({ success: true }),
    });
    if (!runtime.ok) throw new Error('Managed Browser fixture unavailable');
    dispose = runtime.dispose;
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(runtime.adapter);
    const control = createBrowserDaemonControlRoutes({ broker, profiles });
    const views = () => control.listViews('session');
    await control.dispatchCommand({ kind: 'openView', commandId: 'initial', browserSessionId: 'session', viewId: 'old', platform: 'web', target });
    let sidecarEnabled = true;
    const daemon = createBrowserDaemonRuntimeActionExecutor({ control,
      featureGate: { isEnabled: feature => feature !== 'browser.sidecar' || sidecarEnabled, refresh: async () => {} } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: daemon }));
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'account', defaultSessionId: 'session', externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
    const request = { machineId: 'machine', kind: 'openView', commandId: 'select', browserSessionId: 'session',
      viewId: 'old', platform: 'web', target, profileId: 'missing' } as const;
    expect(await executor.execute('browser.profile.select', request, context)).toMatchObject({ ok: true,
      result: { status: 'unavailable', code: 'profile_not_found' } });
    expect(views().map(view => view.viewId)).toEqual(['old']);
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work', viewId: 'absent' }, context))
      .toMatchObject({ ok: false, errorCode: 'view_not_found' });
    expect(views().map(view => view.viewId)).toEqual(['old']);
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work', engineOverride: 'embedded' }, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_command' });
    expect(views().map(view => view.viewId)).toEqual(['old']);
    sidecarEnabled = false;
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work' }, context))
      .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(views().map(view => view.viewId)).toEqual(['old']);
    sidecarEnabled = true;
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work',
      target: { kind: 'streamedBrowser', targetId: views()[0]!.sourceId, streamId: views()[0]!.sourceId,
        daemonView: { browserSessionId: 'session', viewId: 'old' } } }, context))
      .toMatchObject({ ok: true, result: { status: 'dispatched' } });
    expect(runtime.contextCapture?.resolveProfile?.({ browserSessionId: 'session', viewId: 'old' })).toMatchObject({ profileId: 'work' });
    expect(views()[0]?.target).toEqual(target);
    expect(views().map(view => view.viewId)).toEqual(['old']);
    openUnavailable = true;
    expect(await executor.execute('browser.profile.select', { ...request, profileId: 'work' },
      { ...context, actionRequestId: 'profile-sandbox-request' })).toMatchObject({ ok: false,
      errorCode: 'adapter_unavailable', requestId: 'profile-sandbox-request',
      failureCause: { phase: 'browser.profile.select', errorCode: 'adapter_unavailable' } });
    expect(views()).toEqual([]);
  } finally { await dispose?.(); await rm(root, { recursive: true, force: true }); }
});
