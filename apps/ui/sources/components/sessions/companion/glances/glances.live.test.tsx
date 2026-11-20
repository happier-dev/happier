/** @vitest-environment jsdom */
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { router } from 'expo-router';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol/usage/contextUsage';
import { HappierWidgetFrame } from '@happier-dev/plugin-ui/presentation';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import { createDeferred, createRenderCommitCounter, createSessionFixture, flushHookEffects, renderHook, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storage';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { DestinationInstanceHost, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { hrefForDestinationRef, resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { AppShellPluginUiProjectionProvider, AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { forgetPluginUiProjectionAdmissionSnapshots } from '@/sync/domains/plugins/ui/projectionWarmCache';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { publishLocalServiceInventorySnapshot, resetLocalServiceInventoryStoreForTests } from '@/sync/domains/local/services/inventory/sharedStore';
import { resetLocalServiceLauncherStoreForTests } from '@/sync/domains/local/services/launch/sharedStore';
import { SessionCompanionGlance } from './SessionCompanionGlance';
import { LocalServicesGlance, LocalServicesGlanceView } from './LocalServicesGlance';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { ConfiguredWidgetRefusal } from '@/components/widgets/InstalledWidgetSurface';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { useLocalServiceLiveFeeds } from '@/components/sessions/localServices/useLocalServiceLiveFeeds';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { resolveMachineTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { resolveWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { useAppLocalServicesGlance } from './useAppLocalServicesGlance';
import type { DaemonLocalServiceInventoryWatchResponseV1 } from '@happier-dev/protocol/local/services/inventory/v1';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import { SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY, SessionAgentActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { SessionWorkSourcesProvider, useSessionWorkSourcesOwner } from '@/components/sessions/work/sessionWorkSources';

const boundary = vi.hoisted(() => ({
    projection: vi.fn(),
    rpc: vi.fn(),
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-a',
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    features: () => createRootLayoutFeaturesResponse({ features: { browser: { enabled: true }, localServices: { enabled: true } } }),
    request: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || path !== '/v2/sessions/query') return null;
        const sessions = Object.values(storage.getState().sessions)
            .filter((candidate) => areServerProfileIdentifiersEquivalent(candidate.serverId, runtime.serverId))
            .map((candidate) => ({
                ...createPlainSessionCurrentProjectionRecordFixture({
                    id: candidate.id, seq: candidate.seq, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
                    active: candidate.active, activeAt: candidate.activeAt, archivedAt: candidate.archivedAt,
                    metadataVersion: candidate.metadataVersion, agentStateVersion: candidate.agentStateVersion,
                }),
                viewer: createSessionOwnerViewerFixture(candidate),
            }));
        return Response.json(createSessionListSourceFixture({
            sessions, nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }));
    },
    rpc: async (method, payload, machineId) => {
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            const response = await boundary.projection();
            return { protocolVersion: 1, projection: response.projection };
        }
        return await boundary.rpc({ method, payload, machineId, serverId: runtime.serverId });
    },
});

let session: ReturnType<typeof createSessionFixture>;

async function hydrateSelectedSession(selected = createSessionFixture({ id: 'session-b', serverId: runtime.serverId })) {
    const currentScope = captureActiveServerAccountScopeLifetime()?.scope;
    expect(currentScope && areServerProfileIdentifiersEquivalent(currentScope.serverId, selected.serverId)).toBe(true);
    storage.getState().applySessions([selected]);
    const { sync } = await import('@/sync/sync');
    const result = await sync.ensureSessionVisibleForMessageRoute(selected.id, {
        serverId: runtime.serverId,
        hydrateMessages: false,
    });
    expect(result.kind).toBe('available');
    return selected;
}

function GlanceFixture(props: Readonly<{ children: React.ReactNode }>) {
    return <runtime.Wrapper><AppShellPluginUiProjectionProvider>{props.children}</AppShellPluginUiProjectionProvider></runtime.Wrapper>;
}
const workspaceCatalog = resolveCompactAppDestinations({ pages: [], builtins: {
    externalSessions: false, inbox: false, workflows: false, friends: false,
} });
function HostedGlanceFixture(props: Readonly<{ children: React.ReactNode }>) {
    return <GlanceFixture><WorkspaceProvider enabled catalog={workspaceCatalog}>{navigation => {
        const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
        return <>
            {React.createElement('WorkspaceOwner', { navigation })}
            <DestinationInstanceHost tabId={tab.id} ref={tab.target}
                pathname={hrefForDestinationRef(workspaceCatalog, tab.target)?.split('?')[0] ?? ''}
                focused visible navigation={navigation.navigationForTab(tab.id)}>
                {props.children}
            </DestinationInstanceHost>
        </>;
    }}</WorkspaceProvider></GlanceFixture>;
}
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
    expect(resolveMachineTargetForSessionFromState(storage.getState(), { sessionId: session.id, serverId: runtime.serverId })).toMatchObject({ machineId: 'machine-1' });
    const screen = await renderScreen(<runtime.Wrapper><LocalServicesGlance sessionId="session-a" serverId={runtime.serverId} frameStyle="plain" measurementOnly={false} testID="services" /></runtime.Wrapper>);
    await flushHookEffects({ cycles: 6 });
    return screen;
}
beforeEach(async () => {
    await prepareWarmCacheEncryptionKey();
    clearDaemonMergedProjectionCacheForTests();
    forgetPluginUiProjectionAdmissionSnapshots({ serverId: runtime.serverId, accountId: 'account-a' });
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
    const machine = createMachineFixture({ activeAt: Date.now() });
    session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
    storage.getState().applySessions([session]);
    await publishMachineInventoryForTest(runtime.accountScope!, [machine]);
    boundary.rpc.mockReset();
    boundary.projection.mockReset();
    boundary.projection.mockResolvedValue({ projection: PluginProjectionV2Schema.parse({
        v: 2, generation: 1, installedPackagesById: {}, familiesById: {},
    }) });
    // The real web workspace restores its window identity from sessionStorage
    // and owns browser History; no destination or Expo router is substituted.
    window.sessionStorage.clear();
    window.history.replaceState(null, '', `/session/session-a?serverId=${runtime.serverId}`);
    vi.mocked(router.push).mockClear();
    boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {}) : Promise.resolve(successfulRead(method)));
});
afterEach(() => { resetLocalServiceInventoryStoreForTests(); resetLocalServiceLauncherStoreForTests(); });

function BrowserPaneProbe() {
    const instanceKey = useDestinationInstanceKey();
    const a = useAppPaneScope(createSessionPaneScopeId('session-a', runtime.serverId, instanceKey));
    const b = useAppPaneScope(createSessionPaneScopeId('session-b', runtime.serverId, instanceKey));
    return React.createElement('BrowserPaneProbe', { a: a.scopeState?.details.tabs ?? [], b: b.scopeState?.details.tabs ?? [] });
}

const homeServicesDefinition = { kind: 'builtin', id: 'local_services_app' } as const;
function homeServicesFixture(descriptor = readWidgetDescriptor(null, homeServicesDefinition), serverId = runtime.serverId) {
    return <runtime.Wrapper><WidgetSurface
        scope={{ serverId, accountId: 'account-a', owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'home-services', definition: homeServicesDefinition, bindings: {} }} descriptor={descriptor}
        providedContext={{}} appRuntime={{ pluginUiProjection: normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1 })), pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId, platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime() }}
        presentation="content" recordRevision="home:1" testID="home-services" /></runtime.Wrapper>;
}

describe('Companion glance consumed owners', () => {
    it.each([
        { statuses: ['waiting'], runtimeCount: 0, fact: 'sessionWork.strip.needsYou(count=1)' },
        { statuses: ['running'], runtimeCount: 4, fact: 'sessionWork.strip.stillWorking(count=4)' },
        { statuses: ['waiting', 'running', 'running'], runtimeCount: 0, fact: 'sessionWork.strip.needsYou(count=1)' },
        { statuses: [], runtimeCount: 0, fact: null },
    ] as const)('shows awareness running work separately from Work attention with $statuses', async ({ statuses, runtimeCount, fact }) => {
        const { useSessionAwareness } = await import('@/sync/domains/session/awareness/useSessionAwareness');
        session = createSessionFixture({ ...session, active: true, activeAt: Date.now(),
            runtimeActivityState: runtimeCount ? 'active' : 'idle', runtimeActivityActiveCount: runtimeCount, metadata: { ...session.metadata!,
            [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: SessionAgentActivityHeadlineV1Schema.parse({
                v: 1, backendId: 'claude', updatedAt: Date.now(),
                activeEntries: statuses.map((status, index) => ({
                    entryId: `workflow_run:run-${index}`, kind: 'workflow_run', runId: `run-${index}`,
                    title: `Run ${index}`, status, updatedAt: Date.now(),
                })),
            }),
        } });
        storage.getState().applySessions([session]);
        function WorkGlance() {
            const agentActivity = useSessionAgentActivity({ sessionId: session.id, serverId: runtime.serverId, session });
            const { awareness } = useSessionAwareness(session.id, runtime.serverId, session);
            const sources = useSessionWorkSourcesOwner({ sessionId: session.id, serverId: runtime.serverId,
                ownerMetadata: session.metadata, agentActivity, runningWorkCount: awareness.runningWorkCount });
            return <SessionWorkSourcesProvider value={sources}>
                {React.createElement('WorkSummaryProbe', { summary: sources.projection.summary })}
                <SessionCompanionGlance
                entry={{ kind: 'pane', ref: { kind: 'pane', paneId: 'agents' } }}
                session={session} sessionId={session.id} serverId={runtime.serverId}
                frameStyle="plain" measurementOnly={false} headerAccessory={null} testID="work-pane" />
            </SessionWorkSourcesProvider>;
        }
        const screen = await renderScreen(<GlanceFixture><WorkGlance /></GlanceFixture>);
        await flushHookEffects();
        expect(screen.tree.root.findByType('WorkSummaryProbe').props.summary).toMatchObject({
            outstanding: statuses.length, needsYou: statuses.filter(status => status === 'waiting').length, stalled: 0,
        });
        const label = screen.findByTestId('work-pane.open')!.props.accessibilityLabel;
        if (fact) {
            expect(screen.getTextContent()).toContain(fact);
            expect(label).toContain(fact);
        } else {
            expect(label).toBe('widgetGlances.paneLinkA11y(pane=sessionWork.title)');
        }
        await screen.unmount();
    });

    it('keeps the services row as the count and the way into the pane, puts no services count in the header, and reads no feed', async () => {
        const { RunningGlance } = await import('./RunningGlance');
        const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(),
            daemonState: { localServices: { v: 1, state: 'ready', runningCount: 2 } } });
        await publishMachineInventoryForTest(runtime.accountScope!, [machine]);
        const onOpenPane = vi.fn();
        const screen = await renderScreen(<runtime.Wrapper><RunningGlance session={session} sessionId={session.id}
            serverId={runtime.serverId} frameStyle="plain" measurementOnly={false} testID="running" onOpenPane={onOpenPane} /></runtime.Wrapper>);
        await flushHookEffects({ cycles: 8 });
        const serviceRequests = () => boundary.rpc.mock.calls.filter(([request]) => [
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
        ].includes(request.method));
        expect(serviceRequests()).toHaveLength(0);
        // Services are the only running kind: their row says the count once; the header repeats nothing.
        expect(screen.findByTestId('running.meta')).toBeNull();
        const services = screen.findByTestId('running.services');
        expect(services).not.toBeNull();
        await act(async () => { services!.props.onPress(); });
        expect(onOpenPane).toHaveBeenCalledWith('services');
        await act(async () => {
            await publishMachineInventoryForTest(runtime.accountScope!, [{ ...machine,
                daemonState: { localServices: { v: 1, state: 'ready', runningCount: 0 } } }]);
        });
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('running.services')).toBeNull();
        expect(serviceRequests()).toHaveLength(0);
        await screen.unmount();
    });

    it('keeps Home Services quiet for unchanged watch replies and scan cursors, then renders only the changed feed reader', async () => {
        await publishMachineInventoryForTest(runtime.accountScope!, [
            createMachineFixture({ id: 'machine-1', activeAt: Date.now() }),
            createMachineFixture({ id: 'machine-2', activeAt: Date.now() }),
        ]);
        const watches = new Map<string, ReturnType<typeof createDeferred<DaemonLocalServiceInventoryWatchResponseV1>>>();
        let generation = 1234;
        let title = 'web';
        boundary.rpc.mockImplementation(({ method, machineId, payload }: {
            method: string; machineId: string; payload?: { observationOnly?: boolean };
        }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                if (payload?.observationOnly) return new Promise(() => {});
                const reply = createDeferred<DaemonLocalServiceInventoryWatchResponseV1>();
                watches.set(machineId, reply);
                return reply.promise;
            }
            return Promise.resolve(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
                ? { protocolVersion: 1, snapshot: LocalServiceLauncherSnapshotV1Schema.parse({
                    v: 1, machineId, updatedAt: generation,
                    targets: [{ ...serviceTarget, machineId, sessionId: undefined, title: machineId === 'machine-1' ? title : 'other' }],
                }) }
                : { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: generation, refreshState: 'idle', entries: [], diagnostics: [] } });
        });
        const homeCounter = createRenderCommitCounter();
        const otherCounter = createRenderCommitCounter();
        const home = await renderHook(() => {
            const state = useAppLocalServicesGlance(runtime.serverId);
            useRenderCommitCounter(homeCounter);
            return state;
        }, { wrapper: runtime.Wrapper });
        const other = await renderHook(() => {
            const state = useLocalServiceLiveFeeds({ machineId: 'machine-2', serverId: runtime.serverId, scope: 'machine' });
            useRenderCommitCounter(otherCounter);
            return state;
        }, { wrapper: runtime.Wrapper });
        await vi.waitFor(() => expect(home.getCurrent()).toMatchObject({ kind: 'ready', rows: [{ title: 'web' }, { title: 'other' }] }));
        await vi.waitFor(() => expect(watches.size).toBe(2));
        await flushHookEffects();
        homeCounter.reset();
        otherCounter.reset();
        const deliver = async (changed: boolean) => {
            const reply = watches.get('machine-1')!;
            await act(async () => {
                reply.resolve(changed ? { protocolVersion: 1, changed: true,
                    snapshot: { v: 1, machineId: 'machine-1', generatedAt: ++generation,
                        refreshState: 'idle', diagnostics: [], entries: [{
                            id: `unrelated-${generation}`, machineId: 'machine-1',
                            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }, port: generation,
                            protocol: 'tcp', detectedAt: generation, lastSeenAt: generation, state: 'listening',
                            source: 'detected', labels: [], confidence: 'high', processOwnershipConfidence: 'high',
                            workspaceAssociationConfidence: 'low', diagnostics: [],
                        }] } } : { protocolVersion: 1, changed: false });
                await flushHookEffects();
            });
            await vi.waitFor(() => expect(watches.get('machine-1')).not.toBe(reply));
        };
        await deliver(false);
        expect(homeCounter.read().commits).toBe(0);
        for (let revision = 0; revision < 75; revision++) await deliver(true);
        expect(homeCounter.read().commits).toBe(0);
        expect(otherCounter.read().commits).toBe(0);
        title = 'Updated web';
        await deliver(true);
        await vi.waitFor(() => expect(home.getCurrent().rows[0]?.title).toBe('Updated web'));
        expect(homeCounter.read().commits).toBe(1);
        expect(otherCounter.read().commits).toBe(0);
        await home.unmount();
        await other.unmount();
    });

    it.each([1, 2])('Home Services reads each of %i online Machines once, independent of checkouts, and reports offline Machines', async onlineCount => {
        const online = Array.from({ length: onlineCount }, (_, index) => createMachineFixture({ id: `machine-${index + 1}`, activeAt: Date.now() }));
        const offline = createMachineFixture({ id: 'machine-offline', active: false, activeAt: 1,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Studio' } });
        await publishMachineInventoryForTest(runtime.accountScope!, [...online, offline]);
        // Each Session points at a different checkout. Home must not enumerate them for Services.
        storage.getState().applySessions(Array.from({ length: 16 }, (_, index) => createSessionFixture({ id: `checkout-session-${index}`,
            serverId: runtime.serverId, metadata: { ...session.metadata!, machineId: 'machine-1', path: `/checkout-${index}` } })));
        let generatedAt = 1234;
        let changedTitle: string | null = null;
        const declaration = (machineId: string) => LocalServiceLauncherSnapshotV1Schema.parse({ v: 1, machineId, updatedAt: generatedAt,
            targets: [{ id: 'declared', machineId, source: 'managed_service', title: 'Declared web',
                declaration: { workspaceRefId: 'checkout-1', selection: { kind: 'manifest', name: 'web' } },
                confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] },
                { ...serviceTarget, machineId, sessionId: undefined,
                    ...(changedTitle && machineId === 'machine-1' ? { title: changedTitle } : {}) }] });
        boundary.rpc.mockImplementation(({ method, machineId }: { method: string; machineId: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH
            ? new Promise(() => {}) : Promise.resolve(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
                ? { protocolVersion: 1, snapshot: declaration(machineId) }
                : { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt, refreshState: 'idle', entries: [], diagnostics: [] } }));
        const screen = await renderScreen(homeServicesFixture());
        await flushHookEffects({ cycles: 8 });
        const views = screen.findAllByType(LocalServicesGlanceView);
        expect(views).toHaveLength(1);
        expect(views[0]!.props.state).toMatchObject({ kind: 'ready', scope: 'app', runningCount: onlineCount,
            rows: online.flatMap(machine => [{ title: 'web', machineId: machine.id }, { title: 'Declared web', machineId: machine.id }]),
            degraded: [{ kind: 'offline', machineId: offline.id, machineName: 'Studio' }] });
        expect(new Set(views[0]!.props.state.rows.map((row: { id: string }) => row.id)).size).toBe(onlineCount * 2);
        expect(screen.getTextContent()).toContain('Declared web');
        const launcherReads = () => boundary.rpc.mock.calls.map(([request]) => request)
            .filter(request => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT);
        expect(launcherReads()).toHaveLength(onlineCount);
        expect(launcherReads()[0]).toMatchObject({ machineId: 'machine-1', payload: { machineId: 'machine-1', scope: 'machine' } });
        expect(launcherReads()[0].payload).not.toHaveProperty('sessionId');
        expect(launcherReads()[0].payload).not.toHaveProperty('workspaceRoot');
        expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
            || request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT)).toHaveLength(onlineCount);
        await screen.update(homeServicesFixture());
        await flushHookEffects({ cycles: 3 });
        expect(launcherReads()).toHaveLength(onlineCount);
        expect(boundary.rpc.mock.calls.every(([request]) => request.machineId !== offline.id)).toBe(true);
        await screen.unmount();
        const reopened = await renderScreen(homeServicesFixture());
        await flushHookEffects({ cycles: 8 });
        expect(reopened.findByType(LocalServicesGlanceView).props.state).toMatchObject({ kind: 'ready', runningCount: onlineCount });
        expect(launcherReads()).toHaveLength(onlineCount * 2);
        generatedAt = 2345;
        changedTitle = 'Updated web';
        await act(async () => { publishLocalServiceInventorySnapshot({ machineId: 'machine-1', serverId: resolveMachineDaemonReadServerId(runtime.serverId),
            accountId: 'account-a', credentialKey: resolveAuthCredentialsScopeKey(runtime.credentials) },
        { v: 1, machineId: 'machine-1', generatedAt, refreshState: 'idle', entries: [], diagnostics: [] }); });
        await flushHookEffects({ cycles: 6 });
        expect(reopened.getTextContent()).toContain('Updated web');
        expect(launcherReads()).toHaveLength(onlineCount * 2 + 1);
    });

    it.each(['idle', 'error'] as const)('Home Services distinguishes a pending scan from settled %s and preserves its typed reason', async refreshState => {
        observeMachinePresenceForTest({ serverId: runtime.serverId, accountId: 'account-a' }, ['machine-1']);
        const read = createDeferred<void>();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
            await read.promise;
            return method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
                ? { protocolVersion: 1, snapshot: LocalServiceLauncherSnapshotV1Schema.parse({ v: 1, machineId: 'machine-1', updatedAt: 1234,
                    targets: refreshState === 'error' ? [{ id: 'declared', machineId: 'machine-1', source: 'managed_service', title: 'Declared web',
                        declaration: { workspaceRefId: 'checkout-1', selection: { kind: 'manifest', name: 'web' } },
                        confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] }] : [] }) }
                : { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-1', generatedAt: 1234, refreshState, entries: [],
                    diagnostics: refreshState === 'error' ? [{ code: 'local_services_inventory_scan_failed', severity: 'error' }] : [] } };
        });
        const screen = await renderScreen(homeServicesFixture());
        await flushHookEffects({ cycles: 4 });
        const state = () => screen.findByType(LocalServicesGlanceView).props.state;
        expect(state()).toMatchObject({ kind: 'loading', scope: 'app', rows: [], degraded: [] });
        await act(async () => { read.resolve(); });
        await flushHookEffects({ cycles: 6 });
        expect(state()).toMatchObject({ kind: 'ready', scope: 'app', runningCount: 0,
            rows: refreshState === 'error' ? [{ title: 'Declared web' }] : [],
            degraded: refreshState === 'error' ? [{ kind: 'unavailable', machineId: 'machine-1', reasonCode: 'local_services_inventory_scan_failed' }] : [] });
    });

    it('Home Services degrades an unknown builtin descriptor without mounting a feed', async () => {
        const screen = await renderScreen(homeServicesFixture(null));
        await flushHookEffects({ cycles: 4 });
        expect(screen.findAllByType(LocalServicesGlanceView)).toHaveLength(0);
        expect(screen.findByType(ConfiguredWidgetRefusal).props.resolution).toMatchObject({ status: 'unavailable', reasonCode: 'widget_type_unavailable' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('Home Services reuses the existing Machine feed across equivalent Home identifiers', async () => {
        const { upsertServerProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const serverUrl = 'https://local-services-alias.test';
        await upsertServerProfile({ serverUrl });
        await runtime.restoreRealm({ serverUrl, serverIdentityId: 'srv_local_services_alias', accountId: 'account-a' });
        await publishMachineInventoryForTest(runtime.accountScope!, [createMachineFixture({ activeAt: Date.now() })]);
        const canonical = resolveMachineDaemonReadServerId(runtime.serverId);
        const profile = getServerProfileById(runtime.serverId)!;
        const alias = [profile.id, profile.serverIdentityId].find((id): id is string => Boolean(id) && id !== canonical);
        expect(alias).toBeDefined();
        boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH
            ? new Promise(() => {}) : Promise.resolve(successfulRead(method, [serviceTarget])));
        const existing = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'machine-1', serverId: canonical, scope: 'machine' }),
            { wrapper: runtime.Wrapper });
        await flushHookEffects({ cycles: 8 });
        expect(existing.getCurrent().launcherState?.targetIds).toEqual([serviceTarget.id]);
        const reads = () => boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length;
        const beforeOpen = reads();
        const screen = await renderScreen(homeServicesFixture(undefined, alias));
        await flushHookEffects({ cycles: 8 });
        expect(screen.findByType(LocalServicesGlanceView).props.state).toMatchObject({ kind: 'ready', rows: [{ title: 'web' }] });
        expect(reads()).toBe(beforeOpen);
    });

    it('opens the configured services Browser destination only after the exact B tab is committed', async () => {
        const selected = await hydrateSelectedSession();
        boundary.rpc.mockImplementation(({ method, payload }: { method: string; payload?: { sessionId?: string } }) =>
            method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {})
                : Promise.resolve(successfulRead(method, [{ ...serviceTarget, sessionId: selected.id }], payload?.sessionId)));
        const screen = await renderScreen(<HostedGlanceFixture>
            <BrowserPaneProbe />
            <SessionCompanionGlance entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'browser-b',
                definition: { kind: 'builtin', id: 'local_services' }, bindings: { session: { kind: 'value', value: { serverId: runtime.serverId, sessionId: selected.id } } } } } }}
                sessionId={session.id} session={session} serverId={runtime.serverId} frameStyle="plain" headerAccessory={null}
                measurementOnly={false} testID="browser-b" />
        </HostedGlanceFixture>);
        await flushHookEffects({ cycles: 8 });
        const navigationWrites = vi.spyOn(window.history, 'pushState');
        onTestFinished(() => navigationWrites.mockRestore());
        await act(async () => { screen.pressByTestId('browser-b.surface.row.inventory:web.open'); });
        await flushHookEffects({ cycles: 3 });
        const probe = screen.tree.root.findByType('BrowserPaneProbe');
        expect(probe.props.a).toEqual([]);
        expect(probe.props.b).toMatchObject([{ kind: 'browser-view', resource: { target: { kind: 'externalUrl', url: 'http://127.0.0.1:8081/' } } }]);
        expect(navigationWrites.mock.calls.map(([, , href]) => href)).toEqual([
            `/session/session-b/details?serverId=${runtime.serverId}`,
        ]);
        const navigation: WorkspaceNavigationContextValue = screen.tree.root.findByType('WorkspaceOwner').props.navigation;
        const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
        expect(hrefForDestinationRef(workspaceCatalog, tab.target)).toBe(`/session/session-b/details?serverId=${runtime.serverId}`);
    });
    it('routes configured Summary Git and Changes review into B destinations from the physical A destination', async () => {
        const selected = await hydrateSelectedSession();
        const scm = ScmWorkingSnapshotSchema.parse({ projectKey: 'machine-1:/repo', fetchedAt: 1,
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
        storage.getState().updateSessionProjectScmSnapshot(selected.id, scm, runtime.serverId);
        const screen = await renderScreen(<HostedGlanceFixture>
            {(['session_summary', 'changes'] as const).map(id => <SessionCompanionGlance key={id}
                entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id,
                    definition: { kind: 'builtin', id }, bindings: { session: { kind: 'value', value: { serverId: runtime.serverId, sessionId: selected.id } } } } } }}
                sessionId={session.id} session={session} serverId={runtime.serverId} frameStyle="plain" headerAccessory={null}
                measurementOnly={false} testID={id} />)}
        </HostedGlanceFixture>);
        await flushHookEffects({ cycles: 5 });
        const navigationWrites = vi.spyOn(window.history, 'pushState');
        onTestFinished(() => navigationWrites.mockRestore());
        await act(async () => { screen.pressByTestId('session_summary.surface-fact-changes'); screen.pressByTestId('changes.surface.open'); });
        expect(navigationWrites.mock.calls.map(([, , href]) => href)).toEqual([
            `/session/session-b?serverId=${runtime.serverId}&right=git`,
            `/session/session-b/details?serverId=${runtime.serverId}&details=scmReview`,
        ]);
        expect(parseSessionPaneUrlState({ right: 'git' })).toEqual({ rightTabId: 'git' });
    });
    it('opens the configured Summary usage fact at B through the existing qualified route owner', async () => {
        const selected = await hydrateSelectedSession();
        const contextSnapshot: SessionContextUsageSnapshotV1 = { v: 1, modelId: null, usedTokens: 40, windowTokens: 100, totalProcessedTokens: null,
            baselineTokens: null, isAutoCompactEnabled: null, categories: null, observedAtMs: 1, source: 'provider_turn' };
        storage.getState().applyMessages(selected.id, [{
            id: 'usage-b', localId: null, createdAt: 1, role: 'agent', isSidechain: false,
            content: [], usage: { input_tokens: 1, output_tokens: 1, contextSnapshot },
        }]);
        const screen = await renderScreen(<GlanceFixture><SessionCompanionGlance
            entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'summary-b',
                definition: { kind: 'builtin', id: 'session_summary' }, bindings: { session: { kind: 'value', value: { serverId: runtime.serverId, sessionId: selected.id } } } } } }}
            sessionId={session.id} session={session} serverId={runtime.serverId} frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="summary-b" />
        </GlanceFixture>);
        await flushHookEffects({ cycles: 5 });
        expect(screen.findByTestId('summary-b.surface-fact-context')).not.toBeNull();
        expect(screen.findByTestId('summary-b.surface-fact-context')?.props.onPress).toEqual(expect.any(Function));
        await act(async () => { screen.findByTestId('summary-b.surface-fact-context')?.props.onPress(); });
        expect(router.push).toHaveBeenCalledWith(`/session/session-b/usage?serverId=${runtime.serverId}`);
    });
    it('mounts a configured native services copy through the shared surface and its incumbent feeds, without plugin execution', async () => {
        await hydrateSelectedSession(session);
        const screen = await renderScreen(<runtime.Wrapper><SessionCompanionGlance
            entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'native-services',
                definition: { kind: 'builtin', id: 'local_services' }, bindings: { session: { kind: 'context', slot: 'session' } } } } }}
            sessionId={session.id} session={session} serverId={runtime.serverId} frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="native" />
        </runtime.Wrapper>);
        await flushHookEffects({ cycles: 8 });
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
        expect(screen.tree.root.findAllByType('PluginInlineSurfaceHost')).toHaveLength(0);
        expect(boundary.projection).not.toHaveBeenCalled();
        expect(screen.tree.root.findAllByType(HappierWidgetFrame)).toHaveLength(1);
    });
    it('reads a pinned native copy from B beside A and refuses a lost B read without starting another feed', async () => {
        const selected = await hydrateSelectedSession();
        boundary.rpc.mockImplementation(({ method, payload }: { method: string; payload?: { sessionId?: string } }) =>
            method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {})
                : Promise.resolve(successfulRead(method, [], payload?.sessionId)));
        const renderCopy = () => <GlanceFixture><SessionCompanionGlance
            entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'pinned-services',
                definition: { kind: 'builtin', id: 'local_services' }, bindings: { session: { kind: 'value', value: { serverId: runtime.serverId, sessionId: selected.id } } } } } }}
            sessionId={session.id} session={session} serverId={runtime.serverId} frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="pinned" />
        </GlanceFixture>;
        const screen = await renderScreen(<GlanceFixture>{null}</GlanceFixture>);
        await flushHookEffects({ cycles: 8 });
        const descriptorReads = boundary.projection.mock.calls.length;
        await screen.update(renderCopy());
        await flushHookEffects({ cycles: 8 });
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
        const launcherReads = boundary.rpc.mock.calls.map(([input]) => input)
            .filter(input => input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT);
        expect(launcherReads.length).toBeGreaterThan(0);
        for (const request of launcherReads) expect(request).toMatchObject({ payload: { sessionId: selected.id } });
        const reads = boundary.rpc.mock.calls.length;
        expect(boundary.projection.mock.calls).toHaveLength(descriptorReads);
        await act(async () => { storage.getState().applySessions([{ ...selected,
            access: { ...selected.access!, capabilities: { ...selected.access!.capabilities, readTranscript: false } } }]); });
        await screen.update(renderCopy());
        await flushHookEffects({ cycles: 4 });
        expect(screen.getTextContent()).not.toContain('widgetGlances.nothingRunning');
        expect(boundary.rpc.mock.calls).toHaveLength(reads);
        // The app-wide provider describes its Machine catalog independently of
        // this native copy. Losing B read access must start neither another
        // descriptor read nor a plugin renderer.
        expect(boundary.projection.mock.calls).toHaveLength(descriptorReads);
        expect(screen.tree.root.findAllByType('PluginInlineSurfaceHost')).toHaveLength(0);
    });
    it('admits a configured plugin copy with the exact hydrated shell Session', async () => {
        const entry = widgetProjectionEntry({ pluginId: 'acme.review', localId: 'status' });
        boundary.projection.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true, source: { kind: 'local', locator: '/plugins/acme.review' } } }, familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry } } } }) });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true, source: { kind: 'local', locator: '/plugins/acme.review' } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entry.id]: entry } } } }));
        const screen = await renderScreen(<runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: 'machine-1', serverId: runtime.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
            reloadConnectedAccountProjection() {}, reloadClientExecutables() {},
        }}><SessionCompanionGlance entry={{ kind: 'instance', ref: { kind: 'instance', instance: { v: 1, id: 'personal-status', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'status' } }, bindings: { session: { kind: 'context', slot: 'session' } } } } }} sessionId={session.id} session={session} serverId={runtime.serverId} frameStyle="plain" headerAccessory={null} measurementOnly={false} testID="plugin" /></AppShellPluginUiProjectionValueProvider></runtime.Wrapper>);
        await flushHookEffects({ cycles: 8 });
        // The real configured arm got past typed input and hydration admission.
        expect(screen.tree.root.findAllByType('PluginInlineSurfaceHost')).toHaveLength(1);
    });

    it('keeps the Services state identity when a scan only advances observation clocks', async () => {
        const entry = (observedAt: number): LocalServiceInventoryRow => ({ id: 'web', machineId: 'machine-1', address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            endpoint: { scheme: 'http', host: '127.0.0.1', port: 8081, probeState: 'ready', probedAt: observedAt },
            port: 8081, protocol: 'tcp', detectedAt: 1, lastSeenAt: observedAt, state: 'listening', source: 'detected', labels: [],
            confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high', diagnostics: [] });
        const key = { machineId: 'machine-1', serverId: resolveMachineDaemonReadServerId(runtime.serverId),
            accountId: 'account-a', credentialKey: resolveAuthCredentialsScopeKey(runtime.credentials) };
        const scan = (generatedAt: number) => ({ v: 1 as const, machineId: 'machine-1', generatedAt, refreshState: 'idle' as const,
            entries: [entry(generatedAt)], diagnostics: [] });
        boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH
            ? new Promise(() => {}) : Promise.resolve(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
                ? { protocolVersion: 1, snapshot: LocalServiceLauncherSnapshotV1Schema.parse({ v: 1, machineId: 'machine-1', sessionId: 'session-a', updatedAt: 1234, targets: [serviceTarget] }) }
                : { protocolVersion: 1, snapshot: scan(1234) }));
        observeMachinePresenceForTest({ serverId: runtime.serverId, accountId: 'account-a' }, ['machine-1']);
        const screen = await renderServices();
        const state = () => screen.findByType(LocalServicesGlanceView).props.state;
        await vi.waitFor(() => expect(state()).toMatchObject({ kind: 'ready' }));
        const before = state();
        await act(async () => { publishLocalServiceInventorySnapshot(key, scan(2345)); });
        await flushHookEffects({ cycles: 6 });
        expect(state()).toBe(before);
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
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning'));
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
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning'));
    });

    it('retains launcher rows and offers Retry after a launcher refresh fails', async () => {
        boundary.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {}) : Promise.resolve(successfulRead(method, [serviceTarget])));
        const screen = await renderServices();
        expect(screen.getTextContent()).toContain('web');
        expect(screen.findByTestId('services.asOf')).toBeNull();
        const { invalidateLocalServiceLauncherStore } = await import('@/sync/domains/local/services/launch/sharedStore');
        const accountScope = runtime.accountScope;
        if (!accountScope) throw new Error('Expected the admitted fixture Account');
        boundary.rpc.mockRejectedValue(new Error('offline'));
        await act(async () => { invalidateLocalServiceLauncherStore({ machineId: 'machine-1', serverId: runtime.serverId,
            accountId: accountScope.accountId, credentialKey: resolveAuthCredentialsScopeKey(runtime.credentials),
            sessionId: 'session-a', scope: 'workspace', workspaceRoot: resolveWorkspaceScopeForSession('session-a')?.rootPath ?? null }); });
        await flushHookEffects({ cycles: 6 });
        await vi.waitFor(() => {
            expect(screen.findByTestId('services.row.inventory:web')).toBeTruthy();
            expect(screen.findByTestId('services.stale-action')).toBeTruthy();
            expect(screen.findByTestId('services.asOf')).toBeTruthy();
        });
    });
});

// Native plugin rendering is an external runtime boundary; assert admission
// through the real host resolver before it executes a renderer bundle.
vi.mock('@/components/plugins/surfaces', () => ({ PluginInlineSurfaceHost: (props: Record<string, unknown>) => React.createElement('PluginInlineSurfaceHost', props) }));
