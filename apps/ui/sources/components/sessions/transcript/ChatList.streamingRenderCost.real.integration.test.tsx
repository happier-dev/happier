// @vitest-environment jsdom

/**
 * Streaming render cost of the open transcript (P03-STREAM-UI). Streamed deltas reach the
 * transcript through the real store write (`applyMessages`) and the real web ChatList; the
 * counts are fibers React actually re-rendered while only the streaming message changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCommittedFiberRenderCounter } from '@/dev/testkit/performance/committedFiberCounts';
const counts = createCommittedFiberRenderCounter();

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
import { STREAMING_TEXT_PACER_CONFIG } from './streaming/streamingTextPacer';

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
const { ChatListInternal } = await import('./ChatListInternal');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { PermissionPromptCard } = await import('@/components/tools/shell/permissions/PermissionPromptCard');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let webLocks: WebLockManagerMockHandle | null = null;
let scrollToDescriptor: PropertyDescriptor | undefined;
let stopAccountRequestTrace: (() => void) | null = null;
let previousStackTraceLimit = Error.stackTraceLimit;
beforeEach(() => {
    webLocks = installWebLockManagerMock();
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    previousStackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 80;
});
afterEach(async () => {
    stopAccountRequestTrace?.();
    stopAccountRequestTrace = null;
    Error.stackTraceLimit = previousStackTraceLimit;
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
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

const streamChunk = (text: string, updatedAtMs: number, state: 'streaming' | 'completed' = 'streaming'): NormalizedMessage => ({
    id: 'stream-segment', localId: null, createdAt: 1_000, seq: 1_001,
    role: 'agent', isSidechain: false, content: [{ type: 'text', text, uuid: 'stream-segment', parentUUID: null }],
    meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
        segmentLocalId: 'stream-segment', segmentState: state, startedAtMs: 1, updatedAtMs } },
} as unknown as NormalizedMessage);

async function settle() {
    for (let pass = 0; pass < 6; pass++) await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

describe('streaming transcript render cost', () => {
    it('muse.experience.pc8 keeps 1,000 finished rows and the permission card quiet through 100 deltas', async () => {
        await homes.reset();
        let requestPhase = 'bootstrap';
        const accountRequestTraces = new Map<(typeof homes.requests)[number], { phase: string; caller: string }>();
        const accountRequests = () => homes.requests.filter(request => request.method === 'GET'
            && /^\/v\d+\/(?:account(?:\/|$)|connect\/)/.test(request.path));
        const accountReads = () => accountRequests()
            .map(({ serverId, serverUrl, method, path }) => ({ serverId,
                accountId: homes.findByServerUrl(serverUrl)?.accountId ?? null, method, path }));
        stopAccountRequestTrace = homes.subscribe(() => {
            const request = accountRequests().at(-1);
            if (request && !accountRequestTraces.has(request)) accountRequestTraces.set(request, {
                phase: requestPhase, caller: new Error('Home Account request admission').stack ?? '',
            });
        });
        const accountReadDiagnostic = () => JSON.stringify(accountRequests().map(request => ({
            serverId: request.serverId, accountId: homes.findByServerUrl(request.serverUrl)?.accountId ?? null,
            method: request.method, path: request.path, ...accountRequestTraces.get(request),
        })));
        const serverId = await homes.addHome({ name: 'STREAMUI', serverUrl: 'https://streamui.test', accountId: 'streamui-account' });
        // This scene owns an already-loaded transcript, not Account bootstrap. Keep
        // the real persisted Home binding that the mounted card resolves locally.
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        expect(await resolveServerCredentialAccountScope(serverId)).toMatchObject({
            kind: 'bound', scope: { serverId, accountId: 'streamui-account' },
        });
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
        for (let turn = 0; turn < 500; turn++) {
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
        expect(storage.getState().sessionMessages[session.id]).toMatchObject({ isLoaded: true });
        expect(storage.getState().sessionMessages[session.id]!.messageIdsOldestFirst).toHaveLength(1_000);
        const finishedIds = new Set(finished.map((message) => message.id));
        storage.getState().applyMessages(session.id, [streamChunk('Starting', 2)]);
        const streamingIds = Object.keys(storage.getState().sessionMessages[session.id]!.messagesById)
            .filter(id => !finishedIds.has(id));
        expect(streamingIds).toHaveLength(1);
        const streamingMessageId = streamingIds[0]!;
        expect(storage.getState().sessionMessages[session.id]!.messagesById[streamingMessageId])
            .toMatchObject({ kind: 'agent-text', localId: 'stream-segment', text: 'Starting' });

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const request = { id: 'waiting-permission', tool: 'Bash', arguments: { command: 'git status' }, createdAt: Date.now() };
        const transcript = <ChatList session={session} sessionSurfaceKey="streamui-surface"
            onEditPendingMessage={() => {}} />;
        const scene = (permissionArrived: boolean, cardRequest = request) => (
            <React.Profiler id="streamui" onRender={() => counts.onCommit(container!)}>
                <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={session.serverId}>
                    {transcript}
                    {permissionArrived ? <PermissionPromptCard request={cardRequest} location={null} sessionId={session.id} serverId={serverId}
                        metadata={null} canApprovePermissions /> : null}
                </AppSessionTranscriptSourceProvider>
            </React.Profiler>
        );
        requestPhase = 'transcript-settle';
        await act(async () => {
            root?.render(scene(false));
        });
        await settle();
        expect(container.querySelector('[data-testid^="transcript-message-agent-"]')).not.toBeNull();
        const accountReadsBeforePermissionArrival = accountReads();
        requestPhase = 'permission-arrival';
        await act(async () => { root?.render(scene(true)); });
        await settle();
        expect(container.querySelector('[data-testid="permission-prompt-card"]')).not.toBeNull();
        if (process.env.HAPPIER_STREAM_RENDER_COST_REPORT === '1') console.log('STREAMUI_ACCOUNT_ARRIVAL', accountReadDiagnostic());
        expect(accountReads(), accountReadDiagnostic()).toEqual(accountReadsBeforePermissionArrival);

        counts.start();
        await act(async () => { root?.render(scene(true, { ...request, id: 'counter-control-permission' })); });
        await settle();
        counts.stop();
        expect(counts.read().commitsFor(PermissionPromptCard)).toBeGreaterThan(0);
        await act(async () => { root?.render(scene(true)); });
        await settle();

        const phases: Record<string, unknown> = {};
        const measure = async (name: string, steps: readonly (() => void | Promise<void>)[]) => {
            requestPhase = name;
            counts.start();
            for (const apply of steps) {
                await act(async () => { await apply(); });
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
            return { finished: finishedRenders, root: measured.commitsFor(ChatList) + measured.commitsFor(ChatListInternal),
                permission: measured.commitsFor(PermissionPromptCard) };
        };
        const apply = (message: NormalizedMessage) => storage.getState().applyMessages(session.id, [message]);
        let text = 'Starting';
        const accountReadsBeforeDeltas = accountReads();
        const textFinished = await measure('text', Array.from({ length: 100 }, (_, delta) => () => {
            text += ` token${delta}`; apply(streamChunk(text, 3 + delta));
        }));
        expect([...counts.read().renderedMessageIds]).toEqual([[streamingMessageId, 100]]);
        expect(storage.getState().sessionMessages[session.id]!.messagesById[streamingMessageId])
            .toMatchObject({ kind: 'agent-text', localId: 'stream-segment', text });
        // Delta commits and the paced reveal are separate work. Drain using the
        // text owner's published timing, and also count the static rows/card
        // during that drain; the final visible tail intentionally trails input.
        const revealFinished = await measure('text-reveal', [() => vi.advanceTimersByTimeAsync(
            STREAMING_TEXT_PACER_CONFIG.settleAfterMs + STREAMING_TEXT_PACER_CONFIG.settleDrainMaxMs,
        )]);
        expect(container.textContent).toContain('token99');
        // PC9's permission arrival stays mounted above; transcript arrivals do not read Account state.
        expect(accountReads(), accountReadDiagnostic()).toEqual(accountReadsBeforeDeltas);
        let thinking = 'Considering';
        const thinkingDelta = () => apply({ id: 'think-live', seq: 1_002, localId: null, createdAt: 1_001, isSidechain: false,
            role: 'agent', content: [{ type: 'thinking', thinking, uuid: 'think-live', parentUUID: null }] } as unknown as NormalizedMessage);
        // The thinking row's arrival is structural; measure only the deltas that follow it.
        await act(async () => { thinkingDelta(); });
        await settle();
        const thinkingMessage = Object.values(storage.getState().sessionMessages[session.id]!.messagesById)
            .find(message => message.kind === 'agent-text' && message.isThinking);
        expect(thinkingMessage).toMatchObject({ kind: 'agent-text', isThinking: true, text: 'Considering' });
        const thinkingFinished = await measure('thinking', Array.from({ length: 8 }, (_, delta) => () => {
            thinking += ` step${delta}`;
            thinkingDelta();
        }));
        expect(storage.getState().sessionMessages[session.id]!.messagesById[thinkingMessage!.id])
            .toMatchObject({ kind: 'agent-text', isThinking: true, text: thinking });
        const toolFinished = await measure('tool', [
            () => apply({ id: 'tool-live', seq: 1_003, localId: null, createdAt: 1_002, isSidechain: false, role: 'agent',
                content: [{ type: 'tool-call', id: 'call-live', name: 'Bash', input: { command: 'ls' }, description: null,
                    uuid: 'tool-live', parentUUID: null }] } as unknown as NormalizedMessage),
            () => apply({ id: 'tool-live-result', seq: 1_004, localId: null, createdAt: 1_003, isSidechain: false, role: 'agent',
                content: [{ type: 'tool-result', tool_use_id: 'call-live', content: 'a\nb', is_error: false,
                    uuid: 'tool-live-result', parentUUID: null }] } as unknown as NormalizedMessage),
        ]);
        const toolMessage = Object.values(storage.getState().sessionMessages[session.id]!.messagesById)
            .find(message => message.kind === 'tool-call' && message.tool.id === 'call-live');
        expect(toolMessage).toMatchObject({ kind: 'tool-call', tool: {
            id: 'call-live', state: 'completed', result: 'a\nb',
        } });
        expect(toolFinished.root).toBeGreaterThan(0);
        const endFinished = await measure('turn-end', [() => apply(streamChunk(text, 150, 'completed'))]);
        expect(storage.getState().sessionMessages[session.id]!.messagesById[streamingMessageId])
            .toMatchObject({ kind: 'agent-text', localId: 'stream-segment', text,
                meta: { happierStreamSegmentV1: { segmentState: 'completed' } } });
        if (process.env.HAPPIER_STREAM_RENDER_COST_REPORT === '1') console.log('STREAMUI', JSON.stringify(phases));
        // Finished rows never re-render for another message's delta or tool event, and text/thinking
        // deltas (no structural change) never re-render the transcript root.
        expect({ text: textFinished, reveal: revealFinished, thinking: thinkingFinished, tool: toolFinished.finished, turnEnd: endFinished.finished })
            .toEqual({ text: { finished: 0, root: 0, permission: 0 }, reveal: { finished: 0, root: 0, permission: 0 },
                thinking: { finished: 0, root: 0, permission: 0 }, tool: 0, turnEnd: 0 });
    });
});
