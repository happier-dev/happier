import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, PluginProjectionV2Schema, SessionDiscussionOpenedSummaryV1Schema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { z } from 'zod';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { MountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import type { SessionDetailsPanelPluginRuntimeState } from './useSessionDetailsPanelPluginRuntime';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionBoardDetailsTab, createSessionCommitDetailsTab, createSessionDiscussionDetailsTab, createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({ features: {
        browser: { enabled: true, viewTargets: { enabled: true } },
    } }),
    request: async (url, init) => {
        if ((init?.method ?? 'GET') === 'GET' && new URL(String(url)).pathname === '/v1/machines/machine-1') {
            return Response.json({ machine: { id: 'machine-1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }
        return null;
    },
    configureSocket: socket => {
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            socket.id = 'browser-pane-socket';
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== 'rpc-call') throw new Error(`Unexpected Browser pane transport event: ${event}`);
            const request = z.object({ method: z.string(), params: z.unknown() }).passthrough().parse(payload);
            if (request.method === `machine-1:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
                return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                    protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 9, familiesById: {} }),
                }) };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});
beforeEach(async () => {
    vi.stubGlobal('location', { origin: 'https://pane-browser-client.test' });
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    expect((await getServerFeaturesSnapshot({ serverId: runtime.serverId, force: true })).status).toBe('ready');
});
afterEach(() => vi.unstubAllGlobals());

async function renderInput(tab: DetailsTabState, active = true): Promise<DetailsSurfaceRenderInputV1> {
    const { createDetailsSurfaceDescriptor } = await import('@/components/appShell/panes/details/surfaces');
    const scope = { kind: 'session' as const, sessionId: 's1', serverId: runtime.serverId, machineId: 'machine-1' };
    return { tab, scope, region: 'details', active,
        descriptor: createDetailsSurfaceDescriptor({ tab, scope, region: 'details' }),
        callbacks: { replaceTab: runtime.pane.replaceDetailsTab },
    };
}

async function renderers(overrides: Partial<Parameters<typeof import('./surfaces/sessionDetailsSurfaceRenderers')['createSessionDetailsSurfaceRenderers']>[0]> = {}) {
    const { createSessionDetailsSurfaceRenderers } = await import('./surfaces/sessionDetailsSurfaceRenderers');
    return createSessionDetailsSurfaceRenderers({
        sessionId: 's1', scopeId: 'session:s1', serverId: runtime.serverId, machineId: 'machine-1',
        requestClose: runtime.pane.closeDetails,
        openFileTab: (path, intent) => runtime.pane.openDetailsTab(createSessionFileDetailsTab(path), { intent }),
        getStartEditingFileHandler: () => () => {},
        sessionScreenTestIdsEnabled: true, closeDetailsTab: runtime.pane.closeDetailsTab,
        ...overrides,
    });
}

describe('SessionDetailsPanel browser product mount', () => {
    it('opens a pinned browser launchpad and retains its recording model when another destination is active', async () => {
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', activeAt: Date.now() })]);
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { BrowserDetailsSurface, createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const { DetailsSurfaceHost } = await import('@/components/appShell/panes/details/surfaces');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        await screen.pressByTestIdAsync('session-details-open-browser');
        const browserTabKey = createBrowserLaunchpadDetailsTab().key;
        const browserTab = runtime.pane.scopeState?.details.tabs.find(tab => tab.key === browserTabKey);
        expect(browserTab).toMatchObject({
            kind: 'browser-view', isPinned: true, isPreview: false,
            resource: { kind: 'browser-view', mode: 'launchpad' },
        });
        const initial = screen.tree.findByType(BrowserDetailsSurface);
        const recording = initial.props.productModels?.browserRecording;
        expect(recording?.state).toBeTruthy();
        expect(recording?.recordingCapabilities.enabled).toBe(false);
        await act(async () => runtime.pane.setActiveDetailsTab('file:a.txt'));
        const retained = screen.tree.findByType(BrowserDetailsSurface);
        expect(retained.props.productModels.browserRecording.state).toBe(recording.state);
        const host = screen.tree.findAllByType(DetailsSurfaceHost).find(node => node.props.tab.key === browserTabKey);
        expect(host?.props.active).toBe(false);
    });

    it('commit Back closes only the commit destination and preserves the other tab', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionCommitDetailsView } = await import('@/components/sessions/files/views/SessionCommitDetailsView');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        const commit = createSessionCommitDetailsTab('abc123');
        if (!commit) throw new Error('Expected a canonical commit tab');
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        await act(async () => runtime.pane.openDetailsTab(commit, { intent: 'pinned' }));
        const view = screen.tree.findByType(SessionCommitDetailsView);
        await act(async () => view.props.onBack());
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
        expect(runtime.pane.scopeState?.details.tabs.map(tab => tab.key)).toEqual(['file:a.txt']);
    });

    it('registers the browser details renderer with the hosted-plugin launchpad rows', async () => {
        const { BrowserDetailsSurface, createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        await renderScreen(<runtime.Wrapper />);
        const rows = [{
            id: 'pluginHostedWeb:preview-pane', section: 'plugin', sourceKind: 'hostedPluginWeb',
            title: 'Preview pane', subtitle: 'localhost:4173', detail: 'acme.preview',
            target: { kind: 'hostedPluginWeb', targetId: 'preview-pane', pluginId: 'acme.preview',
                contributionId: 'preview-pane', display: { title: 'Preview pane', addressLabel: 'localhost:4173' } },
            currentUrl: 'https://plugins.happier.test/preview-pane/', currentUrlExpiresAt: 3_000,
            disabledReason: null, lastSeenAt: 2_000,
        }] satisfies readonly BrowserLaunchpadRow[];
        const tab = { ...createBrowserLaunchpadDetailsTab(), isPinned: true, isPreview: false };
        const input = await renderInput(tab);
        const renderer = (await renderers({ launchpadRows: rows, launchpadRefreshStatus: 'idle', launchpadRefreshError: null }))
            .find(candidate => candidate.id === 'browser-view-details-surface');
        expect(renderer?.canRender(input)).toBe(true);
        const element = renderer?.render(input);
        if (!React.isValidElement<React.ComponentProps<typeof BrowserDetailsSurface>>(element)) throw new Error('Expected browser surface');
        expect(element.type).toBe(BrowserDetailsSurface);
        expect(element.props.launchpadRows).toBe(rows);
        expect(element.props.launchpadRefreshStatus).toBe('idle');
        expect(element.props.launchpadRefreshError).toBeNull();
    });

    it('renders the qualified admitted plugin destination and rejects a same-named foreign destination', async () => {
        await renderScreen(<runtime.Wrapper />);
        const { createPluginDetailsDestinationTab } = await import('@/components/appShell/panes/details/surfaces/pluginDetailsDestination');
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId: 'com.example.viewer', destinationId: 'workspace-file',
            rendererId: 'workspace-file-renderer', container: 'detailsTab',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        });
        if (!binding) throw new Error('Expected an admitted Session destination');
        const placement = {
            id: 'surfacePlacement:com.example.viewer:workspace-file', pluginId: 'com.example.viewer',
            occurrenceId: 'com-example-viewer-occurrence', contributionKind: 'surfacePlacement',
            descriptorId: 'workspace-file', binding, target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'workspace-file-renderer' },
            display: { developerFallback: 'Workspace file viewer' },
            availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
        } satisfies PluginUiSurfacePlacementProjection;
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 4, surfacePlacementsById: { [placement.id]: placement } };
        const renderer = (await renderers({ pluginUiProjection: projection, pluginUiProjectionPhase: 'current',
            pluginUiInteractionEnabled: true, platform: 'web' })).find(candidate => candidate.id === 'plugin-details-destination:session');
        expect(renderer).toBeDefined();
        for (const [pluginId, admitted] of [['com.example.viewer', true], ['com.example.other', false]] as const) {
            const tab = { ...createPluginDetailsDestinationTab({
                destination: { pluginId, localId: 'workspace-file' }, title: 'Workspace file viewer',
            }), isPinned: true, isPreview: false };
            const input = await renderInput(tab);
            // This generic renderer owns both accepted resources and their visible denial.
            expect(renderer?.canRender(input)).toBe(true);
            const element = renderer?.render(input);
            if (!React.isValidElement<{
                resolution: ReturnType<typeof import('@/components/appShell/panes/details/surfaces/pluginDetailsDestination')['resolvePluginDetailsDestinationPlacement']>;
            }>(element)) throw new Error('Expected the canonical plugin destination mount');
            expect(element.props.resolution).toMatchObject(admitted
                ? { kind: 'available', placement: { pluginId: 'com.example.viewer' } }
                : { kind: 'unavailable', reason: 'details_destination_not_admitted' });
        }
    });

    it.each([
        { phase: 'current' as const, interactionEnabled: true },
        { phase: 'retainedOffline' as const, interactionEnabled: false },
    ])('passes file context without granting interaction to a $phase projection', async ({ phase, interactionEnabled }) => {
        await renderScreen(<runtime.Wrapper />);
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 9 };
        const input = await renderInput({ ...createSessionFileDetailsTab('README.md'), isPinned: true, isPreview: false });
        const renderer = (await renderers({ pluginUiProjection: projection, pluginUiProjectionPhase: phase,
            pluginUiInteractionEnabled: true, platform: 'web' })).find(candidate => candidate.id === 'session-file');
        const element = renderer?.render(input);
        if (!React.isValidElement<React.ComponentProps<typeof import('./SessionDetailsPanelDetailViews')['SessionFileDetailsViewForPanel']>>(element)) {
            throw new Error('Expected the real file-view adapter');
        }
        expect(element.props.openableContentViewer).toMatchObject({
            targetKind: 'session', projection, details: input,
            scopedLaunchFacts: { serverId: runtime.serverId, machineId: 'machine-1', interactionEnabled },
        });
    });

    it('carries the real exact-Home caller runtime into Board and retires it when Session access disappears', async () => {
        const { createHappierSocket } = await import('@happier-dev/sync-client');
        const boundary = createHappierSocket({ endpoint: 'https://session-pane.test', token: 'socket-boundary-precondition', clientType: 'user-scoped' });
        try {
            expect(vi.isMockFunction(boundary.socket.connect), 'Happier Socket must consume the configured SDK network boundary').toBe(true);
        } finally {
            await boundary.transport.destroy();
        }
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', activeAt: Date.now() })]);
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        expect(await resolveServerCredentialAccountScope(runtime.serverId)).toMatchObject({
            kind: 'bound', scope: { serverId: runtime.serverIdentityId, accountId: 'account-a' },
        });
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionBoardDetailsSurface } = await import('@/components/sessions/board/SessionBoardDetailsSurface');
        const { SessionBoardControllerProvider, useMountedSessionBoardController } = await import('@/components/sessions/board/SessionBoardControllerProvider');
        const { useSessionDetailsPanelPluginRuntime } = await import('./useSessionDetailsPanelPluginRuntime');
        let mounted: MountedSessionBoardController | null = null;
        let projected: SessionDetailsPanelPluginRuntimeState | null = null;
        function Probe() {
            mounted = useMountedSessionBoardController({ serverId: runtime.serverId, sessionId: 's1' });
            projected = useSessionDetailsPanelPluginRuntime({ sessionId: 's1', routeServerId: runtime.serverId });
            return null;
        }
        const readMounted = () => mounted;
        const readProjected = () => projected;
        const screen = await renderScreen(<runtime.Wrapper><SessionBoardControllerProvider serverId={runtime.serverId} sessionId="s1">
            <Probe /><SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </SessionBoardControllerProvider></runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
        await flushHookEffects({ cycles: 30 });
        const caller = readMounted()?.callerHostedHtmlRuntime;
        expect(caller).not.toBeNull();
        if (!caller) throw new Error('Expected current exact-Home caller authority');
        expect(caller.serverIdentityId).toBe(runtime.serverIdentityId);
        expect(caller.accountId).toBe('account-a');
        expect(caller.lifetime.isCurrent()).toBe(true);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { isServerReachabilityNetworkAllowed, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const state = storage.getState();
        const machine = state.machines['machine-1'];
        const lifetime = captureActiveServerAccountScopeLifetime();
        const demandQualification = {
            endpointStatus: state.endpointStatus, endpointReason: state.endpointReason,
            machinePresent: Boolean(machine), machineOnline: machine ? isMachineOnline(machine) : false,
            accountScope: lifetime?.scope ?? null, accountCurrent: lifetime?.isCurrent() ?? null,
            networkAllowed: isServerReachabilityNetworkAllowed(),
            reachability: peekServerReachabilityState('https://session-pane.test'),
        };
        expect(readProjected(), `Projection qualification: ${JSON.stringify(demandQualification)}`).toMatchObject({
            phase: 'current', interactionEnabled: true, machineId: 'machine-1', serverId: runtime.serverId,
            pluginUiProjection: { generation: 9 },
        });
        expect(caller.admittedHostMethods).toEqual(expect.arrayContaining(['readResource', 'watchResource']));
        expect(screen.tree.findByType(SessionBoardDetailsSurface).props.callerHostedHtmlRuntime).toBe(caller);
        const controller = caller.createRequestController(() => {});
        const currentMachine = storage.getState().machines['machine-1'];
        if (!currentMachine) throw new Error('Expected the current Session Machine');
        await act(async () => storage.getState().applyMachines([{ ...currentMachine, active: false }]));
        await flushHookEffects();
        // An inactive Session RPC target is unavailable; it must not retain resource authority.
        expect(readProjected()).toMatchObject({ phase: 'unavailable', interactionEnabled: false, machineId: null });
        expect(caller.lifetime.isCurrent()).toBe(true);
        expect(readMounted()?.callerHostedHtmlRuntime?.admittedHostMethods).not.toEqual(expect.arrayContaining(['readResource', 'watchResource']));
        await expect(controller.handleRequest({
            requestId: 'offline-resource', method: 'readResource', payload: { resource: { pluginId: 'acme.review', localId: 'status' } },
        })).rejects.toThrow('caller_surface_retired');
        controller.dispose();
        const session = storage.getState().sessions.s1;
        const access = session.access;
        if (!access) throw new Error('Expected canonical Session access');
        await act(async () => storage.getState().applySessions([{ ...session, access: {
            ...access, capabilities: { ...access.capabilities, readTranscript: false },
        } }]));
        expect(storage.getState().sessions.s1.access?.capabilities.readTranscript,
            'The canonical Session producer must publish read-access revocation').toBe(false);
        await flushHookEffects();
        expect(caller.lifetime.isCurrent()).toBe(false);
    });

    it('replaces an opened discussion title under the same real tab key', async () => {
        await renderScreen(<runtime.Wrapper />);
        const { SessionDiscussionDetailsView } = await import('@/components/sessions/conversations/SessionDiscussionDetailsView');
        const tab = createSessionDiscussionDetailsTab({
            kind: 'discussion', address: { serverId: runtime.serverId, sessionId: 's1' }, discussionId: 'discussion-1',
        });
        await act(async () => runtime.pane.openDetailsTab(tab, { intent: 'pinned' }));
        // Linked discussions need a visible fallback before their Home title arrives.
        expect(runtime.pane.scopeState!.details.tabs[0].title.trim().length).toBeGreaterThan(0);
        const input = await renderInput(runtime.pane.scopeState!.details.tabs[0]);
        const renderer = (await renderers()).find(candidate => candidate.id === 'session-discussion');
        const element = renderer?.render(input);
        if (!React.isValidElement<React.ComponentProps<typeof SessionDiscussionDetailsView>>(element)) throw new Error('Expected discussion destination');
        const opened = SessionDiscussionOpenedSummaryV1Schema.parse({
            id: 'discussion-1', sessionId: 's1', creationLocalId: null, title: 'Release readiness',
            latestMessage: { id: 'message-1', localId: null, seq: 1, authorAccountId: null,
                accountActor: null, producerV1: null, createdAt: 1 },
            messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0,
            recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true },
        });
        await act(async () => element.props.onOpened?.(opened));
        expect(runtime.pane.scopeState?.details.tabs).toHaveLength(1);
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: tab.key, title: opened.title, isPinned: true });
    });
});
