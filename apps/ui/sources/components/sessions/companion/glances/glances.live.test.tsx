import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';
import { HappierWidgetFrame } from '@happier-dev/plugin-ui/presentation';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';

import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { forgetPluginUiProjectionAdmissionSnapshots } from '@/sync/domains/plugins/ui/projectionWarmCache';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetLocalServiceInventoryStoreForTests } from '@/sync/domains/local/services/inventory/sharedStore';
import { resetLocalServiceLauncherStoreForTests } from '@/sync/domains/local/services/launch/sharedStore';
import { SessionCompanionGlance } from './SessionCompanionGlance';
import { LocalServicesGlance } from './LocalServicesGlance';
import { resolveMachineTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import type { StorageState } from '@/sync/store/types';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

const boundary = vi.hoisted(() => ({
    state: {} as Partial<StorageState> & { session?: ReturnType<typeof createSessionFixture> },
    projection: vi.fn(),
    rpc: vi.fn(),
    navigate: vi.fn(),
    usage: null as SessionContextUsageSnapshotV1 | null,
    scm: null as ScmWorkingSnapshot | null,
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/components/appShell/workspace/destinationRoute', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/workspace/destinationRoute')>()),
    useRouter: () => ({ push: boundary.navigate }),
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: createLiveStorageStoreMock(() => boundary.state),
        useEndpointStatus: () => 'online',
        useMachineCliDetectionTarget: () => ({ daemonStateVersion: 1, isOnline: true }),
        useSession: (sessionId: string, serverId?: string | null) => {
            const value = boundary.state.sessions?.[sessionId];
            return value?.serverId === serverId ? value : null;
        },
        useActiveServerAccountScope: () => boundary.state.profileScope ?? null,
        useSessionServerId: () => 'home-a',
        useSessionUsage: (sessionId: string, options: { serverId?: string | null }) => sessionId === 'session-b' && options.serverId === 'home-a'
            ? { contextSnapshot: boundary.usage, contextSnapshotStale: false } : null,
        useSessionProjectScmSnapshot: (sessionId: string, serverId?: string | null) => sessionId === 'session-b' && serverId === 'home-a' ? boundary.scm : null,
    });
});
vi.mock('@/sync/store/hooks', async () => {
    return await import('@/sync/domains/state/storage');
});
vi.mock('@/sync/domains/state/storageStateReaderBridge', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storageStateReaderBridge')>()),
    readRegisteredStorageState: () => boundary.state,
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>()),
    getAppliedActiveServerSnapshot: () => ({ serverId: 'home-a', serverUrl: 'https://home-a.test', generation: 1 }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
// The daemon transport is the boundary; projection admission, Session targeting,
// widget resolution and local-service subscriptions remain real beneath it.
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => boundary.projection(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: unknown) => boundary.rpc(input),
}));
// The sync singleton is the app transport boundary; native activity/model logic stays real.
vi.mock('@/sync/sync', async () => ({
    sync: (await import('@/dev/testkit/mocks/sync')).createAcceptedExternalSessionTailCursorSyncBoundary(),
}));
vi.mock('@/sync/ops/sessionSynopsis', () => ({ observeSessionSynopses: () => () => {} }));

const session = createSessionFixture({ id: 'session-a', serverId: 'home-a' });
const serviceTarget = {
    id: 'inventory:web', source: 'inventory_entry', machineId: 'machine-1', sessionId: 'session-a',
    title: 'web', confidence: 'high', state: 'available', actions: ['open'],
    sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'web' },
    browserTarget: { kind: 'externalUrl', targetId: 'web', url: 'http://127.0.0.1:8081/', display: { title: 'web', addressLabel: 'localhost:8081' } },
};
function successfulRead(method: string, targets: readonly unknown[] = [], sessionId = 'session-a') {
    return { protocolVersion: 1, snapshot: method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
        ? { v: 1, machineId: 'machine-1', sessionId, updatedAt: 1234, targets }
        : { v: 1, machineId: 'machine-1', generatedAt: 1234, refreshState: 'idle', entries: [], diagnostics: [] } };
}
async function renderServices() {
    expect(resolveMachineTargetForSessionFromState(boundary.state, { sessionId: session.id, serverId: 'home-a' })).toMatchObject({ machineId: 'machine-1' });
    const screen = await renderScreen(<AppPaneProvider><LocalServicesGlance sessionId="session-a" serverId="home-a" frameStyle="plain" measurementOnly={false} testID="services" /></AppPaneProvider>);
    await flushHookEffects({ cycles: 6 });
    return screen;
}
beforeEach(async () => {
    await prepareWarmCacheEncryptionKey();
    retireActiveServerAccountScopeLifetime();
    clearDaemonMergedProjectionCacheForTests();
    forgetPluginUiProjectionAdmissionSnapshots({ serverId: 'home-a', accountId: 'account-a' });
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
    const machine = createMachineFixture({ activeAt: Date.now() });
    boundary.state = { profileScope: { serverId: 'home-a', accountId: 'account-a' }, session, sessions: { [session.id]: session }, machines: { [machine.id]: machine }, machineListByServerId: { 'home-a': [machine] } };
    boundary.rpc.mockReset();
    boundary.projection.mockReset();
    boundary.navigate.mockReset();
    boundary.usage = null;
    boundary.scm = null;
    boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {}) : Promise.resolve(successfulRead(method)));
});
afterEach(() => { standardCleanup(); resetLocalServiceInventoryStoreForTests(); resetLocalServiceLauncherStoreForTests(); });

function BrowserPaneProbe() {
    const a = useAppPaneScope(createSessionPaneScopeId('session-a', 'home-a', 'physical-a'));
    const b = useAppPaneScope(createSessionPaneScopeId('session-b', 'home-a', 'physical-a'));
    return React.createElement('BrowserPaneProbe', { a: a.scopeState?.details.tabs ?? [], b: b.scopeState?.details.tabs ?? [] });
}

describe('Companion glance consumed owners', () => {
    it('opens the configured services Browser destination only after the exact B tab is committed', async () => {
        const selected = createSessionFixture({ id: 'session-b', serverId: 'home-a' });
        boundary.state = { ...boundary.state, sessions: { ...boundary.state.sessions, [selected.id]: selected } };
        boundary.rpc.mockImplementation(({ method, payload }: { method: string; payload?: { sessionId?: string } }) =>
            method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {})
                : Promise.resolve(successfulRead(method, [{ ...serviceTarget, sessionId: selected.id }], payload?.sessionId)));
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="physical-a"
            ref={{ kind: 'session', params: { id: session.id, serverId: 'home-a' } }} pathname="/session/session-a" focused visible>
            <BrowserPaneProbe />
            <SessionCompanionGlance entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'browser-b',
                definition: { kind: 'builtin', id: 'local_services' }, bindings: { session: { kind: 'value', value: { serverId: 'home-a', sessionId: selected.id } } } } } }}
                sessionId={session.id} session={session} serverId="home-a" frameStyle="plain" headerAccessory={null}
                measurementOnly={false} testID="browser-b" />
        </DestinationInstanceHost></AppPaneProvider>);
        await flushHookEffects({ cycles: 8 });
        await act(async () => { screen.pressByTestId('browser-b.surface.row.inventory:web.open'); });
        await flushHookEffects({ cycles: 3 });
        const probe = screen.tree.root.findByType('BrowserPaneProbe');
        expect(probe.props.a).toEqual([]);
        expect(probe.props.b).toMatchObject([{ kind: 'browser-view', resource: { target: { kind: 'externalUrl', url: 'http://127.0.0.1:8081/' } } }]);
        expect(boundary.navigate).toHaveBeenCalledWith('/session/session-b/details?serverId=home-a');
    });
    it('routes configured Summary Git and Changes review into B destinations from the physical A destination', async () => {
        const selected = createSessionFixture({ id: 'session-b', serverId: 'home-a' });
        boundary.state = { ...boundary.state, sessions: { ...boundary.state.sessions, [selected.id]: selected } };
        boundary.scm = ScmWorkingSnapshotSchema.parse({ projectKey: 'machine-1:/repo', fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
            capabilities: { readStatus: true, readDiffFile: true, readDiffCommit: true, readLog: true,
                writeInclude: false, writeExclude: false, writeCommit: false, writeCommitPathSelection: false,
                writeCommitLineSelection: false, writeBackout: false, writeRemoteFetch: false,
                writeRemotePull: false, writeRemotePush: false, worktreeCreate: false,
                changeSetModel: 'index', supportedDiffAreas: ['pending'] },
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false }, hasConflicts: false,
            entries: [{ path: 'b.ts', previousPath: null, kind: 'modified', includeStatus: '', pendingStatus: 'M',
                hasIncludedDelta: false, hasPendingDelta: true }],
            totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0 },
        });
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="physical-a"
            ref={{ kind: 'session', params: { id: session.id, serverId: 'home-a' } }} pathname="/session/session-a" focused visible>
            {(['session_summary', 'changes'] as const).map(id => <SessionCompanionGlance key={id}
                entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id,
                    definition: { kind: 'builtin', id }, bindings: { session: { kind: 'value', value: { serverId: 'home-a', sessionId: selected.id } } } } } }}
                sessionId={session.id} session={session} serverId="home-a" frameStyle="plain" headerAccessory={null}
                measurementOnly={false} testID={id} />)}
        </DestinationInstanceHost></AppPaneProvider>);
        await flushHookEffects({ cycles: 5 });
        await act(async () => { screen.pressByTestId('session_summary.surface-fact-changes'); screen.pressByTestId('changes.surface.open'); });
        expect(boundary.navigate.mock.calls.map(([href]) => href)).toEqual([
            '/session/session-b?serverId=home-a&right=git',
            '/session/session-b/details?serverId=home-a&details=scmReview',
        ]);
        expect(parseSessionPaneUrlState({ right: 'git' })).toEqual({ rightTabId: 'git' });
    });
    it('opens the configured Summary usage fact at B through the existing qualified route owner', async () => {
        const selected = createSessionFixture({ id: 'session-b', serverId: 'home-a' });
        boundary.state = { ...boundary.state, sessions: { ...boundary.state.sessions, [selected.id]: selected } };
        boundary.usage = { v: 1, modelId: null, usedTokens: 40, windowTokens: 100, totalProcessedTokens: null,
            baselineTokens: null, isAutoCompactEnabled: null, categories: null, observedAtMs: 1, source: 'provider_turn' };
        const screen = await renderScreen(<AppPaneProvider><SessionCompanionGlance
            entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'summary-b',
                definition: { kind: 'builtin', id: 'session_summary' }, bindings: { session: { kind: 'value', value: { serverId: 'home-a', sessionId: selected.id } } } } } }}
            sessionId={session.id} session={session} serverId="home-a" frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="summary-b" />
        </AppPaneProvider>);
        await flushHookEffects({ cycles: 5 });
        expect(screen.findByTestId('summary-b.surface-fact-context')).not.toBeNull();
        expect(screen.findByTestId('summary-b.surface-fact-context')?.props.onPress).toEqual(expect.any(Function));
        await act(async () => { screen.findByTestId('summary-b.surface-fact-context')?.props.onPress(); });
        expect(boundary.navigate).toHaveBeenCalledWith('/session/session-b/usage?serverId=home-a');
    });
    it('mounts a configured native services copy through the shared surface and its incumbent feeds, without plugin execution', async () => {
        const screen = await renderScreen(<AppPaneProvider><SessionCompanionGlance
            entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'native-services',
                definition: { kind: 'builtin', id: 'local_services' }, bindings: { session: { kind: 'context', slot: 'session' } } } } }}
            sessionId={session.id} session={session} serverId="home-a" frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="native" />
        </AppPaneProvider>);
        await flushHookEffects({ cycles: 8 });
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
        expect(screen.tree.root.findAllByType('PluginInlineSurfaceHost')).toHaveLength(0);
        expect(boundary.projection).not.toHaveBeenCalled();
        expect(screen.tree.root.findAllByType(HappierWidgetFrame)).toHaveLength(1);
    });
    it('reads a pinned native copy from B beside A and refuses a lost B read without starting another feed', async () => {
        const selected = createSessionFixture({ id: 'session-b', serverId: 'home-a' });
        boundary.state = { ...boundary.state, sessions: { ...boundary.state.sessions, [selected.id]: selected } };
        boundary.rpc.mockImplementation(({ method, payload }: { method: string; payload?: { sessionId?: string } }) =>
            method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {})
                : Promise.resolve(successfulRead(method, [], payload?.sessionId)));
        const renderCopy = () => <AppPaneProvider><SessionCompanionGlance
            entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'pinned-services',
                definition: { kind: 'builtin', id: 'local_services' }, bindings: { session: { kind: 'value', value: { serverId: 'home-a', sessionId: selected.id } } } } } }}
            sessionId={session.id} session={session} serverId="home-a" frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="pinned" />
        </AppPaneProvider>;
        const screen = await renderScreen(renderCopy());
        await flushHookEffects({ cycles: 8 });
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
        expect(boundary.rpc.mock.calls.map(([input]) => input).filter(input => input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT))
            .toMatchObject([{ payload: { sessionId: selected.id } }]);
        const reads = boundary.rpc.mock.calls.length;
        boundary.state = { ...boundary.state, sessions: { ...boundary.state.sessions, [selected.id]: { ...selected,
            access: { ...selected.access!, capabilities: { ...selected.access!.capabilities, readTranscript: false } } } } };
        await screen.update(renderCopy());
        await flushHookEffects({ cycles: 4 });
        expect(screen.getTextContent()).not.toContain('widgetGlances.nothingRunning');
        expect(boundary.rpc.mock.calls).toHaveLength(reads);
        expect(boundary.projection).not.toHaveBeenCalled();
    });
    it('admits a configured plugin copy with the exact hydrated shell Session', async () => {
        const entry = widgetProjectionEntry({ pluginId: 'acme.review', localId: 'status' });
        boundary.projection.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true, source: { kind: 'local', locator: '/plugins/acme.review' } } }, familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry } } } }) });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true, source: { kind: 'local', locator: '/plugins/acme.review' } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry } } } }));
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: 'machine-1', serverId: 'home-a', platform: 'web', clientExecutableActivation: { status: 'ready' },
            reloadConnectedAccountProjection() {}, reloadClientExecutables() {},
        }}><SessionCompanionGlance entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'personal-status', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'status' } }, bindings: { session: { kind: 'context', slot: 'session' } } } } }} sessionId={session.id} session={session} serverId="home-a" frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="plugin" /></AppShellPluginUiProjectionValueProvider>);
        await flushHookEffects({ cycles: 8 });
        // The real configured arm got past typed input and hydration admission.
        expect(screen.tree.root.findAllByType('PluginInlineSurfaceHost')).toHaveLength(1);
    });

    it('keeps cold reads loading until both feeds settle, then shows successful emptiness', async () => {
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
            await pending;
            return successfulRead(method);
        });
        const screen = await renderServices();
        expect(screen.findByTestId('services.loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('widgetGlances.nothingRunning');
        await act(async () => { release?.(); });
        await flushHookEffects({ cycles: 6 });
        expect(screen.findByTestId('services.loading')).toBeNull();
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
    });

    it('shows a failed initial read with Retry and recovers through both shared feeds', async () => {
        boundary.rpc.mockRejectedValue(new Error('offline'));
        const screen = await renderServices();
        expect(screen.findByTestId('services.error-action')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('widgetGlances.nothingRunning');
        boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {}) : Promise.resolve(successfulRead(method)));
        await act(async () => { screen.pressByTestId('services.error-action'); });
        await flushHookEffects({ cycles: 6 });
        expect(screen.findByTestId('services.error-action')).toBeNull();
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
    });

    it('retains launcher rows and offers Retry after a launcher refresh fails', async () => {
        boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {}) : Promise.resolve(successfulRead(method, [serviceTarget])));
        const screen = await renderServices();
        expect(screen.getTextContent()).toContain('web');
        expect(screen.findByTestId('services.asOf')).toBeNull();
        const { invalidateLocalServiceLauncherStore } = await import('@/sync/domains/local/services/launch/sharedStore');
        boundary.rpc.mockRejectedValue(new Error('offline'));
        await act(async () => { invalidateLocalServiceLauncherStore({ machineId: 'machine-1', serverId: 'home-a', sessionId: 'session-a', scope: 'workspace', workspaceRoot: null }); });
        await flushHookEffects({ cycles: 6 });
        expect(screen.findByTestId('services.row.inventory:web')).toBeTruthy();
        expect(screen.findByTestId('services.stale-action')).toBeTruthy();
        expect(screen.findByTestId('services.asOf')).toBeTruthy();
    });
});

// Native plugin rendering is an external runtime boundary; assert admission
// through the real host resolver before it executes a renderer bundle.
vi.mock('@/components/plugins/surfaces', () => ({ PluginInlineSurfaceHost: (props: Record<string, unknown>) => React.createElement('PluginInlineSurfaceHost', props) }));
