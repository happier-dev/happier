import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';
import type { DaemonLocalServicePreviewOpenOrCreateResponseV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';

const testState = vi.hoisted(() => ({
  machineRpc: vi.fn(),
  previewOpen: vi.fn<(input: unknown) => Promise<unknown>>(),
  previewFetch: vi.fn<RuntimeFetch>(),
  previewToken: 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature',
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const { createTokenStorageModuleMock } =
    await import('@/dev/testkit/mocks/tokenStorage');
  return createTokenStorageModuleMock({ importOriginal });
});

const homes = createHomeGovernanceHarness();
const previewBoundaries = new Map<string, Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>>();

async function addBrowserHome(serverUrl: string) {
  const serverIdentityId = `browser-shell:${new URL(serverUrl).hostname}`;
  const boundary = await createExternalActionAccountHttpBoundary({
    serverUrl, serverIdentityId, accountId: 'viewer-account', machineId: 'machine_1',
    actionId: 'localServices.preview.openOrCreate', tokenEpoch: 0, requesterInvocation: 'none',
    execute: input => testState.previewOpen(input),
    failure: result => {
      const parsed = ActionExecuteFailureSchema.safeParse(result);
      return parsed.success ? parsed.data : null;
    },
  });
  previewBoundaries.set(new URL(serverUrl).origin, boundary);
  const id = await homes.addHome({
    name: 'Browser Home', serverUrl, serverIdentityId, accountId: 'viewer-account', currentAccount: true,
    credentials: { token: testState.previewToken },
  });
  return { id };
}

afterEach(async () => { await homes.reset(); });

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({});
});

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(testState.machineRpc),
);

// Keep the real lazy Action graph, but finish its cold transform after installing
// transport boundaries and before a timed recovery test can leave it in flight.
await import('@/sync/ops/actions/defaultActionExecutor');

const target = {
  kind: 'localServicePreview',
  targetId: 'preview_1',
  sessionId: 'session_1',
  machineId: 'machine_1',
  display: {
    title: 'Preview',
    addressLabel: 'localhost:5173',
  },
} as const;

async function createShellState() {
  const reducer = await import('@/sync/domains/browser/control/reducer');
  const events: readonly BrowserEventV1[] = [
    {
      kind: 'sessionCreated',
      eventId: 'event_session',
      browserSessionId: 'browser_session_1',
      profileId: 'profile_1',
      occurredAt: 1_000,
    },
    {
      kind: 'viewOpened',
      eventId: 'event_view',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      target,
      platform: 'web',
      currentUrl: 'https://preview.happier.test/',
      adapterKind: 'localPreview',
      engineKind: 'webIframe',
      adapterCapabilities: {
        ...buildBrowserAdapterCapabilities({
          adapterKind: 'localPreview',
          supportedTargetKinds: ['localServicePreview'],
          supportedRenderEngines: ['webIframe'],
        }),
        navigation: {
          canNavigate: true,
          canGoBack: false,
          canGoForward: false,
          canReload: true,
          canStop: false,
        },
      },
      occurredAt: 1_001,
    },
    {
      kind: 'viewFocused',
      eventId: 'event_focus',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      occurredAt: 1_002,
    },
    {
      kind: 'navigationFinished',
      eventId: 'event_loaded',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      currentUrl: 'https://preview.happier.test/',
      occurredAt: 1_003,
    },
  ];

  return events.reduce(
    (state, event) => reducer.applyBrowserControlEvent(state, event),
    reducer.createBrowserControlState(),
  );
}

describe('useBrowserPreviewRecovery', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await homes.reset();
    previewBoundaries.clear();
    testState.machineRpc.mockReset();
    testState.machineRpc.mockImplementation(async ({ machineId }: { machineId: string }) => ({
      protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 0,
        refreshState: 'idle', resources: [], previews: [], diagnostics: [] },
    }));
    testState.previewFetch.mockReset();
    testState.previewOpen.mockReset();
    testState.previewOpen.mockRejectedValue(new Error('Unexpected preview Action at the Home HTTP boundary'));
    testState.previewFetch.mockImplementation(async (url, init) => {
      const target = new URL(url instanceof Request ? url.url : url);
      return await previewBoundaries.get(target.origin)?.handle(target, init) ?? homes.request(url, init);
    });
    setRuntimeFetch(testState.previewFetch);
    testState.previewToken = createAccountTokenForTests('viewer-account', { currentAccount: true });
    await addBrowserHome('https://browser-shell-home.example.test');
    const { resetLocalServicePreviewStoreForTests } =
      await import('@/sync/domains/local/services/preview/sharedStore');
    resetLocalServicePreviewStoreForTests();
  });

  it('settles an unknown Open again when matching Running inventory arrives without another Machine RPC', async () => {
    const { useBrowserPreviewRecovery } = await import('./useBrowserPreviewRecovery');
    const { LocalServiceLaunchTargetV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
    const { buildBrowserLaunchpadRows } = await import('@/sync/domains/browser/targets');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { RpcError } = await import('@happier-dev/protocol/rpcErrors');
    const { describeLocalServiceActionFailure } = await import('@/components/sessions/localServices/localServiceActionOutcome');
    const home = await addBrowserHome('https://unknown-open-recovery.example.test');
    const base = await createShellState();
    const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
    const running = LocalServiceLaunchTargetV1Schema.parse({
      id: 'managed:instance_new', source: 'managed_service', machineId: 'machine_1', sessionId: 'session_1',
      title: 'vite', subtitle: '127.0.0.1:5173', cwd: '/repo', declaration,
      sourceClass: { kind: 'managed_service', managedServiceId: 'instance_new' },
      serviceState: 'running', endpointUrl: 'http://127.0.0.1:5173/', confidence: 'high', state: 'available', actions: ['register_preview'],
    });
    const launchpadRows = buildBrowserLaunchpadRows({ nowMs: 2_000, launcherSnapshot: {
      v: 1, machineId: running.machineId, sessionId: 'session_1', updatedAt: 1_000, targets: [running],
    } });
    const input: Parameters<typeof useBrowserPreviewRecovery>[0] = {
      activeView: { ...base.viewsById.view_1!, loadingState: 'failed', lastError: 'preview_ended',
        target: { ...target, serviceTarget: { kind: 'managed_service', managedServiceId: 'instance_old',
          machineId: running.machineId, cwd: '/repo', declaration } } },
      launchpadRows, platform: 'web', serverId: home.id, accountLifetime: captureActiveServerAccountScopeLifetime(),
      onOpenTarget: vi.fn(), onClose: vi.fn(), canReload: false, onCommand: vi.fn(),
    };
    testState.machineRpc.mockRejectedValue(new RpcError('Outcome unknown', 'action_outcome_unknown'));
    testState.previewOpen.mockResolvedValue(ActionExecuteFailureSchema.parse({
      ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown',
    }));
    const hook = await renderHook(useBrowserPreviewRecovery, { initialProps: input });
    try {
      await act(async () => { await hook.getCurrent().onOpenAgain!(); });
      const failure = describeLocalServiceActionFailure({ reasonCode: 'action_outcome_unknown', serviceName: running.title }).body;
      expect(hook.getCurrent().openAgainFailure).toBe(failure);
      const readsBeforeRecovery = testState.machineRpc.mock.calls.length;
      const stopped = { ...running, serviceState: 'stopped' as const, actions: ['start' as const] };
      await hook.rerender({ ...input, localServiceTargets: [stopped] });
      expect(hook.getCurrent().openAgainFailure).toBe(failure);
      await hook.rerender({ ...input, localServiceTargets: [stopped, { ...running, machineId: 'another-machine' }] });
      expect(hook.getCurrent().openAgainFailure).toBe(failure);
      await hook.rerender({ ...input, localServiceTargets: [running] });
      expect(hook.getCurrent().openAgainFailure).toBeNull();
      expect(testState.machineRpc.mock.calls.length).toBe(readsBeforeRecovery);
    } finally { await hook.unmount(); }
  });

  it.each(['succeeded', 'unknown-before', 'unknown-after', 'registration-refused', 'cancelled', 'changed-view'] as const)(
    'settles ended-preview Start recovery with a healthy unregistered occurrence (%s)', async (outcome) => {
    const { useBrowserPreviewRecovery } = await import('./useBrowserPreviewRecovery');
    const { LocalServiceLaunchTargetV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const home = await addBrowserHome('https://start-preview-recovery.example.test');
    const base = await createShellState();
    const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
    const accountScope = await activateStorageAccountScope({ serverId: home.id, accountId: 'viewer-account' });
    const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
    const stopped = LocalServiceLaunchTargetV1Schema.parse({
      id: 'project-service:web', source: 'managed_service', machineId: 'machine_1', title: 'Lumen web',
      subtitle: 'web', cwd: '/repo', declaration, serviceState: 'stopped',
      confidence: 'high', state: 'available', actions: ['start'],
    });
    const serviceTarget = { kind: 'managed_service' as const, managedServiceId: 'instance_new',
      machineId: 'machine_1', cwd: '/repo', declaration };
    const reopenedTarget = { ...target, targetId: 'preview_new', sessionId: undefined, serviceTarget };
    const resource = {
      previewId: reopenedTarget.targetId, machineId: 'machine_1', owner: { kind: 'user' as const, id: 'viewer-account' },
      target: { scheme: 'http' as const, host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
      display: target.display, originMode: 'host' as const, browserTarget: reopenedTarget, serviceTarget,
    };
    const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview.happier.test/restarted',
      expiresAt: 1_700_000_000_000, diagnostics: [] };
    const registration = { protocolVersion: 1, status: 'created', preview, snapshot: {
      v: 1, machineId: 'machine_1', generatedAt: 2_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [],
    } } satisfies DaemonLocalServicePreviewOpenOrCreateResponseV1;
    testState.previewOpen.mockResolvedValue(outcome === 'registration-refused'
      ? { error: 'local_service_preview_lifecycle_refused:service_not_listening' }
      : registration);
    // The canonical UI Action reaches the Machine preview transport. Keep admission,
    // the Service-target lowering and returned registration parsing real beneath it.
    testState.machineRpc.mockImplementation(async ({ method, payload, machineId }) =>
      method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE ? testState.previewOpen(payload)
        : { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 0,
          refreshState: 'idle', resources: [], previews: [], diagnostics: [] } });
    const onOpenTarget = vi.fn();
    const onClose = vi.fn();
    const input: Parameters<typeof useBrowserPreviewRecovery>[0] = {
      activeView: { ...base.viewsById.view_1!, loadingState: 'failed', lastError: 'preview_ended',
        target: { ...target, serviceTarget: { ...serviceTarget, managedServiceId: 'instance_old' } } },
      launchpadRows: [], localServiceTargets: [stopped], platform: 'web', serverId: home.id,
      accountLifetime: captureActiveServerAccountScopeLifetime(), onOpenTarget, onClose, canReload: false, onCommand: vi.fn(),
    };
    const hook = await renderHook(useBrowserPreviewRecovery, { initialProps: input });
    try {
      const acknowledgement = createDeferred<unknown>();
      const start = vi.fn(() => acknowledgement.promise);
      let pending: Promise<boolean> | undefined;
      await act(async () => { pending = hook.getCurrent().startAgain!.run(start); });
      const running = { ...stopped, serviceState: 'healthy' as const, endpointUrl: 'http://127.0.0.1:5173/',
        sourceClass: { kind: 'managed_service' as const, managedServiceId: 'instance_new' },
        actions: ['register_preview' as const] };
      if (outcome === 'unknown-before') await hook.rerender({ ...input, localServiceTargets: [running] });
      const currentInput = outcome === 'changed-view' ? { ...input, activeView: { ...input.activeView!, viewId: 'another-view' } } : input;
      if (outcome === 'changed-view') await hook.rerender(currentInput);
      await act(async () => {
        acknowledgement.resolve(outcome.startsWith('unknown') ? { ok: false, errorCode: 'action_outcome_unknown' }
          : { status: outcome === 'cancelled' ? 'cancelled' : 'succeeded' });
        await pending;
      });
      if (outcome !== 'unknown-before') {
        await hook.rerender({ ...currentInput, localServiceTargets: [stopped, { ...running, machineId: 'another-machine' }] });
        expect(testState.previewOpen).not.toHaveBeenCalled();
        await hook.rerender({ ...currentInput, localServiceTargets: [running] });
      }
      if (outcome === 'cancelled' || outcome === 'changed-view') {
        await flushHookEffects();
        expect(testState.previewOpen).not.toHaveBeenCalled();
        expect(onOpenTarget).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(testState.previewOpen).toHaveBeenCalledExactlyOnceWith({ machineId: 'machine_1', serviceTarget }));
      expect(hook.getCurrent().startAgain).toBeUndefined();
      expect(hook.getCurrent().onOpenAgain).toEqual(expect.any(Function));
      if (outcome === 'registration-refused') {
        await vi.waitFor(() => expect(hook.getCurrent().openAgainFailure).toContain('namedServiceNotRunning'));
        expect(onOpenTarget).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith(reopenedTarget,
          expect.objectContaining({ currentUrl: preview.accessUrl })));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().openAgainFailure).toBeNull();
      }
      await hook.rerender({ ...input, localServiceTargets: [{ ...running }] });
      expect(testState.previewOpen).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally { await hook.unmount(); accountScope.dispose(); }
  });
});
