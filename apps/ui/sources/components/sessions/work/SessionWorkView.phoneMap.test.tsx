import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';

import { createDeferred, createMachineFixture, createRenderCommitCounter, createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { selectSessionReportSubtree } from './reportSubtree';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { CurrentSessionPresentationActionInputV1Schema, type CurrentSessionPresentationIntentResultV1 } from '@happier-dev/protocol/sessions';
import type { PresentationService } from '@happier-dev/plugin-sdk/interactions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const routerPush = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const deviceDimensions = vi.hoisted(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 }));
// External authors use this public service contract; the real host schema and mounted bridge consume it below.
const workIntents = {
    list: { kind: 'work.view.select', view: 'list' },
    map: { kind: 'work.view.select', view: 'map' },
    recent: { kind: 'work.recent.show_more' },
    expand: { kind: 'work.map.expand' },
} satisfies Record<string, Parameters<PresentationService['present']>[0]>;

installSessionSubagentCommonModuleMocks({
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => deviceDimensions, addEventListener: () => ({ remove() {} }) },
        });
    },
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/lead', params: () => routeParams.current, router: { push: routerPush } }).module;
});
installDisconnectedServerSocketBoundary();

const { createWorkflowActionHttpTransport } = await import('@/dev/testkit/fixtures/workflowActionHttpTransport');
const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');

// Keep the Work producer, launcher, selectors, pane and header publication real.
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { storage } = await import('@/sync/domains/state/storage');
const syncRuntime = await import('@/sync/sync');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
const { PaneHeader } = await import('@/components/appShell/panes/PaneHeader');
const { PaneHeaderActions } = await import('@/components/appShell/panes/PaneHeaderActions');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');
const { SessionWorkSourcesProvider, useSessionWorkSources, useSessionWorkSourcesOwner } = await import('./sessionWorkSources');
const { SessionWorkView } = await import('./SessionWorkView');
const { SessionWorkMapDetailsView } = await import('./SessionWorkMapDetailsView');
const { SessionPresentedSurfacePresentationTarget } = await import('@/components/sessions/companion/presentation/SessionPresentedSurfacePresentationTarget');
const { readSessionPresentationAdapterAtAddress } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const { createExecutionRunLauncherDetailsTab, createInteractiveExecutionRunDraftDetailsTab, createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab } = await import('@/components/sessions/runs/launcher/executionRunLauncherModel');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');

function PaneProbe(props: Readonly<{ scopeId: string; onPane: (pane: AppPaneScopeApi) => void }>) {
    const pane = useAppPaneScope(props.scopeId);
    React.useLayoutEffect(() => props.onPane(pane), [pane, props.onPane]);
    return null;
}

function WorkHeader() {
    const published = usePublishedPaneHeaderContent('work');
    return <PaneHeader size="large" title="Work" line={published?.line} actions={
        <PaneHeaderActions published={published} title="Work" testID="phone-work-header" />
    } />;
}

function CountedWorkMap(props: Readonly<{ serverId: string; counter: ReturnType<typeof createRenderCommitCounter> }>) {
    // Instrument the Map's real source subscription; the positive control also checks its painted node.
    useSessionWorkSources();
    useRenderCommitCounter(props.counter);
    return <SessionWorkMapDetailsView sessionId="lead" serverId={props.serverId}
        scopeId={createSessionPaneScopeId('lead', props.serverId)} />;
}

function WorkHost(props: Readonly<{ serverId: string; onPane?: (pane: AppPaneScopeApi) => void;
    presentationTarget?: boolean; showWork?: boolean; workPresented?: boolean;
    children?: React.ReactNode;
    onSources?: (sources: ReturnType<typeof useSessionWorkSourcesOwner>) => void }>) {
    const activity = useSessionAgentActivity({ sessionId: 'lead', serverId: props.serverId });
    const sources = useSessionWorkSourcesOwner({ sessionId: 'lead', serverId: props.serverId,
        ownerMetadata: storage.getState().sessions.lead?.metadata ?? null, agentActivity: activity });
    React.useLayoutEffect(() => props.onSources?.(sources), [props.onSources, sources]);
    const scopeId = createSessionPaneScopeId('lead', props.serverId);
    const workView = props.showWork !== false ? <SessionWorkView sessionId="lead" serverId={props.serverId} scopeId={scopeId} /> : null;
    return <SessionWorkSourcesProvider value={sources}>
        {props.presentationTarget ? <SessionPresentedSurfacePresentationTarget sessionId="lead" serverId={props.serverId}
            presented openBoard={() => ({ status: 'unavailable' })}
            revealBoardItem={() => ({ status: 'unavailable' })} returnToChat={() => ({ status: 'unchanged' })}
            openFullSurface={() => ({ status: 'unavailable' })} /> : null}
        <AppPaneProvider>
            {props.children}
            {props.onPane ? <PaneProbe scopeId={scopeId} onPane={props.onPane} /> : null}
            <PaneHeaderSlotProvider>
                <WorkHeader />
                <PaneHeaderSlotScope slotKey="work">
                    <SurfaceStateSizeProvider size="phone">
                        {props.presentationTarget ? (
                            <PluginSurfaceFocusEligibilityProvider active={props.workPresented !== false}>
                                {workView}
                            </PluginSurfaceFocusEligibilityProvider>
                        ) : workView}
                    </SurfaceStateSizeProvider>
                </PaneHeaderSlotScope>
            </PaneHeaderSlotProvider>
        </AppPaneProvider>
    </SessionWorkSourcesProvider>;
}

afterEach(async () => {
    deviceDimensions.width = 390;
    routeParams.current = {};
    await standardCleanup();
});

/**
 * A Session with a turn in flight. An idle Session ends its List row with a quiet time and folds out of the Map
 * (lab `session-A2`), so journeys that need a drawn node use a working one.
 */
function workingTurn() {
    const now = Date.now();
    return { active: true, activeAt: now, presence: 'online', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now } as const;
}

describe('phone Work List → Map', () => {
    it('settles Map and commits nothing for unrelated Session arrivals', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-map-counts.test', serverIdentityId: 'srv_work_map_counts', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.serverId;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const lead = createSessionFixture({ id: 'lead', serverId });
        const child = createSessionListRenderableSessionFixture({ id: 'mapped-child', serverId, manager: { sessionId: 'lead' }, ...workingTurn() });
        const unrelated = Array.from({ length: 1_000 }, (_, i) => createSessionFixture({ id: `unrelated-${i}`, serverId }));
        storage.setState({ sessions: { lead, ...Object.fromEntries(unrelated.map(session => [session.id, session])) },
            sessionListRowsByServerId: { [serverId]: { [child.id]: child } } });
        const counts = createRenderCommitCounter();
        const mapCounts = createRenderCommitCounter();
        const screen = await renderScreen(<React.Profiler id="work-map" onRender={counts.commit}>
            <WorkHost serverId={serverId} presentationTarget>
                <CountedWorkMap serverId={serverId} counter={mapCounts} />
            </WorkHost>
        </React.Profiler>, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            expect(screen.findHostByTestId('session-work-map-details-node-session:mapped-child')).not.toBeNull();
            expect(mapCounts.read().commits).toBeGreaterThan(0);
            counts.reset();
            await act(async () => {
                readSessionPresentationAdapterAtAddress({ serverId, sessionId: 'lead' })?.apply(workIntents.map);
            });
            expect(screen.findHostByTestId('session-work-map-node-session:mapped-child')).not.toBeNull();
            // The view switch and its shared pane-header publication each commit once.
            expect(counts.read().commits).toBe(2);
            // Count the real Map subtree: other Work leaves have independent lifecycle updates.
            mapCounts.reset();
            for (let index = 0; index < 100; index++) {
                await act(async () => {
                    const current = storage.getState();
                    selectSessionReportSubtree(current.sessions, 'lead', connection.home.id, current.sessionListRowsByServerId);
                    storage.setState(state => ({ sessions: { ...state.sessions,
                        [unrelated[index]!.id]: { ...unrelated[index]!, seq: index + 1 },
                    } }));
                });
            }
            expect(mapCounts.read()).toEqual({ renders: 0, commits: 0 });
            await act(async () => {
                storage.setState({ sessionListRowsByServerId: { [serverId]: {
                    [child.id]: { ...child, metadata: { ...child.metadata!, name: 'Updated report' } },
                } } });
            });
            expect(screen.getTextContent()).toContain('Updated report');
            const detailNode = screen.findHostByTestId('session-work-map-details-node-session:mapped-child');
            expect(JSON.stringify(detailNode?.props.accessibilityLabel)).toContain('Updated report');
            expect(mapCounts.read().commits).toBeGreaterThan(0);
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    });

    it.each(['phone', 'desktop'] as const)('applies author intents to the mounted Work view on %s, retains disclosure across view switches, and retires on unmount', async device => {
        deviceDimensions.width = device === 'phone' ? 390 : 1400;
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-presentation.test', serverIdentityId: 'srv_work_presentation', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const lead = createSessionFixture({ id: 'lead', serverId });
        const children = Array.from({ length: 6 }, (_, i) => createSessionFixture({ id: `child-${i}`, serverId,
            manager: { sessionId: 'lead' }, latestTurnStatus: 'completed' }));
        const mappedChild = createSessionFixture({ id: 'mapped-child', serverId, manager: { sessionId: 'lead' }, ...workingTurn() });
        storage.setState({ sessions: { lead, [mappedChild.id]: mappedChild, ...Object.fromEntries(children.map(child => [child.id, child])) }, sessionListRowsByServerId: {} });
        let pane: AppPaneScopeApi | undefined;
        const screen = await renderScreen(<WorkHost serverId={serverId} presentationTarget onPane={next => { pane = next; }} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        const apply = async (raw: unknown) => {
            const { intent } = CurrentSessionPresentationActionInputV1Schema.parse({ intent: raw });
            let result: CurrentSessionPresentationIntentResultV1 | undefined;
            await act(async () => { result = readSessionPresentationAdapterAtAddress({ serverId, sessionId: 'lead' })?.apply(intent); });
            return result;
        };
        try {
            const scroll = screen.findHostByTestId('session-work-scroll');
            // The Goal row stands under the header on a phone too, where no composer is mounted beside the page
            // to offer it; beside the composer on desktop it follows what that composer offers (this session's has none).
                        expect(screen.getTextContent().includes('session.workState.goal.title')).toBe(device === 'phone');
            expect(screen.findByTestId('session-work-state-recent-more')).not.toBeNull();
            expect(await apply(workIntents.recent)).toEqual({ status: 'applied' });
            expect(screen.findByTestId('session-work-state-recent-more')).toBeNull();
            expect(await apply(workIntents.recent)).toEqual({ status: 'unchanged' });
            expect(await apply(workIntents.map)).toEqual({ status: 'applied' });
            // Finished leaves intentionally fold out of Map; the unfinished child's real node proves the view switched.
            expect(screen.findHostByTestId('session-work-map-node-session:mapped-child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-scroll')).toBe(scroll);
            expect(await apply(workIntents.map)).toEqual({ status: 'unchanged' });
            await screen.update(<WorkHost serverId={serverId} presentationTarget workPresented={false} />);
            expect(await apply(workIntents.list)).toEqual({ status: 'unavailable' });
            await screen.update(<WorkHost serverId={serverId} presentationTarget onPane={next => { pane = next; }} />);
            expect(await apply(workIntents.map)).toEqual({ status: 'unchanged' });
            expect(await apply(workIntents.expand)).toEqual({ status: device === 'phone' ? 'unavailable' : 'applied' });
            if (device === 'desktop') {
                expect(pane?.scopeState?.details?.tabs.some(tab => tab.key === 'sessionWorkMap:lead')).toBe(true);
                // Expansion lends the Map to Details without changing the sidebar's local preference.
                expect(screen.findByTestId('session-work-map-node-session:mapped-child')).toBeNull();
                expect(await apply(workIntents.list)).toEqual({ status: 'unchanged' });
                await act(async () => { pane!.closeDetails(); });
                expect(screen.findHostByTestId('session-work-map-node-session:mapped-child')).not.toBeNull();
                expect(await apply(workIntents.map)).toEqual({ status: 'unchanged' });
                expect(screen.findHostByTestId('session-work-scroll')).toBe(scroll);

                expect(await apply(workIntents.list)).toEqual({ status: 'applied' });
                expect(await apply(workIntents.expand)).toEqual({ status: 'applied' });
                expect(screen.findByTestId('session-work-map-node-session:mapped-child')).toBeNull();
                await act(async () => { pane!.closeDetailsTab('sessionWorkMap:lead'); });
                expect(await apply(workIntents.list)).toEqual({ status: 'unchanged' });
                expect(screen.findByTestId('session-work-map-node-session:mapped-child')).toBeNull();

                // Selecting another Details tab unmounts the expanded Map and restores the prior Map.
                expect(await apply(workIntents.map)).toEqual({ status: 'applied' });
                expect(await apply(workIntents.expand)).toEqual({ status: 'applied' });
                await act(async () => { pane!.openDetailsTab(createExecutionRunLauncherDetailsTab('plan'), { intent: 'pinned' }); });
                expect(screen.findHostByTestId('session-work-map-node-session:mapped-child')).not.toBeNull();
                // Asking for sidebar Map takes it back rather than showing it twice.
                expect(await apply(workIntents.expand)).toEqual({ status: 'applied' });
                expect(await apply(workIntents.map)).toEqual({ status: 'applied' });
                expect(pane?.scopeState?.details?.tabs.some(tab => tab.key === 'sessionWorkMap:lead')).toBe(false);
                expect(screen.findHostByTestId('session-work-map-node-session:mapped-child')).not.toBeNull();
            } else {
                expect(screen.findHostByTestId('session-work-map-node-session:mapped-child')).not.toBeNull();
            }
            await screen.pressByTestIdAsync('session-work-view:list');
            expect(screen.findByTestId('session-work-state-recent-more')).toBeNull();
            expect(screen.findHostByTestId('session-work-scroll')).toBe(scroll);
            await screen.update(<WorkHost serverId={serverId} presentationTarget showWork={false} />);
            expect(await apply(workIntents.map)).toEqual({ status: 'unavailable' });
            expect(await apply(workIntents.recent)).toEqual({ status: 'unavailable' });
            expect(readSessionPresentationAdapterAtAddress({ serverId: 'other-home', sessionId: 'lead' })).toBeNull();
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
            resetSessionDraftRepositoryForTests();
            await connection.dispose();
        }
    });
    it('reopens every retained start in the shared contextual Run destination on phone', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-draft.test', serverIdentityId: 'srv_phone_work_draft', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId }) }, sessionListRowsByServerId: {} });
        let pane: AppPaneScopeApi | undefined;
        const screen = await renderScreen(<WorkHost serverId={serverId} onPane={next => { pane = next; }} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            // A phone has no Details tab beside the Session: an unsent start lives in the Session draft and
            // its Run page, the same page "New agent conversation" opens, so reopening lands there.
            const conversation = createInteractiveExecutionRunDraftDetailsTab();
            const plan = createExecutionRunLauncherDetailsTab('plan');
            const secondOpinion = createExecutionRunLauncherDetailsTab('review', { roleId: 'second_opinion', title: 'Second opinion' });
            // A draft started from selected Discussion messages is its own draft, keyed by its correlation.
            const discussionSource = {
                kind: 'discussion' as const, serverId, discussionId: 'discussion_1',
                messageIds: ['message_1'], draftCorrelationId: 'selection_1',
            };
            const discussion = createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({ source: discussionSource, initialText: 'Investigate this' });
            const otherDiscussion = createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({
                source: { ...discussionSource, messageIds: ['message_2'], draftCorrelationId: 'selection_2' }, initialText: 'Investigate another selection',
            });
            await act(async () => {
                for (const [key, text] of [
                    ['conversation', 'Plain conversation draft'],
                    ['discussion:selection_1', 'First Discussion draft'],
                    ['discussion:selection_2', 'Second Discussion draft'],
                ]) {
                    writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: key!, patch: { text } } } });
                }
                pane!.openDetailsTab(discussion, { intent: 'pinned' });
                pane!.openDetailsTab(otherDiscussion, { intent: 'pinned' });
                pane!.openDetailsTab(conversation, { intent: 'pinned' });
                pane!.openDetailsTab(plan, { intent: 'pinned' });
                pane!.openDetailsTab(secondOpinion, { intent: 'pinned' });
            });
            expect(screen.findByTestId(`session-work-start-draft:${discussion.key}`)?.props.accessibilityLabel).toContain('First Discussion draft');
            expect(screen.findByTestId(`session-work-start-draft:${otherDiscussion.key}`)?.props.accessibilityLabel).toContain('Second Discussion draft');
            const { SessionAgentsLaunchMenu } = await import('@/components/sessions/agents/launch/SessionAgentsLaunchMenu');
            routerPush.mockClear();
            await act(async () => screen.tree.findByType(SessionAgentsLaunchMenu).props.launcher.openRun('review', {
                roleId: 'second_opinion', title: secondOpinion.title,
            }));
            expect(pane!.scopeState?.details.activeTabKey).toBe(secondOpinion.key);
            expect(routerPush).not.toHaveBeenCalled();
            for (const tab of [conversation, plan, secondOpinion, discussion, otherDiscussion]) {
                await screen.pressByTestIdAsync(`session-work-start-draft:${tab.key}`);
                expect(pane!.scopeState?.details.activeTabKey).toBe(tab.key);
                expect(routerPush).not.toHaveBeenCalled();
            }
            expect(pane!.scopeState?.details.tabs.find(tab => tab.key === discussion.key)?.resource)
                .toEqual(discussion.resource);
            await act(async () => pane!.closeDetailsTab(conversation.key));
            for (const [key, preview] of [
                ['conversation', 'Plain conversation draft'],
                [discussion.key, 'First Discussion draft'],
                [otherDiscussion.key, 'Second Discussion draft'],
            ]) {
                expect(screen.findByTestId(`session-work-start-draft:${key}`)?.props.accessibilityLabel).toContain(preview);
            }
            routerPush.mockClear();
            await screen.pressByTestIdAsync('session-work-start-draft:conversation');
            expect(pane!.scopeState?.details.activeTabKey).toBe(conversation.key);
            expect(routerPush).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    });

    it('lists a start whose unsent text no tab shows, reopens it on the phone, and drops it once cleared', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-retained.test', serverIdentityId: 'srv_phone_work_retained', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId }) }, sessionListRowsByServerId: {} });
        const screen = await renderScreen(<WorkHost serverId={serverId} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            expect(screen.findByTestId('session-work-start-draft:plan')).toBeFalsy();
            await act(async () => writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: 'plan', patch: { text: 'Plan the migration' } } } }));
            // The row says what the draft says, so a person can tell which unsent start it is.
            expect(screen.getTextContent()).toContain('Plan the migration');
            await act(async () => writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: 'plan', patch: { text: 'Plan the   rollout first\nand a second line' } } } }));
            expect(screen.getTextContent()).toContain('Plan the rollout first');
            expect(screen.getTextContent()).not.toContain('second line');
            routerPush.mockClear();
            await screen.pressByTestIdAsync('session-work-start-draft:plan');
            expect(routerPush).not.toHaveBeenCalled();
            expect(screen.findByTestId('session-work-start-draft:execution-run-launcher:plan')).toBeTruthy();
            await act(async () => writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: 'plan', patch: { text: '' } } } }));
            expect(screen.findByTestId('session-work-start-draft:plan')).toBeFalsy();
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
            resetSessionDraftRepositoryForTests();
            await connection.dispose();
        }
    });

    it('renders the same qualified children across a cold credential binding and a settled repeat', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-map.test', serverIdentityId: 'srv_phone_work_map', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const lead = createSessionFixture({ id: 'lead', serverId });
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const child = createSessionFixture({ id: 'child', serverId, manager: { sessionId: lead.id }, ...workingTurn() });
        const foreign = createSessionFixture({ id: 'foreign', serverId: 'another-home', manager: { sessionId: lead.id } });
        storage.setState({ sessions: { lead, child, foreign }, sessionListRowsByServerId: {} });
        const credentials = createDeferred<void>();
        let pendingReads = 0;
        // Credential storage is an external boundary. Restoration is complete; hold only the
        // mounted consumers' cold reads so the first view switch overlaps their publication.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => {
            pendingReads++;
            await credentials.promise;
            return connection.credentials;
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<WorkHost serverId={serverId} />, {
                wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
            });
            expect(pendingReads).toBeGreaterThan(0);
            const switchView = async (view: 'list' | 'map') => {
                const tab = screen!.findByTestId(`session-work-view:${view}`);
                expect(tab).not.toBeNull();
                await pressTestInstanceAsync(tab!);
            };
            await switchView('map');
            expect(screen.findHostByTestId('session-work-map-node-session:child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-map-node-session:foreign')).toBeNull();
            await act(async () => { credentials.resolve(); await credentials.promise; });
            await switchView('list');
            await switchView('map');
            expect(screen.findHostByTestId('session-work-map-node-session:child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-map-node-session:foreign')).toBeNull();
        } finally {
            credentialRead.mockRestore();
            credentials.resolve();
            await screen?.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    }, 180_000);
});

describe('Work pane after a child was archived', () => {
    it('says the archived child exists instead of inviting a first start, and offers it back', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-archived-child.test', serverIdentityId: 'srv_work_archived_child', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const lead = createSessionFixture({ id: 'lead', serverId });
        const hydrateRows = vi.spyOn(syncRuntime.sync, 'hydrateSessionListRows').mockResolvedValue(undefined);
        // The empty invitation is only said once the Session's transcript has loaded.
        storage.setState({ sessions: { lead }, sessionListRowsByServerId: {}, sessionMessages: { lead: createSessionMessagesFixture({ isLoaded: true }) } });
        const screen = await renderScreen(<WorkHost serverId={serverId} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            // A Session that never started anything keeps its invitation.
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-empty')).not.toBeNull());
            expect(screen.findHostByTestId('session-work-state-archived')).toBeNull();

            const archivedChild = createSessionFixture({ id: 'old-child', serverId, manager: { sessionId: lead.id }, archivedAt: 1_000 });
            await act(async () => storage.setState({ sessions: { lead, 'old-child': archivedChild } }));
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-state-archived')).not.toBeNull());
            expect(screen.findHostByTestId('session-work-empty')).toBeNull();
            expect(screen.findHostByTestId('session-work-unarchive:old-child')).not.toBeNull();
            // The archived row names itself from its own content: the pane demands it like the sidebar does.
            expect(hydrateRows).toHaveBeenCalledWith([{ serverId, sessionId: 'old-child' }]);
            // Nothing live to switch between, so no List | Map (the desktop header follows the same rule).
            expect(screen.findHostByTestId('session-work-view:list')).toBeNull();
            // The header line counts it, where it used to say nothing was started.
            expect(screen.getTextContent()).toContain('sessionWork.subtitle.archived');
            expect(screen.getTextContent()).not.toContain('sessionWork.subtitle.nothingStarted');
        } finally {
            hydrateRows.mockRestore();
            await screen.unmount();
            storage.setState(initial, true);
            resetSessionDraftRepositoryForTests();
            await connection.dispose();
        }
    }, 180_000);
});

describe('Work pane Managed by row', () => {
    it('says a top-level session is Top level and opens Put under from that row', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-managed-by.test', serverIdentityId: 'srv_work_managed_by', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show');
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId }) }, sessionListRowsByServerId: {},
            sessionMessages: { lead: createSessionMessagesFixture({ isLoaded: true }) } });
        const screen = await renderScreen(<WorkHost serverId={serverId} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-managed-by')).not.toBeNull());
            expect(screen.getTextContent()).toContain('entityDragDrop.keyboard.topLevel');
            const managedBy = screen.findByTestId('session-work-managed-by');
            expect(managedBy).not.toBeNull();
            await pressTestInstanceAsync(managedBy!);
            expect(show).toHaveBeenCalledWith(expect.objectContaining({ props: { sessionId: 'lead', serverId } }));
        } finally {
            show.mockRestore();
            await screen.unmount();
            storage.setState(initial, true);
            resetSessionDraftRepositoryForTests();
            await connection.dispose();
        }
    }, 180_000);
});

describe('Work pane while its machine is not answering', () => {
    it('keeps the last-known rows under one line with the honest time and a Retry that asks the Home again', async () => {
        const requested: string[] = [];
        let runReadFails = false;
        const run = createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', ownerAccountId: 'account',
            machineId: 'm1', origin: { kind: 'direct', originSessionId: 'lead' } });
        const boundary = createWorkflowActionHttpTransport({ accountId: () => 'account', fixtureResponse: async (actionId, input) => ({
            ok: true, result: actionId === 'workflow.run.list'
                ? { runs: input.attention ? [] : [run], metadataByRunId: input.attention ? {} : {
                    [run.id]: { kind: 'available', value: { title: 'Retained workflow' } },
                } }
                : { definitions: [], pluginWorkflows: [] },
        }) });
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-machine-offline.test', serverIdentityId: 'srv_work_machine_offline', accountId: 'account',
            configureSocket: configureConnectedServerSocketBoundary,
            credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
                provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
            })).toString('base64url')}.signature` },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                requested.push(path);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                    experiments: true, featureToggles: { automations: true },
                } }, version: 1 });
                if (path === '/v1/machines') {
                    return Response.json({}, { status: 503 });
                }
                if (path === '/v3/automations/runs/workflow-storage' && runReadFails) return Response.json({}, { status: 503 });
                return boundary.fetch(url, init);
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const lastHeartbeat = Date.now() - 20 * 60_000;
        const machine = createMachineFixture({ id: 'm1', active: false, activeAt: lastHeartbeat });
        const metadata = { machineId: 'm1', path: '/repo', host: 'host-1' };
        const lead = createSessionFixture({ id: 'lead', serverId, metadata });
        const child = createSessionFixture({ id: 'child', serverId, metadata, manager: { sessionId: lead.id } });
        storage.setState({ sessions: { lead, child }, sessionListRowsByServerId: {},
            settings: { ...initial.settings, experiments: true, featureToggles: { ...initial.settings.featureToggles, automations: true } } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        let observedSources: ReturnType<typeof useSessionWorkSourcesOwner> | undefined;
        const screen = await renderScreen(<WorkHost serverId={serverId} onSources={value => { observedSources = value; }} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        const diagnostic = vi.spyOn(console, 'info');
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-machine-offline')).not.toBeNull());
            await waitForHomeGovernance(() => expect(observedSources?.managedRuns.phase).toBe('loaded'));
            expect(screen.getTextContent()).toContain('Retained workflow');
            await act(async () => {
                runReadFails = true;
                publishHomeAccountChange(serverId, [`workflow-run:${run.id}`]);
            });
            await waitForHomeGovernance(() => expect(observedSources?.managedRuns.refreshFailed).toBe(true));
            requested.length = 0;
            await screen.pressByTestIdAsync('session-work-machine-offline-action');
            await waitForHomeGovernance(() => expect(requested).toContain('/v1/machines'));
            // The external diagnostic proves the rejected refresh settled before the next press;
            // otherwise the canonical in-flight owner correctly rejoins the still-pending attempt.
            await waitForHomeGovernance(() => expect(diagnostic).toHaveBeenCalledWith(
                '[fireAndForget] SessionWorkView.retryMachineReachability', expect.any(Error)));
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(SurfaceFreshnessLine).filter(line =>
                    line.props.testID === 'session-work-machine-offline' || line.props.testID === 'session-work-runs-stale')).toHaveLength(1);
                expect(screen.findHostByTestId('session-work-runs-stale')).toBeNull();
            });
            // The rows stay; the line says when they are from instead of leaving the offline state timeless.
            expect(screen.findHostByTestId('session-work-state-recent') ?? screen.findHostByTestId('session-work-state-working')
                ?? screen.findHostByTestId('session-work-state-needsYou')).not.toBeNull();
            expect(screen.getTextContent()).toMatch(/surfaceState\.asOf|As of/);
            // Let the rejecting external read settle: Vitest must report no unhandled rejection.
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-machine-offline-action')).not.toBeNull());
            expect(screen.findHostByTestId('session-work-state-recent') ?? screen.findHostByTestId('session-work-state-working')
                ?? screen.findHostByTestId('session-work-state-needsYou')).not.toBeNull();
            // A second press still reaches the Home and owns another rejection.
            requested.length = 0;
            diagnostic.mockClear();
            await screen.pressByTestIdAsync('session-work-machine-offline-action');
            await waitForHomeGovernance(() => expect(requested).toContain('/v1/machines'));
            await waitForHomeGovernance(() => expect(diagnostic).toHaveBeenCalledWith(
                '[fireAndForget] SessionWorkView.retryMachineReachability', expect.any(Error)));
            expect(screen.getTextContent()).toContain('Retained workflow');
            // Arrange the neighboring reachable-Machine state through its real store owner,
            // just as the initial offline state above; this does not certify census recovery.
            await act(async () => {
                storage.getState().applyMachines([
                    createMachineFixture({ id: 'm1', active: true, activeAt: Date.now() }),
                ], false, { sourceServerId: serverId });
                observeMachinePresenceForTest(draftScope, ['m1']);
            });
            expect(resolveServerScopedMachine(storage.getState(), serverId, 'm1')?.active).toBe(true);
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-machine-offline')).toBeNull());
            // A reachable Machine must not hide the independent retained Run failure.
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-runs-stale')).not.toBeNull());
            runReadFails = false;
            await screen.pressByTestIdAsync('session-work-runs-stale-action');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-runs-stale')).toBeNull());
            expect(screen.getTextContent()).toContain('Retained workflow');
        } finally {
            diagnostic.mockRestore();
            await screen.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    }, 180_000);
});
