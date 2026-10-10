import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeferred, createSessionFixture, createToolCallMessageFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createReducer } from '@happier-dev/session-core/reducer';
import { listPendingRequestLists } from '@happier-dev/session-core/pending';
import { createReadOnlySessionTranscriptSource } from './readOnlySessionTranscriptSource';
import { SessionTranscriptSourceMissingError, SessionTranscriptSourceProvider, useSessionTranscriptSource } from './SessionTranscriptSourceContext';
import { storage } from '@/sync/domains/state/storageStore';
import { useTranscriptNavigationSessionPresent } from '../navigation/useTranscriptNavigationSessionPresent';

afterEach(standardCleanup);

describe('read-only transcript source', () => {
    it('closes Send and Approve when custom interaction has no actions, while retaining local sample actions', () => {
        const interaction = { canSendMessages: true, canApprovePermissions: true };
        const input = { sessionId: 'sample', messages: [], reducerState: null, metadata: null, agentState: null, interaction };
        const closed = createReadOnlySessionTranscriptSource(input);
        expect(closed.actions).toBeNull();
        expect(closed.useInteraction()).toMatchObject({ canSendMessages: false, canApprovePermissions: false });
        const actions = { respondToPermission: async () => undefined, answerUserAction: async () => undefined,
            abort: async () => undefined, submitMessage: async () => undefined };
        const sample = createReadOnlySessionTranscriptSource({ ...input, actions });
        expect(sample.actions).toBe(actions);
        expect(sample.useInteraction()).toBe(interaction);
    });
    it('publishes changed coverage frontiers even when the loaded rows and older state are unchanged', async () => {
        const snapshot = { messages: [], reducerState: null, metadata: null, agentState: null,
            historyState: { isLoaded: true, hasOlder: false, hasNewer: true, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'static-frontiers', ...snapshot });
        const hook = await renderHook(() => source.history.useState());
        await act(async () => { source.update({ ...snapshot, historyState: { ...snapshot.historyState, hasNewer: false } }); });
        expect(hook.getCurrent()).toMatchObject({ hasOlder: false, hasNewer: false });
        await hook.unmount();
    });
    it('keeps a static navigation present independent of a colliding viewer Session', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'static-navigation', active: true, thinking: true, thinkingAt: Date.now(), activeAt: Date.now() });
        const source = createReadOnlySessionTranscriptSource({ sessionId: session.id, messages: [], reducerState: null, metadata: null, agentState: null });
        try {
            storage.setState({ sessions: { [session.id]: session } });
            const hook = await renderHook(() => useTranscriptNavigationSessionPresent(), {
                wrapper: (props) => <SessionTranscriptSourceProvider source={source}>{props.children}</SessionTranscriptSourceProvider>,
            });
            expect(hook.getCurrent()).toEqual({ newestTurn: null, offlineSinceMs: null, offline: false });
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('publishes older-page loading while preserving a share snapshot and clears it on failure', async () => {
        const page = createDeferred<never>();
        const snapshot = { messages: [], reducerState: null, metadata: null, agentState: null, historyState: { isLoaded: true, hasOlder: true, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'share-loading', ...snapshot, loadOlder: () => page.promise });
        const hook = await renderHook(() => source.history.useState());
        let loading!: Promise<unknown>;
        await act(async () => { loading = source.history.loadOlder!(); });
        expect(hook.getCurrent()).toEqual({ isLoaded: true, hasOlder: true, isLoadingOlder: true });
        await act(async () => { source.update(snapshot); });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);
        const rejected = expect(loading).rejects.toThrow('page unavailable');
        await act(async () => { page.reject(new Error('page unavailable')); await rejected; });
        expect(hook.getCurrent()).toEqual(snapshot.historyState);
        await hook.unmount();
    });
    it('reads nested materialized tool children without borrowing app state', async () => {
        const child = createToolCallMessageFixture({ id: 'nested-child' });
        const parent = createToolCallMessageFixture({ id: 'parent', children: [child] });
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'demo', messages: [parent], reducerState: createReducer(), metadata: null, agentState: null });
        const row = await renderHook(() => source.useMessage(child.id));
        expect(row.getCurrent()).toBe(child);
        const ids = await renderHook(() => source.useMessageIdsOldestFirst());
        expect(ids.getCurrent()).toEqual([parent.id]);
        await row.unmount();
        await ids.unmount();
    });
    it('requires a presentation source instead of borrowing the viewer store', async () => {
        await expect(renderHook(useSessionTranscriptSource)).rejects.toBeInstanceOf(SessionTranscriptSourceMissingError);
    });

    it('does not subscribe shared transcript common state to a colliding viewer Session server', async () => {
        const { useTranscriptSessionCommon } = await import('../transcriptSessionCommon');
        const { usePreferredServerIdForSession } = await import('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession');
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'shared-collision', serverId: 'viewer-home-a' });
        const source = createReadOnlySessionTranscriptSource({ sessionId: session.id, messages: [], reducerState: null, metadata: null, agentState: null });
        const wrapper = (props: React.PropsWithChildren) => <SessionTranscriptSourceProvider source={source}>{props.children}</SessionTranscriptSourceProvider>;
        let renders = 0;
        try {
            storage.setState({ sessions: { [session.id]: session } });
            const control = await renderHook(() => usePreferredServerIdForSession({ sessionId: session.id }));
            const common = await renderHook(() => { renders += 1; return useTranscriptSessionCommon(); }, { wrapper });
            expect(control.getCurrent()).toBe('viewer-home-a');
            const before = renders;
            const commonBefore = common.getCurrent();
            await act(async () => {
                storage.setState({ sessions: { [session.id]: { ...session, serverId: 'viewer-home-b' } } });
            });
            expect(control.getCurrent()).toBe('viewer-home-b');
            expect(renders).toBe(before);
            expect(common.getCurrent()).toBe(commonBefore);
            expect(common.getCurrent().fork.sessionForkSupportSource).toBeNull();
            expect(common.getCurrent().toolChrome.serverId).toBeNull();
            await common.unmount();
            await control.unmount();
        } finally {
            standardCleanup();
            storage.setState(previous, true);
        }
    });

    it('keeps its context and unchanged row subscriptions stable across an append', async () => {
        const first = createToolCallMessageFixture({ id: 'first' });
        const second = createToolCallMessageFixture({ id: 'second' });
        const reducerState = createReducer();
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'shared', messages: [first], reducerState, metadata: null, agentState: null });
        const wrapper = (props: React.PropsWithChildren) => <SessionTranscriptSourceProvider source={source}>{props.children}</SessionTranscriptSourceProvider>;
        let renders = 0;
        const row = await renderHook(() => { renders += 1; const current = useSessionTranscriptSource(); return { current, message: current.useMessage('first') }; }, { wrapper });
        const before = renders;
        await act(async () => { source.update({ messages: [first, second], reducerState, metadata: null, agentState: null }); });
        expect(renders).toBe(before);
        expect(row.getCurrent()).toEqual({ current: source, message: first });
        const list = await renderHook(() => { const current = useSessionTranscriptSource(); return current.useMessageIdsOldestFirst(); }, { wrapper });
        expect(list.getCurrent()).toEqual(['first', 'second']);
    });

    it('projects pending requests from its real dataset and keeps every mutation closed', async () => {
        const message = createToolCallMessageFixture({ tool: { name: 'Bash', state: 'running', input: {}, createdAt: 1, startedAt: 1, completedAt: null, description: null, permission: { id: 'permission', status: 'pending' } } });
        const messages = [message];
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'shared', messages, reducerState: createReducer(), metadata: null, agentState: null });
        const hook = await renderHook(() => ({ interaction: source.useInteraction(), pending: source.usePendingRequests(), connection: source.useConnectionState() }));
        expect(hook.getCurrent().pending).toEqual(listPendingRequestLists({ sessionId: 'shared', active: true, agentState: null, actionConfirmations: null, presentationCompletedRequests: null, projected: null }, messages));
        expect(hook.getCurrent().interaction.canApprovePermissions).toBe(false);
        expect(hook.getCurrent().interaction.canSendMessages).toBe(false);
        expect(hook.getCurrent().connection).toBe('static');
        expect(source.actions).toBeNull();
        expect(source.navigate).toBeNull();
        expect(source.loadSidechain).toBeNull();
        expect(source.history.loadTargetWindow).toBeNull();
    });
});
