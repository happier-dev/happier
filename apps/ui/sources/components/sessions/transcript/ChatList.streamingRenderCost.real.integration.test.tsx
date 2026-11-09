// @vitest-environment jsdom

/**
 * Streaming render cost of the open transcript (P03-STREAM-UI). Streamed deltas reach the
 * transcript through the real store write (`applyMessages`) and the real web ChatList; the
 * counts are fibers React actually re-rendered while only the streaming message changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CountedFiber = {
    tag: number; flags: number; type: unknown; alternate: CountedFiber | null;
    child: CountedFiber | null; sibling: CountedFiber | null; memoizedProps: Record<string, unknown> | null;
};
const counts = vi.hoisted(() => {
    // Walks the committed fiber tree after every commit: fibers with PerformedWork re-rendered in it.
    const state = { enabled: false, commits: 0, renders: new Map<string, number>(), renderedMessageIds: new Map<string, number>(), changedProps: new Map<string, number>() };
    const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
    const PERFORMED_WORK = 1;
    const nameOf = (type: any): string => !type || typeof type === 'string' ? 'host'
        : type.displayName || type.name || type.render?.displayName || type.render?.name
            || type.type?.displayName || type.type?.name || 'Anonymous';
    const walk = (root: CountedFiber) => {
        const stack: CountedFiber[] = [root];
        while (stack.length) {
            const fiber = stack.pop()!;
            for (let child = fiber.child; child; child = child.sibling) {
                if (child.alternate && fiber.alternate && isUntouched(fiber.alternate, child)) continue;
                if (COMPONENT_TAGS.has(child.tag) && child.alternate && (child.flags & PERFORMED_WORK)) {
                    const name = nameOf(child.type);
                    state.renders.set(name, (state.renders.get(name) ?? 0) + 1);
                    const message = child.memoizedProps?.message as { id?: unknown } | undefined;
                    if (name.startsWith('MessageView') && typeof message?.id === 'string') {
                        state.renderedMessageIds.set(message.id, (state.renderedMessageIds.get(message.id) ?? 0) + 1);
                    }
                    if (/^(ChatListMessageRow|MessageView|TranscriptRowShell|ChatListContent)/.test(name)) {
                        const before = child.alternate.memoizedProps ?? {};
                        const after = child.memoizedProps ?? {};
                        const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
                        const key = `${name}:${changed.length ? changed.join('|') : 'state/context'}`;
                        state.changedProps.set(key, (state.changedProps.get(key) ?? 0) + 1);
                    }
                }
                stack.push(child);
            }
        }
    };
    const isUntouched = (previousParent: CountedFiber, child: CountedFiber) => {
        for (let previous = previousParent.child; previous; previous = previous.sibling) if (previous === child) return true;
        return false;
    };
    return {
        /** Called from a Profiler's onRender: the container's committed tree is the new one. */
        onCommit(container: Element) {
            if (!state.enabled) return;
            const key = Object.keys(container).find((name) => name.startsWith('__reactContainer$'));
            const hostRoot = key ? (container as any)[key] as { stateNode: { current: CountedFiber } } : null;
            if (!hostRoot) return;
            state.commits += 1;
            walk(hostRoot.stateNode.current);
        },
        start() { state.enabled = true; state.commits = 0; state.renders.clear(); state.renderedMessageIds.clear(); state.changedProps.clear(); },
        stop() { state.enabled = false; },
        read() { return { commits: state.commits, renders: new Map(state.renders), renderedMessageIds: new Map(state.renderedMessageIds), changedProps: new Map(state.changedProps) }; },
    };
});

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import 'fake-indexeddb/auto';
import type { Message } from '@happier-dev/session-core/messages';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('react-native', async () => ({
    ...await vi.importActual('react-native-web'),
    unstable_batchedUpdates: (await import('react-dom')).unstable_batchedUpdates,
}));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await vi.importActual<typeof import('react-native')>('react-native-web');
    const mock = createReanimatedModuleMock();
    return { ...mock, View: native.View, Text: native.Text, ScrollView: native.ScrollView,
        default: { ...mock.default, View: native.View, Text: native.Text, ScrollView: native.ScrollView } };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await installRealActionExecutorModuleLoader();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture, createSessionMessagesFixture, standardCleanup } = await import('@/dev/testkit');
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let webLocks: WebLockManagerMockHandle | null = null;
beforeEach(() => { webLocks = installWebLockManagerMock(); });
afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    storage.setState(storage.getInitialState(), true);
    await homes.reset();
    webLocks?.restore();
    webLocks = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const streamChunk = (text: string, updatedAtMs: number, state: 'streaming' | 'completed' = 'streaming'): NormalizedMessage => ({
    id: 'stream-segment', localId: 'stream-segment', createdAt: 1_000, seq: 100,
    role: 'agent', isSidechain: false, content: [{ type: 'text', text, uuid: 'stream-segment', parentUUID: null }],
    meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
        segmentLocalId: 'stream-segment', segmentState: state, startedAtMs: 1, updatedAtMs } },
} as unknown as NormalizedMessage);

async function settle() {
    for (let pass = 0; pass < 6; pass++) await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

describe('streaming transcript render cost', () => {
    it('re-renders no finished message while one message streams', async () => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'STREAMUI', serverUrl: 'https://streamui.test', accountId: 'streamui-account' });
        homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://streamui.test')!.token! });
        vi.useFakeTimers();
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => Number(setTimeout(() => callback(Date.now()), 16)));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const style = window.getComputedStyle(this);
            const viewport = ['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflow);
            const height = viewport ? 4000 : this.matches('[data-testid^="transcript-message-"]') ? 60 : 0;
            return { x: 0, y: 0, width: 800, height, top: 0, left: 0, right: 800, bottom: height, toJSON: () => ({}) };
        });
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 4000);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 800);
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.getBoundingClientRect().height;
        });
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 800);
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 4000);
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: () => undefined });

        const finished: Message[] = [];
        for (let turn = 0; turn < 6; turn++) {
            finished.push({ kind: 'user-text', id: `user-${turn}`, seq: turn * 2 + 1, localId: null, createdAt: 10 + turn * 2,
                text: `Question ${turn}` });
            finished.push({ kind: 'agent-text', id: `agent-${turn}`, seq: turn * 2 + 2, localId: null, createdAt: 11 + turn * 2,
                text: `## Answer ${turn}\n\nSome **markdown** with \`code\` and a list:\n\n- one\n- two` });
        }
        const session = createSessionFixture({ id: 'streamui-session', serverId, active: true, activeAt: Date.now(), thinking: true });
        storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: createSessionMessagesFixture({
            messageIdsOldestFirst: finished.map((message) => message.id),
            messagesById: Object.fromEntries(finished.map((message) => [message.id, message])), isLoaded: true,
        }) }, profileScope: { serverId, accountId: 'streamui-account' } });
        storage.getState().applyMessages(session.id, [streamChunk('Starting', 2)]);

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root?.render(<React.Profiler id="streamui" onRender={() => counts.onCommit(container!)}>
                <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={session.serverId}>
                    <ChatList session={session} sessionSurfaceKey="streamui-surface" externalControlFooter={null}
                        onEditPendingMessage={() => {}} />
                </AppSessionTranscriptSourceProvider>
            </React.Profiler>);
        });
        await settle();
        expect(container.querySelector('[data-testid="transcript-message-agent-0"]')).not.toBeNull();

        const finishedIds = new Set(finished.map((message) => message.id));
        const phases: Record<string, unknown> = {};
        const measure = async (name: string, steps: readonly (() => void)[]) => {
            counts.start();
            for (const apply of steps) {
                await act(async () => { apply(); });
                await act(async () => { await vi.advanceTimersByTimeAsync(40); });
            }
            await settle();
            counts.stop();
            const measured = counts.read();
            const finishedRenders = [...measured.renderedMessageIds].filter(([id]) => finishedIds.has(id))
                .reduce((sum, [, n]) => sum + n, 0);
            phases[name] = { steps: steps.length, commits: measured.commits, finishedRenders,
                totalRenders: [...measured.renders.values()].reduce((x, y) => x + y, 0),
                top: [...measured.renders].sort((x, y) => y[1] - x[1]).slice(0, 12), changedProps: [...measured.changedProps] };
            return { finished: finishedRenders, root: measured.renders.get('ChatListContent') ?? 0 };
        };
        const apply = (message: NormalizedMessage) => storage.getState().applyMessages(session.id, [message]);
        let text = 'Starting';
        const textFinished = await measure('text', Array.from({ length: 8 }, (_, delta) => () => {
            text += ` token${delta}`; apply(streamChunk(text, 3 + delta));
        }));
        let thinking = 'Considering';
        const thinkingDelta = () => apply({ id: 'think-live', seq: 101, localId: null, createdAt: 1_001, isSidechain: false,
            role: 'agent', content: [{ type: 'thinking', thinking, uuid: 'think-live', parentUUID: null }] } as unknown as NormalizedMessage);
        // The thinking row's arrival is structural; measure only the deltas that follow it.
        await act(async () => { thinkingDelta(); });
        await settle();
        const thinkingFinished = await measure('thinking', Array.from({ length: 8 }, (_, delta) => () => {
            thinking += ` step${delta}`;
            thinkingDelta();
        }));
        const toolFinished = await measure('tool', [
            () => apply({ id: 'tool-live', seq: 102, localId: null, createdAt: 1_002, isSidechain: false, role: 'agent',
                content: [{ type: 'tool-call', id: 'call-live', name: 'Bash', input: { command: 'ls' }, description: null,
                    uuid: 'tool-live', parentUUID: null }] } as unknown as NormalizedMessage),
            () => apply({ id: 'tool-live-result', seq: 103, localId: null, createdAt: 1_003, isSidechain: false, role: 'agent',
                content: [{ type: 'tool-result', tool_use_id: 'call-live', content: 'a\nb', is_error: false,
                    uuid: 'tool-live-result', parentUUID: null }] } as unknown as NormalizedMessage),
        ]);
        const endFinished = await measure('turn-end', [() => apply(streamChunk(text, 50, 'completed'))]);
        if (process.env.HAPPIER_STREAM_RENDER_COST_REPORT === '1') console.log('STREAMUI', JSON.stringify(phases));
        // Finished rows never re-render for another message's delta or tool event, and text/thinking
        // deltas (no structural change) never re-render the transcript root.
        expect({ text: textFinished, thinking: thinkingFinished, tool: toolFinished.finished, turnEnd: endFinished.finished })
            .toEqual({ text: { finished: 0, root: 0 }, thinking: { finished: 0, root: 0 }, tool: 0, turnEnd: 0 });
    });
});
