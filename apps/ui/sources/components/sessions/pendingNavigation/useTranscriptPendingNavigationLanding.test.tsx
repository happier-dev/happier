import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage, TranscriptOlderPageLoadResult } from '@happier-dev/session-core/messages';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { TranscriptJumpResult } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';

// The socket boundary must be installed before any runtime consumer loads socket.io-client.
installDisconnectedServerSocketBoundary();
const { renderHook, renderScreen, standardCleanup, createSessionFixture, createPlainSessionByIdResponseFixture, createSessionMessagesFixture, flushHookEffects } = await import('@/dev/testkit');
const { createReducer } = await import('@happier-dev/session-core/reducer');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { useSessionTranscriptSource } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
const { setPendingNavigationLanding, clearPendingNavigationState, usePendingNavigationLanding } = await import('@/activity/source/pendingNavigationRuntime');
const { usePendingPromptLanding } = await import('@/components/tools/shell/permissions/usePendingPromptPrimaryFocus');
const { createTranscriptJumpHostTestHarness, restoreTranscriptJumpEnvironment } = await import('@/components/sessions/transcript/viewport/jump/host/transcriptJumpHostTestHarness');
const { TranscriptPendingNavigationLanding, useTranscriptPendingNavigationLanding } = await import('./useTranscriptPendingNavigationLanding');
const { PendingNavigationSettledNotice } = await import('./PendingNavigationSettledNotice');
await loadSyncSingletonForTests();
// `sync` is assigned by the singleton loader, so read it only after loading.
const { sync } = await import('@/sync/sync');
afterEach(() => { clearPendingNavigationState(); standardCleanup(); });

function sessionSnapshot(id: string) {
    return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
        id, createdAt: 1, updatedAt: 10, seq: 10, active: true, activeAt: 10,
        metadata: { path: '/tmp', host: 'fixture-host', name: 'Older request' },
    })));
}

describe('Next landing through the mounted transcript jump host', () => {
    it('does not subscribe to reducer detail when no Next landing is active', async () => {
        const environment = await restoreTranscriptJumpEnvironment();
        const address = { serverId: environment.home.id, sessionId: 's1' };
        let commits = 0;
        const harness = createTranscriptJumpHostTestHarness();
        function Boundary() {
            const jump = harness.useOwner(harness.props());
            return <React.Profiler id="landing" onRender={() => { commits++; }}>
                <TranscriptPendingNavigationLanding address={address} isLoaded hasOlder={false} loadOlder={null}
                    messagesById={{}} items={[]} setToolCallsGroupExpanded={() => {}}
                    waitForVisualUpdate={async () => {}} jumpToTarget={jump.jumpToTranscriptTarget} />
            </React.Profiler>;
        }
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="s1" serverId={address.serverId}><Boundary /></AppSessionTranscriptSourceProvider>);
        try {
            await flushHookEffects();
            const baseline = commits;
            await React.act(async () => { getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
                s1: { ...state.sessionMessages.s1, reducerState: createReducer() } } })); });
            expect(commits).toBe(baseline);
        } finally { await screen.unmount(); await environment.dispose(); }
    });
    it('waits for hydration, reveals a sequence-less request, and transfers focus to its transcript answer', async () => {
        const environment = await restoreTranscriptJumpEnvironment();
        const address = { serverId: environment.home.id, sessionId: 's1' };
        const tool: ToolCallMessage = { kind: 'tool-call', id: 'internal-tool', localId: null, createdAt: 1,
            tool: { id: 'request', name: 'Bash', state: 'running', input: { command: 'touch note.txt' },
                createdAt: 1, startedAt: 1, completedAt: null, description: null,
                permission: { id: 'request', status: 'pending' } }, children: [] };
        const messages = { [tool.id]: tool };
        const rows = [{ kind: 'message' as const, id: 'row-tool', messageId: tool.id, createdAt: 1, seq: null }];
        const harness = createTranscriptJumpHostTestHarness({ rows, messages });
        let jumpResult: TranscriptJumpResult | undefined;
        setPendingNavigationLanding(address, 'request');
        const hook = await renderHook((loaded: boolean) => {
            const jump = harness.useOwner(harness.props({ isLoaded: loaded }));
            useTranscriptPendingNavigationLanding({ address, isLoaded: loaded, focused: true, hasOlder: false, loadOlder: null, messagesById: loaded ? messages : {},
                items: rows, setToolCallsGroupExpanded: () => {}, waitForVisualUpdate: async () => {},
                jumpToTarget: async (target, options) => { jumpResult = await jump.jumpToTranscriptTarget(target, options); return jumpResult; } });
            return { landing: usePendingPromptLanding('request', tool.id), serverId: useSessionTranscriptSource().serverId };
        }, { initialProps: false, wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId="s1" serverId={address.serverId}>{children}</AppSessionTranscriptSourceProvider> });
        try {
            expect(harness.native.indexWrites).toEqual([]);
            expect(hook.getCurrent().landing).toBeNull();
            await React.act(async () => { getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
                s1: createSessionMessagesFixture({ messageIdsOldestFirst: [tool.id], messagesById: messages, isLoaded: true }) } })); });
            await hook.rerender(true);
            await flushHookEffects();
            await vi.waitFor(() => expect(jumpResult).toMatchObject({ status: 'scrolled' }));
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 0 });
            expect(hook.getCurrent().serverId).toBe(address.serverId);
            expect(hook.getCurrent().landing).toMatchObject({ requestId: 'request', focusTarget: 'transcript' });
        } finally { await hook.unmount(); await environment.dispose(); }
    });
    it('loads an older request through the session history owner after opening the session', async () => {
        const environment = await restoreTranscriptJumpEnvironment(() => Response.json({ messages: [{
            id: 'wire-request', seq: 1, localId: null, createdAt: 1, updatedAt: 1,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call', callId: 'request', name: 'Bash', input: { permissionId: 'request', status: 'pending', command: 'touch note.txt' },
            } } } },
        }], hasMore: false, nextBeforeSeq: null }), sessionSnapshot);
        const address = { serverId: environment.home.id, sessionId: 's1' };
        expect(await sync.ensureSessionVisibleForMessageRoute('s1', { serverId: address.serverId,
            forceRefresh: true, hydrateMessages: false })).toMatchObject({ kind: 'available' });
        const tail = { kind: 'user-text' as const, id: 'tail', localId: null, realID: 'wire-tail', seq: 10, createdAt: 10, text: 'Continue' };
        getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
            s1: createSessionMessagesFixture({ messageIdsOldestFirst: [tail.id], messagesById: { [tail.id]: tail }, isLoaded: true }) } }));
        const harness = createTranscriptJumpHostTestHarness();
        let olderResult: TranscriptOlderPageLoadResult | undefined;
        setPendingNavigationLanding(address, 'request');
        const hook = await renderHook(() => {
            const source = useSessionTranscriptSource();
            const messages = source.useMessagesById();
            const ids = source.useMessageIdsOldestFirst();
            const history = source.history.useState();
            harness.messages.current = messages;
            harness.rows.current = ids.flatMap(id => messages[id] ? [messages[id]] : []).map(message => ({ kind: 'message', id: 'row-' + message.id,
                messageId: message.id, createdAt: message.createdAt, seq: message.seq ?? null }));
            const jump = harness.useOwner(harness.props());
            useTranscriptPendingNavigationLanding({ address, focused: true, isLoaded: history.isLoaded,
                hasOlder: history.hasOlder, loadOlder: source.history.loadOlder
                    ? async () => { olderResult = await source.history.loadOlder!(); return olderResult; } : null, messagesById: messages,
                reducerState: source.useReducerState(),
                items: harness.rows.current, setToolCallsGroupExpanded: () => {}, waitForVisualUpdate: async () => {},
                jumpToTarget: jump.jumpToTranscriptTarget });
            return usePendingPromptLanding('request', 'tool:request');
        }, { wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId="s1" serverId={address.serverId}
            loadOlder={() => sync.loadOlderMessagesFromCursor('s1', 10)}>{children}</AppSessionTranscriptSourceProvider> });
        try {
            await vi.waitFor(() => expect(olderResult).toMatchObject({ loaded: 1 }));
            expect(Object.values(getStorage().getState().sessionMessages.s1.messagesById)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'tool-call', tool: expect.objectContaining({ permission: expect.objectContaining({ id: 'request' }) }) }),
            ]));
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ focusTarget: 'transcript' }));
            expect(harness.native.indexWrites.at(-1)).toMatchObject({ index: 0 });
        } finally { await hook.unmount(); await environment.dispose(); }
    });
    it('keeps a metadata Action confirmation at its prompt without reading unrelated history', async () => {
        let pageReads = 0;
        const environment = await restoreTranscriptJumpEnvironment(() => {
            pageReads++;
            return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
        }, sessionSnapshot);
        const address = { serverId: environment.home.id, sessionId: 's1' };
        expect(await sync.ensureSessionVisibleForMessageRoute('s1', { serverId: address.serverId,
            forceRefresh: true, hydrateMessages: false })).toMatchObject({ kind: 'available' });
        const harness = createTranscriptJumpHostTestHarness();
        setPendingNavigationLanding(address, 'confirmation', 'pending', 'prompt', 'happier_action');
        const hook = await renderHook(() => {
            const source = useSessionTranscriptSource();
            const history = source.history.useState();
            const jump = harness.useOwner(harness.props());
            useTranscriptPendingNavigationLanding({ address, focused: true, isLoaded: true,
                hasOlder: history.hasOlder, loadOlder: source.history.loadOlder, messagesById: {}, items: [],
                setToolCallsGroupExpanded: () => {}, waitForVisualUpdate: async () => {}, jumpToTarget: jump.jumpToTranscriptTarget });
            return { landing: usePendingPromptLanding('confirmation'), loading: history.isLoadingOlder };
        }, { wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId="s1" serverId={address.serverId}
            loadOlder={() => sync.loadOlderMessagesFromCursor('s1', 10)}>{children}</AppSessionTranscriptSourceProvider> });
        try {
            await flushHookEffects({ cycles: 20 });
            await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
            expect(pageReads).toBe(0);
            expect(hook.getCurrent().landing).toMatchObject({ requestId: 'confirmation', focusTarget: 'prompt' });
        } finally { await hook.unmount(); await environment.dispose(); }
    });
    it('does not declare a pending request settled while its older transcript is still unread', async () => {
        const environment = await restoreTranscriptJumpEnvironment();
        const address = { serverId: environment.home.id, sessionId: 's1' };
        getStorage().getState().setSocketStatus('connected');
        setPendingNavigationLanding(address, 'older-request');
        const hook = await renderHook(() => usePendingNavigationLanding(address), {
            wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId="s1" serverId={address.serverId}>
                <PendingNavigationSettledNotice address={address} />{children}
            </AppSessionTranscriptSourceProvider>,
        });
        try {
            await flushHookEffects();
            expect(hook.getCurrent()).toMatchObject({ state: 'pending' });
        } finally { await hook.unmount(); await environment.dispose(); }
    });
});
