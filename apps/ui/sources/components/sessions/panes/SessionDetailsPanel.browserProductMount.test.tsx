import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDiscussionOpenedSummaryV1Schema } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { MountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { t } from '@/text';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionBoardDetailsTab, createSessionCommitDetailsTab, createSessionDiscussionDetailsTab, createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();
beforeEach(() => vi.stubGlobal('location', { origin: 'https://pane-browser-client.test' }));
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
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { BrowserDetailsSurface } = await import('@/components/browser/surfaces');
        const { DetailsSurfaceHost } = await import('@/components/appShell/panes/details/surfaces');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionFileDetailsTab('a.txt'), { intent: 'pinned' }));
        await screen.pressByTestIdAsync('session-details-open-browser');
        const browserTab = runtime.pane.scopeState?.details.tabs.find(tab => tab.key === 'browser:launchpad');
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
        const host = screen.tree.findAllByType(DetailsSurfaceHost).find(node => node.props.tab.key === 'browser:launchpad');
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
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionBoardDetailsSurface } = await import('@/components/sessions/board/SessionBoardDetailsSurface');
        const { SessionBoardControllerProvider, useMountedSessionBoardController } = await import('@/components/sessions/board/SessionBoardControllerProvider');
        let mounted: MountedSessionBoardController | null = null;
        function Probe() {
            mounted = useMountedSessionBoardController({ serverId: runtime.serverId, sessionId: 's1' });
            return null;
        }
        const readMounted = () => mounted;
        const screen = await renderScreen(<runtime.Wrapper><SessionBoardControllerProvider serverId={runtime.serverId} sessionId="s1">
            <Probe /><SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </SessionBoardControllerProvider></runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
        await flushHookEffects({ cycles: 30 });
        const caller = readMounted()?.callerHostedHtmlRuntime;
        expect(caller).not.toBeNull();
        if (!caller) throw new Error('Expected current exact-Home caller authority');
        expect(caller.serverIdentityId).toBe(runtime.serverId);
        expect(caller.accountId).toBe('account-a');
        expect(caller.lifetime.isCurrent()).toBe(true);
        expect(screen.tree.findByType(SessionBoardDetailsSurface).props.callerHostedHtmlRuntime).toBe(caller);
        const session = storage.getState().sessions.s1;
        const access = session.access;
        if (!access) throw new Error('Expected canonical Session access');
        await act(async () => storage.getState().applySessions([{ ...session, access: {
            ...access, capabilities: { ...access.capabilities, readTranscript: false },
        } }]));
        expect(caller.lifetime.isCurrent()).toBe(false);
    });

    it('replaces an opened discussion title under the same real tab key', async () => {
        await renderScreen(<runtime.Wrapper />);
        const { SessionDiscussionDetailsView } = await import('@/components/sessions/conversations/SessionDiscussionDetailsView');
        const tab = createSessionDiscussionDetailsTab({
            kind: 'discussion', address: { serverId: runtime.serverId, sessionId: 's1' }, discussionId: 'discussion-1',
        });
        expect(tab.title).toBe(t('session.collaboration.discussion.title'));
        await act(async () => runtime.pane.openDetailsTab(tab, { intent: 'pinned' }));
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
