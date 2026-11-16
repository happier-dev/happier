import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createActionExecutor, MachineLiveStreamStartRequestV1Schema, type ActionExecutorDeps, type MachineLiveStreamReceiptV1 } from '@happier-dev/protocol';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonViewDiscovery } from '../control/viewDiscovery';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import type { BrowserSidecarCdpControlTransport } from '../sidecar/controlAdapter';
import { createProductBrowserSidecarControlAdapterFactory } from '../sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '../sidecar/launchOwner';
import { createBrowserCdpScreencastProducer } from '../capture/cdpScreencast';
import { registerBrowserLiveCapture } from '../capture/registration';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createDaemonMachineLiveStreamCaptureAdapter, type MachineLiveStreamCaptureSession } from '../../peer/mediation/stream/captureAdapter';
import { BrowserEventBatchV1Schema, type BrowserEventBatchV1 } from '@happier-dev/protocol/browser/events/v1';

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
      connectTransport: async () => {
        const subscriptions = new Set<() => void>();
        return { transport: { ...transport, ...(transport.subscribeCdpEvents ? { subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
          const unsubscribe = transport.subscribeCdpEvents!(listener);
          subscriptions.add(unsubscribe);
          return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
        } } : {}) }, dispose: () => { for (const unsubscribe of subscriptions) unsubscribe(); subscriptions.clear(); } };
      },
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
  const cdpListeners = new Set<BrowserSidecarCdpEventSubscriber>();
  const commands: Array<{ targetId: string; method: string }> = [];
  const runtime = await createProfileRuntime(profiles, {
    openPage: async () => {
      if (++opens === 3) { enteredOpen(); await pendingOpen; if (failReplacement) throw new Error('CDP open failed'); }
      return { targetId: `page-${opens}`, sessionId: 'cdp' };
    }, dispatchPageCommand: async command => {
      commands.push(command);
      return command.method === 'Runtime.evaluate' ? { result: { value: { editable: true, inputMode: 'text', multiline: false, secret: false } } } : {};
    },
    dispatchBrowserCommand: async () => ({ success: true }),
    subscribeCdpEvents: listener => { cdpListeners.add(listener); return () => { cdpListeners.delete(listener); }; },
  });
  if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed Browser fixture unavailable');
  const view = { browserSessionId: 'session', viewId: 'view' };
  const producer = createBrowserCdpScreencastProducer({ contextCapture: runtime.contextCapture });
  const registry = createMachineLiveStreamCaptureRegistry();
  const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
    transport: createControlAdapterAutomationTransport({ adapter: runtime.adapter, contextCapture: runtime.contextCapture }),
  }) });
  // Production installs the broker listener before capture registration.
  const broker = createBrowserDaemonControlBroker();
  broker.registerAdapter(runtime.adapter);
  const registration = registerBrowserLiveCapture({ registry, contextCapture: runtime.contextCapture, producer, automation: () => automation });
  const watchAbort = new AbortController();
  let inputSession: MachineLiveStreamCaptureSession | undefined;
  try {
    const control = createBrowserDaemonControlRoutes({ broker, profiles });
    const target = { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } as const;
    for (const viewId of ['view', 'other']) expect(await control.dispatchCommand({ kind: 'openView', commandId: `initial-${viewId}`,
      browserSessionId: 'session', viewId, platform: 'web', target })).toMatchObject({ status: 'dispatched' });
    const source = registry.resolve({ sourceId: browserViewKey(view) });
    if (!source.ok) throw new Error('Live Browser source missing');
    const frames: string[][] = [[], []];
    const errors: unknown[] = [];
    for (const received of frames) expect(await producer.start({ view, purpose: 'humanViewer',
      onFrame: frame => received.push(frame.dataBase64), onError: error => errors.push(error) })).not.toBeNull();
    const emitFrame = (data: string) => { for (const listener of [...cdpListeners]) listener({ method: 'Page.screencastFrame',
      sessionId: 'cdp', params: { sessionId: 1, data, metadata: { deviceWidth: 1280, deviceHeight: 800 } } }); };
    emitFrame('before');
    expect(frames).toEqual([['before'], ['before']]);
    const receipts: MachineLiveStreamReceiptV1[] = [];
    const metadata: BrowserEventBatchV1[] = [];
    const streamId = 'profile-viewer';
    const sourceId = browserViewKey(view);
    const startRequest = MachineLiveStreamStartRequestV1Schema.parse({ v: 1, streamId, sourceId,
      streamFamily: 'browser.streamed', sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'loopback_direct' });
    const startInputStream = () => createDaemonMachineLiveStreamCaptureAdapter(registry).start({ streamId,
      callerAuthority: 'present_user', startRequest, streamFamily: 'browser.streamed', sourceMachineId: 'machine',
      targetMachineId: 'viewer', caps: {}, startedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, nowMs: Date.now,
      applyControl: () => ({ ok: true }), emitReceipt: receipt => receipts.push(receipt), offerFrame: frame => {
        if (frame.payloadKind === 'metadata') metadata.push(BrowserEventBatchV1Schema.parse(JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8'))));
        return { ok: true };
      } });
    const inputStream = await startInputStream();
    if (!inputStream.ok) throw new Error(inputStream.reasonCode);
    inputSession = inputStream.session;
    const observed: import('@happier-dev/protocol').BrowserEventV1[] = [];
    runtime.contextCapture.subscribeBrowserEvents?.(event => observed.push(event));
    const daemon = createBrowserDaemonRuntimeActionExecutor({ control, featureGate: { isEnabled: () => true, refresh: async () => {} } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: daemon }));
    const selected = executor.execute('browser.profile.select', { machineId: 'machine', kind: 'openView', commandId: 'select',
      browserSessionId: 'session', viewId: 'view', platform: 'web', target, profileId: 'work' },
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account',
      defaultSessionId: 'session', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
    await opening;
    // A profile change preserves the logical tab but retires its admitted media occurrence.
    expect.soft(source.source.retirementSignal?.aborted).toBe(true);
    expect.soft(errors).toHaveLength(2);
    expect.soft(observed.filter(event => event.kind === 'viewClosed').map(event => event.viewId)).toEqual(['other']);
    expect.soft(control.listViews('session').map(view => view.viewId)).toEqual(['view']);
    const discovery = createBrowserDaemonViewDiscovery({ broker, captureRegistry: registry });
    let replacementSnapshot: Awaited<ReturnType<typeof discovery.watchViews>> | undefined;
    const watched = discovery.watchViews({ browserSessionId: 'session', knownViewIds: ['view'], signal: watchAbort.signal })
      .then(views => { replacementSnapshot = views; }).catch(error => { if (!watchAbort.signal.aborted) throw error; });
    releaseOpen();
    const result = await selected;
    if (failReplacement) {
      expect(result).toMatchObject({ ok: false, errorCode: 'adapter_unavailable' });
      expect(control.listViews('session')).toEqual([]);
      expect(observed.filter(event => event.kind === 'viewClosed').map(event => event.viewId)).toEqual(['other', 'view']);
      expect(source.source.retirementSignal?.aborted).toBe(true);
      expect(errors).toHaveLength(2);
    } else {
      expect(result).toMatchObject({ ok: true, result: { status: 'dispatched', events: expect.arrayContaining([
        expect.objectContaining({ kind: 'sessionCreated', profileId: 'work' }),
        expect.objectContaining({ kind: 'viewOpened', viewId: 'view' }),
      ]) } });
      expect(control.listViews('session')).toMatchObject([{ viewId: 'view', events: expect.arrayContaining([
        expect.objectContaining({ kind: 'sessionCreated', profileId: 'work' }),
      ]) }]);
      expect(observed.filter(event => event.kind === 'viewClosed').map(event => event.viewId)).toEqual(['other']);
      const replacementSource = registry.resolve({ sourceId });
      if (!replacementSource.ok) throw new Error('Replacement Browser source missing');
      expect(replacementSource.source.sourceOccurrenceId).not.toBe(source.source.sourceOccurrenceId);
      expect(replacementSource.source.retirementSignal?.aborted).toBe(false);
      await expect.poll(() => replacementSnapshot).toMatchObject([{ viewId: 'view',
        sourceOccurrenceId: replacementSource.source.sourceOccurrenceId }]);
      await watched;
      emitFrame('not-admitted');
      expect(frames).toEqual([['before'], ['before']]);
      for (const received of frames) expect(await producer.start({ view, purpose: 'humanViewer',
        onFrame: frame => received.push(frame.dataBase64), onError: error => errors.push(error) })).not.toBeNull();
      await inputSession.stop();
      const replacementInput = await startInputStream();
      if (!replacementInput.ok) throw new Error(replacementInput.reasonCode);
      inputSession = replacementInput.session;
      emitFrame('after');
      expect(frames).toEqual([['before', 'after'], ['before', 'after']]);
      expect(errors).toHaveLength(2);
      for (const event of [{ kind: 'viewport', target: 'page', sequence: 1, width: 390, height: 844, deviceScaleFactor: 2 },
        { kind: 'editableProbe', target: 'page', sequence: 2, x: 0.5, y: 0.5 }] as const) {
        expect(inputSession.applySidebandControl?.({ v: 1, kind: 'browser_input', sourceId, streamId,
          eventId: `replacement:${event.kind}`, controlEpoch: automation.getStatus(view).controlEpoch, event })).toEqual({ ok: true });
      }
      await expect.poll(() => commands.some(command => command.targetId === 'page-3' && command.method === 'Emulation.setDeviceMetricsOverride')).toBe(true);
      await expect.poll(() => metadata.some(batch => batch.editableTarget?.editable === true)).toBe(true);
      expect(receipts.filter(receipt => receipt.reasonCode === 'human_input_failed')).toEqual([]);
      expect(await control.dispatchCommand({ kind: 'closeView', commandId: 'close-selected', ...view })).toMatchObject({ status: 'dispatched' });
      expect(replacementSource.source.retirementSignal?.aborted).toBe(true);
      expect(errors).toHaveLength(4);
    }
  } finally { watchAbort.abort(); releaseOpen(); await inputSession?.stop(); registration.dispose(); await producer.dispose(); automation.dispose(); await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
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
