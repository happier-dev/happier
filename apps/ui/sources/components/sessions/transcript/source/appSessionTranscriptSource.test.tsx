import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Message } from '@happier-dev/session-core/messages';
import {
    createSessionAccessFixture, createSessionFixture, createSessionListRenderableSessionFixture, createSessionMessagesFixture, createToolCallMessageFixture,
    renderHook, renderScreen, standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { listPendingRequestListsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { AppSessionTranscriptSourceProvider, TranscriptOriginSourceProvider, useSessionIntentionalRestartSourceEvents, useTranscriptMessage, useTranscriptMessagesByRefs } from './appSessionTranscriptSource';
import { useSessionTranscriptSource } from './SessionTranscriptSourceContext';
import type { SessionTranscriptSource } from './types';
import { useChatListRootState } from '../useChatListRootState';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { nowServerMs } from '@/sync/runtime/time';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionCompanionContent } from '@/components/sessions/companion/SessionCompanionContent';
import { SessionCompanionScreen } from '@/components/sessions/companion/SessionCompanionScreen';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';
import { SESSION_SUMMARY_COMPANION_ITEM } from '@/components/sessions/companion/state/sessionCompanionPreference';

const { routerPush, routerSetParams } = vi.hoisted(() => ({ routerPush: vi.fn(), routerSetParams: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/session/source-jump',
    router: { push: routerPush, setParams: routerSetParams },
}).module);

const { sessionRpcTransport } = vi.hoisted(() => ({ sessionRpcTransport: vi.fn() }));
// Metro's lazy import is the loader boundary; keep the singleton and operations real.
vi.mock('@/sync/runtime/getSyncSingleton', async () => (await import('@/dev/testkit/harness/syncSingletonLoader')).createSyncSingletonLoaderMock());
// Replace only the canonical socket transport boundary. The app source,
// permission behavior, operation and preferred-Session scope resolver stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return installServerScopedSessionRpcModuleMock({ sessionRpcWithServerScope: sessionRpcTransport })(importOriginal);
});

afterEach(standardCleanup);
beforeEach(async () => {
    sessionRpcTransport.mockReset(); sessionRpcTransport.mockResolvedValue(undefined);
    routerPush.mockClear(); routerSetParams.mockClear();
    await loadSyncSingletonForTests();
});

describe('app transcript source', () => {
    it('projects both active target-window frontiers through source history and observes window-only changes', async () => {
        const { sync } = await import('@/sync/syncEngine');
        const { activateSessionMessagesWindow, createInactiveSessionMessagesWindowState } = await import('@/sync/runtime/sessionMessagesWindowState');
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'source-find-frontiers', metadata: null });
        const owner = sync as unknown as { setSessionTargetWindowState(id: string, state: ReturnType<typeof createInactiveSessionMessagesWindowState>): void };
        const initialWindow = sync.getSessionTargetWindowState(session.id);
        try {
            storage.getState().applySessions([session]);
            storage.getState().applyMessagesLoaded(session.id);
            const hook = await renderHook(() => useSessionTranscriptSource().history.useState(), {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            await act(async () => { owner.setSessionTargetWindowState(session.id, activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
                windowId: `${session.id}:main:seq:100`, targetSeq: 100, windowMinSeq: 95, windowMaxSeq: 105,
                olderCursor: 95, newerCursor: 105, hasMoreOlder: false, hasMoreNewer: true, activatedAtMs: Date.now(),
            })); });
            expect(hook.getCurrent()).toMatchObject({ hasOlder: false, hasNewer: true, targetWindow: { targetSeq: 100, olderCursor: 95, newerCursor: 105 } });
            await act(async () => { owner.setSessionTargetWindowState(session.id, { ...sync.getSessionTargetWindowState(session.id), hasMoreNewer: false }); });
            expect(hook.getCurrent()).toMatchObject({ hasOlder: false, hasNewer: false });
            await hook.unmount();
        } finally { owner.setSessionTargetWindowState(session.id, initialWindow); storage.setState(previous); }
    });
    it('notifies restart recovery only when switch evidence changes, preserving streamed-message locality', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'source-restart-events', active: true });
        const first = createToolCallMessageFixture({ id: 'first' });
        const initial = createSessionMessagesFixture({ messageIdsOldestFirst: [first.id], messagesById: { first }, isLoaded: true });
        let renders = 0;
        try {
            storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: initial } });
            const hook = await renderHook(() => { renders += 1; return useSessionIntentionalRestartSourceEvents(); }, {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            const before = renders;
            const events = hook.getCurrent();
            await act(async () => { storage.setState({ sessionMessages: { [session.id]: { ...initial, messagesVersion: 1, messagesById: { first: { ...first, seq: 2 } } } } }); });
            expect(renders).toBe(before);
            expect(hook.getCurrent()).toBe(events);
            const switchEvent = { id: 'switch', kind: 'agent-event', localId: null, createdAt: 2, event: { type: 'connected-service-account-switch', serviceId: 'anthropic', groupId: null, fromProfileId: null, toProfileId: null, reason: 'manual', mode: 'restart_resume' } } satisfies Message;
            await act(async () => { storage.setState({ sessionMessages: { [session.id]: { ...initial, messagesVersion: 2, messageIdsOldestFirst: [first.id, switchEvent.id], messagesById: { first, switch: switchEvent } } } }); });
            expect(hook.getCurrent()).toEqual([{ event: switchEvent.event, createdAtMs: 2 }]);
            const switchEvidence = hook.getCurrent();
            await act(async () => { storage.setState({ sessionMessages: { [session.id]: { ...initial, messagesVersion: 3, messageIdsOldestFirst: [], messagesById: {}, isLoaded: false } } }); });
            expect(hook.getCurrent()).toBe(switchEvidence);
            await act(async () => { storage.setState({ sessionMessages: { [session.id]: { ...initial, messagesVersion: 4, messageIdsOldestFirst: [], messagesById: {}, isLoaded: true } } }); });
            expect(hook.getCurrent()).toEqual([]);
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('refreshes awareness at the canonical runtime freshness boundary without a store update', async () => {
        const previous = storage.getState();
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const session = createSessionFixture({ id: 'source-awareness-time', active: true, activeAt: nowServerMs(), thinking: true, thinkingAt: nowServerMs(), pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
        try {
            storage.setState({ sessions: { [session.id]: session } });
            const hook = await renderHook(() => useSessionTranscriptSource().useAwareness(), {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            const before = hook.getCurrent();
            expect(before).toEqual(projectUiSessionAwareness(session, nowServerMs()));
            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            expect(hook.getCurrent()).toEqual(projectUiSessionAwareness(session, nowServerMs()));
            expect(hook.getCurrent()?.operational.primary).not.toBe(before?.operational.primary);
            await hook.unmount();
        } finally { vi.useRealTimers(); storage.setState(previous); }
    });
    it('uses the source interaction for the ChatList root even when the live Session allows sending', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'source-read-only-list', active: true });
        const interaction: TranscriptInteraction = { canSendMessages: false, canApprovePermissions: false, canFork: false, permissionDisabledReason: 'readOnly' };
        try {
            storage.setState({ sessions: { [session.id]: session } });
            const hook = await renderHook(() => useChatListRootState({ session, sessionSurfaceKey: 'source-read-only-list' }), {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id} interaction={interaction}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            expect(hook.getCurrent().internalProps.interaction).toEqual(interaction);
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('does not notify pending-only consumers for transcript changes when projected counts prove no pending requests', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'source-no-pending', active: true, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
        const first = createToolCallMessageFixture({ id: 'first' });
        const initial = createSessionMessagesFixture({ messageIdsOldestFirst: [first.id], messagesById: { first }, isLoaded: true });
        let renders = 0;
        try {
            storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: initial } });
            const hook = await renderHook(() => { renders += 1; return useSessionTranscriptSource().usePendingRequests(); }, {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            const before = renders;
            const pending = hook.getCurrent();
            await act(async () => {
                storage.setState({ sessionMessages: { [session.id]: { ...initial, messagesVersion: 1, messagesById: { first: { ...first, seq: 2 } } } } });
            });
            expect(renders).toBe(before);
            expect(hook.getCurrent()).toBe(pending);
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('keeps a mounted message reader valid when its row moves between current and ancestor provenance', async () => {
        const previous = storage.getState();
        const own = createToolCallMessageFixture({ id: 'shared-id', seq: 1 });
        const ancestor = createToolCallMessageFixture({ id: 'shared-id', seq: 2 });
        try {
            storage.setState({
                sessionMessages: {
                    child: createSessionMessagesFixture({ messageIdsOldestFirst: [own.id], messagesById: { [own.id]: own }, isLoaded: true }),
                    ancestor: createSessionMessagesFixture({ messageIdsOldestFirst: [ancestor.id], messagesById: { [ancestor.id]: ancestor }, isLoaded: true }),
                },
            });
            const hook = await renderHook((props: { origin: string }) => useTranscriptMessage('shared-id', props.origin), {
                initialProps: { origin: 'child' },
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId="child">{props.children}</AppSessionTranscriptSourceProvider>,
            });
            expect(hook.getCurrent()).toBe(own);
            await hook.rerender({ origin: 'ancestor' });
            expect(hook.getCurrent()).toBe(ancestor);
            await hook.rerender({ origin: 'child' });
            expect(hook.getCurrent()).toBe(own);
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('keeps mixed-group readers valid and ordered as current and ancestor provenance changes', async () => {
        const previous = storage.getState();
        const own = createToolCallMessageFixture({ id: 'group-id', seq: 1 });
        const ancestor = createToolCallMessageFixture({ id: 'group-id', seq: 2 });
        try {
            storage.setState({ sessionMessages: {
                'group-child': createSessionMessagesFixture({ messageIdsOldestFirst: [own.id], messagesById: { [own.id]: own }, isLoaded: true }),
                'group-ancestor': createSessionMessagesFixture({ messageIdsOldestFirst: [ancestor.id], messagesById: { [ancestor.id]: ancestor }, isLoaded: true }),
            } });
            const childRef = { sessionId: 'group-child', messageId: own.id };
            const ancestorRef = { sessionId: 'group-ancestor', messageId: ancestor.id };
            const hook = await renderHook((refs: readonly typeof childRef[]) => useTranscriptMessagesByRefs(refs), {
                initialProps: [childRef],
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId="group-child">{props.children}</AppSessionTranscriptSourceProvider>,
            });
            expect(hook.getCurrent()).toEqual([own]);
            await hook.rerender([ancestorRef]);
            expect(hook.getCurrent()).toEqual([ancestor]);
            await hook.rerender([ancestorRef, childRef]);
            expect(hook.getCurrent()).toEqual([ancestor, own]);
            const unchanged = hook.getCurrent();
            await hook.rerender([{ ...ancestorRef }, { ...childRef }]);
            expect(hook.getCurrent()).toBe(unchanged);
            await hook.rerender([childRef, ancestorRef]);
            expect(hook.getCurrent()).toEqual([own, ancestor]);
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('disables transcript navigation for a frame while retaining session actions', async () => {
        const hook = await renderHook(() => useSessionTranscriptSource(), {
            wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId="embedded" navigation="none">{props.children}</AppSessionTranscriptSourceProvider>,
        });
        expect(hook.getCurrent().navigate).toBeNull();
        expect(hook.getCurrent().actions).not.toBeNull();
        expect(routerPush).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps paired and nested presentation roots bound to their own session', async () => {
        const seen: Record<string, string> = {};
        function Probe(props: { name: string }) {
            seen[props.name] = useSessionTranscriptSource().sessionId;
            return null;
        }
        const screen = await renderScreen(<>
            <AppSessionTranscriptSourceProvider sessionId="primary" serverId="home-a">
                <Probe name="primary" />
                <AppSessionTranscriptSourceProvider sessionId="chain" serverId="home-a">
                    <Probe name="chain" />
                </AppSessionTranscriptSourceProvider>
            </AppSessionTranscriptSourceProvider>
            <AppSessionTranscriptSourceProvider sessionId="embedded" serverId="home-b">
                <Probe name="embedded" />
            </AppSessionTranscriptSourceProvider>
        </>);
        expect(seen).toEqual({ primary: 'primary', chain: 'chain', embedded: 'embedded' });
        await screen.unmount();
    });

    it('keeps the source and unrelated row identity stable across interaction changes and a real-store append', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'source-session', serverId: 'source-home', active: true });
        const first = createToolCallMessageFixture({ id: 'first' });
        const second = createToolCallMessageFixture({ id: 'second' });
        const initial = createSessionMessagesFixture({ messageIdsOldestFirst: [first.id], messagesById: { first }, isLoaded: true });
        const allowed: TranscriptInteraction = { canSendMessages: true, canApprovePermissions: true };
        const denied: TranscriptInteraction = { canSendMessages: false, canApprovePermissions: false };
        let current: SessionTranscriptSource | null = null;
        let rowRenders = 0;
        function ContextProbe() { current = useSessionTranscriptSource(); return null; }
        const RowProbe = React.memo(function RowProbe() { rowRenders += 1; const source = useSessionTranscriptSource(); expect(source.useMessage('first')).toBe(first); return null; });
        function InteractionProbe() { const source = useSessionTranscriptSource(); return <React.Fragment>{String(source.useInteraction().canApprovePermissions)}</React.Fragment>; }
        const body = <><ContextProbe /><RowProbe /><InteractionProbe /></>;
        try {
            storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: initial } });
            const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id} serverId={session.serverId} interaction={allowed}>{body}</AppSessionTranscriptSourceProvider>);
            const before = current;
            const beforeRowRenders = rowRenders;
            await screen.update(<AppSessionTranscriptSourceProvider sessionId={session.id} serverId={session.serverId} interaction={denied}>{body}</AppSessionTranscriptSourceProvider>);
            expect(current).toBe(before);
            await act(async () => { storage.setState({ sessionMessages: { [session.id]: { ...initial, messagesVersion: 1, messageIdsOldestFirst: ['first', 'second'], messagesById: { first, second } } } }); });
            expect(current).toBe(before);
            expect(rowRenders).toBe(beforeRowRenders);
            await screen.unmount();
        } finally { storage.setState(previous); }
    });

    it('projects canonical pending requests and delivers the Companion answer through the shared app action owner', async () => {
        const previous = storage.getState();
        const message = createToolCallMessageFixture({ id: 'pending-tool', tool: { name: 'Bash', state: 'running', input: { command: 'pwd' }, createdAt: 1, startedAt: 1, completedAt: null, description: null, permission: { id: 'permission', status: 'pending' } } });
        const serverId = getActiveServerSnapshot().serverId;
        const session = createSessionFixture({
            id: 'source-pending', serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            agentState: { requests: { permission: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 1, turnId: 'pending-turn' } } },
        });
        function Companion() {
            const controller = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface: routerPush });
            // This mounted selection is component input, not a replacement for
            // the real preference, pending-request, or permission-answer owners.
            return <SessionCompanionContent
                session={session} serverId={serverId}
                controller={{ ...controller, preference: { ...controller.preference, items: [SESSION_SUMMARY_COMPANION_ITEM] } }}
                boardBinding={null} resolvePrimaryHost={() => null}
            />;
        }
        try {
            storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: createSessionMessagesFixture({ messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, isLoaded: true }) } });
            const hook = await renderHook(() => useSessionTranscriptSource().usePendingRequests(), { wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider> });
            expect(hook.getCurrent()).toEqual(listPendingRequestListsFromSession(session, [message]));
            const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id} serverId={serverId}>
                <Companion />
            </AppSessionTranscriptSourceProvider>);
            expect(screen.findByTestId('session-companion-content-summary-allow')).not.toBeNull();
            await screen.pressByTestIdAsync('session-companion-content-summary-allow');
            expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
                sessionId: session.id, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
                payload: { id: 'permission', turnId: 'pending-turn', approved: true },
            }));
            // Delivery is not the host's updated pending-request projection.
            expect(screen.findByTestId('session-companion-content-summary-ask')).not.toBeNull();
            await act(async () => { storage.getState().applySessions([{
                // A loaded pending tool remains evidence until the host covers
                // that exact request with its canonical completion fact.
                ...session, agentState: { requests: {}, completedRequests: { permission: {
                    tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 1, completedAt: 2, status: 'approved',
                } } }, agentStateVersion: session.agentStateVersion + 1,
                updatedAt: session.updatedAt + 1,
            }]); });
            expect(hook.getCurrent()).toEqual({ permissionRequests: [], userActionRequests: [] });
            expect(screen.findByTestId('session-companion-content-summary-ask')).toBeNull();
            expect(screen.findByTestId('session-companion-content-summary-answered')).not.toBeNull();
            await hook.unmount();
            await screen.unmount();
        } finally { storage.setState(previous); }
    });

    it('changes real-store edit permission mode only after a delivered approval', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'source-edit-mode', active: true, permissionMode: 'default' });
        try {
            storage.setState({ sessions: { [session.id]: session } });
            const hook = await renderHook(() => useSessionTranscriptSource(), {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            const actions = hook.getCurrent().actions;
            if (!actions) throw new Error('live app source must expose actions');
            sessionRpcTransport.mockRejectedValueOnce(new Error('transport unavailable'));
            await expect(actions.respondToPermission({ id: 'edit-request', approved: true, mode: 'acceptEdits' })).rejects.toThrow('transport unavailable');
            expect(storage.getState().sessions[session.id]?.permissionMode).toBe('default');

            await act(async () => { await actions.respondToPermission({ id: 'edit-request', approved: true, mode: 'acceptEdits' }); });
            expect(storage.getState().sessions[session.id]?.permissionMode).toBe('safe-yolo');
            expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
                sessionId: session.id, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
                payload: { id: 'edit-request', approved: true, mode: 'acceptEdits' },
            }));
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('delivers the standalone Companion answer through its exact Session action owner without transcript context', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const session = createSessionFixture({
            id: 'standalone-companion-permission', serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            agentState: { requests: { permission: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 1, turnId: 'standalone-turn' } } },
        });
        try {
            storage.setState({ sessions: { [session.id]: session }, profileScope: { serverId, accountId: 'standalone-account' } });
            const controller = await renderHook(() => useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface: routerPush }));
            await act(async () => { expect(controller.getCurrent().show()).not.toBeNull(); });
            await controller.unmount();
            // Deliberately no transcript provider: the standalone surface binds
            // the shared app action owner directly to its exact Session.
            const screen = await renderScreen(<SessionCompanionScreen
                sessionId={session.id} address={{ sessionId: session.id, serverId }}
                resolvePrimaryHost={() => null} onRevealBoardItem={routerPush} onRequestClose={routerPush}
            />);
            expect(screen.findByTestId('session-companion-content-summary-allow')).not.toBeNull();
            await screen.pressByTestIdAsync('session-companion-content-summary-allow');
            expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
                sessionId: session.id, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
                payload: { id: 'permission', turnId: 'standalone-turn', approved: true },
            }));
            // The standalone root observes the same real Session projection.
            expect(screen.findByTestId('session-companion-content-summary-ask')).not.toBeNull();
            await act(async () => { storage.getState().applySessions([{
                ...session, agentState: { requests: {} }, agentStateVersion: session.agentStateVersion + 1,
                updatedAt: session.updatedAt + 1,
            }]); });
            expect(screen.findByTestId('session-companion-content-summary-ask')).toBeNull();
            expect(screen.findByTestId('session-companion-content-summary-answered')).not.toBeNull();
            await screen.unmount();
        } finally { storage.setState(previous); }
    });

    it.each([
        { flavor: 'claude', modeAfterStop: 'read-only' },
        { flavor: 'codex', modeAfterStop: 'acceptEdits' },
    ] as const)('preserves $flavor stop permission policy in the real store', async ({ flavor, modeAfterStop }) => {
        const previous = storage.getState();
        const session = createSessionFixture({
            id: `source-stop-${flavor}`, active: true, permissionMode: 'acceptEdits',
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor },
        });
        try {
            storage.setState({ sessions: { [session.id]: session } });
            const hook = await renderHook(() => useSessionTranscriptSource(), {
                wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={session.id}>{props.children}</AppSessionTranscriptSourceProvider>,
            });
            const actions = hook.getCurrent().actions;
            if (!actions) throw new Error('live app source must expose actions');
            await act(async () => { await actions.respondToPermission({ id: 'stop-request', approved: false, decision: 'abort' }); });
            expect(storage.getState().sessions[session.id]?.permissionMode).toBe(modeAfterStop);
            expect(sessionRpcTransport.mock.calls.map(([request]) => request.method))
                .toEqual([RPC_METHODS.SESSION_PERMISSION_RESPOND, 'abort']);
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it.each([
        { presentationAllowsInspection: false, ancestorAllowsInspection: true },
        { presentationAllowsInspection: true, ancestorAllowsInspection: false },
        { presentationAllowsInspection: true, ancestorAllowsInspection: true },
    ])('makes inherited app rows inspect-only without losing the ancestor dataset or authorship ($presentationAllowsInspection/$ancestorAllowsInspection)', async ({ presentationAllowsInspection, ancestorAllowsInspection }) => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const viewerScope = { serverId, accountId: 'viewer-account' };
        const ancestor = createSessionFixture({ id: 'ancestor', serverId, active: true, hasOtherNamedCollaborator: true, access: createSessionAccessFixture('owner', { readTranscript: ancestorAllowsInspection }) });
        const child = createSessionFixture({ id: 'child', serverId, active: true, hasOtherNamedCollaborator: false });
        const inheritedMessage = createToolCallMessageFixture({ id: 'inherited-message' });
        try {
            storage.setState({
                sessions: { ancestor, child }, profileScope: viewerScope,
                sessionListRowsByServerId: { [serverId]: {
                    ancestor: createSessionListRenderableSessionFixture({ id: ancestor.id, active: true, access: ancestor.access, hasOtherNamedCollaborator: ancestor.hasOtherNamedCollaborator }),
                    child: createSessionListRenderableSessionFixture({ id: child.id, active: true, access: child.access, hasOtherNamedCollaborator: child.hasOtherNamedCollaborator }),
                } },
                sessionMessages: { ancestor: createSessionMessagesFixture({
                    messageIdsOldestFirst: [inheritedMessage.id], messagesById: { [inheritedMessage.id]: inheritedMessage }, isLoaded: true,
                }) },
            });
            const hook = await renderHook(() => {
                const source = useSessionTranscriptSource();
                return { source, interaction: source.useInteraction(), authorship: source.useAuthorship(), message: source.useMessage(inheritedMessage.id) };
            }, { wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={child.id} serverId={serverId} interaction={{ canSendMessages: true, canApprovePermissions: true, canOpenFiles: presentationAllowsInspection, canPreviewMedia: presentationAllowsInspection }}>
                <TranscriptOriginSourceProvider originSessionId={ancestor.id} readOnly>{props.children}</TranscriptOriginSourceProvider>
            </AppSessionTranscriptSourceProvider> });
            const { source, interaction, authorship, message } = hook.getCurrent();
            expect(source.kind).toBe('app');
            expect(source.sessionId).toBe(ancestor.id);
            expect(source.serverId).toBe(serverId);
            expect(message).toBe(inheritedMessage);
            expect(authorship).toEqual({ viewerScope, hasOtherNamedCollaborator: true });
            expect(interaction).toMatchObject({ canSendMessages: false, canApprovePermissions: false, canOpenFiles: presentationAllowsInspection && ancestorAllowsInspection, canPreviewMedia: presentationAllowsInspection && ancestorAllowsInspection, permissionDisabledReason: 'readOnly' });
            expect(source.actions).toBeNull();
            expect(source.navigate).toBeNull();
            expect(source.history.loadOlder).toBeNull();
            expect(source.history.loadTargetWindow).toBeNull();
            expect(source.loadSidechain).toBeNull();
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('jumps within the exact current Session without pushing a duplicate destination', async () => {
        const sessionId = 'source-jump';
        const serverId = 'home-a';
        const hook = await renderHook(() => useSessionTranscriptSource(), {
            wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={sessionId} serverId={serverId}>{props.children}</AppSessionTranscriptSourceProvider>,
        });
        const navigate = hook.getCurrent().navigate;
        if (!navigate) throw new Error('live app source must expose navigation');
        await act(async () => { navigate(buildScopedSessionRouteHref({ sessionId, serverId, query: { jumpSeq: 42 } })); });
        expect(routerSetParams).toHaveBeenCalledWith({ jumpSeq: '42' });
        expect(routerPush).not.toHaveBeenCalled();

        const destinations = [
            buildScopedSessionRouteHref({ sessionId: 'another-session', serverId, query: { jumpSeq: 42 } }),
            buildScopedSessionRouteHref({ sessionId, serverId: 'home-b', query: { jumpSeq: 42 } }),
            buildScopedSessionRouteHref({ sessionId, serverId, suffix: '/file', query: { path: '/project/file.ts' } }),
        ];
        await act(async () => { for (const href of destinations) navigate(href); });
        expect(routerPush.mock.calls.map(([href]) => href)).toEqual(destinations);
        expect(routerSetParams).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });
});
