// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LayoutChangeEvent } from 'react-native';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';

// The DOM integration lane needs the actual web adapter, as the other real-Legend suites do.
vi.mock('react-native', async () => ({
    ...await vi.importActual('react-native-web'),
    unstable_batchedUpdates: (await import('react-dom')).unstable_batchedUpdates,
}));
// Metro's web bundle uses react-native.web.js (IsNewArchitecture=true), including
// synchronous container measurement. Preserve that path under Vite's browser condition.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await vi.importActual<typeof import('react-native')>('react-native-web');
    const mock = createReanimatedModuleMock();
    // Preserve the canonical animation boundary while rendering its host views through the DOM adapter.
    return { ...mock, View: native.View, Text: native.Text, ScrollView: native.ScrollView,
        default: { ...mock.default, View: native.View, Text: native.Text, ScrollView: native.ScrollView } };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await installRealActionExecutorModuleLoader();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture, createSessionMessagesFixture, createPendingMessageFixture, standardCleanup } = await import('@/dev/testkit');
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
const { router } = await import('expo-router');
const { useNewSessionPromptAutomationState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPromptAutomationState');
const { useNewSessionPromptValue } = await import('@/components/sessions/new/hooks/screenModel/newSessionPromptStore');
const { useNewSessionDraftAutoPersist } = await import('@/components/sessions/new/hooks/useNewSessionDraftAutoPersist');
const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { useNewSessionBackendTargetState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState');
const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
const { resolveBackendTargetKeyV2 } = await import('@/agents/backendCatalog/backendTargetKeyV2');
const { resolveAgentExecutionTargetForBackendTarget } = await import('@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget');
const { AcpBackendDefinitionV1Schema } = await import('@happier-dev/protocol/acp/catalog/settingsV1');
type Session = ReturnType<typeof createSessionFixture>;

const configuredDefinition = AcpBackendDefinitionV1Schema.parse({
    id: 'fix53b-configured', name: 'fix53b-configured', title: 'Review',
    launch: { kind: 'command', command: 'review', args: [] }, env: {},
    capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
        supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
});
const savedConfiguredDefinition = AcpBackendDefinitionV1Schema.parse({
    ...configuredDefinition, id: 'fix53c-ui-saved', name: 'fix53c-ui-saved', title: 'Saved review',
    launch: { kind: 'command', command: 'review', args: ['--saved'] },
});
const backendEntries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude'],
    acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [configuredDefinition, savedConfiguredDefinition] } } });
const configuredEntry = backendEntries.find(entry => entry.kind === 'configuredBackend')!;
const savedConfiguredEntry = backendEntries.find(entry => entry.kind === 'configuredBackend'
    && entry.backendTargetKey !== configuredEntry.backendTargetKey)!;

function DraftInput(props: Readonly<{ serverId: string; focused: boolean; draftId: string }>) {
    const { backendTarget, setBackendTarget } = useNewSessionBackendTargetState({
        entries: backendEntries, configuredCatalogReady: true, projectionPhase: 'ready',
    });
    const { promptStore, setSessionPrompt } = useNewSessionPromptAutomationState({
        prompt: undefined, dataId: undefined, automationParam: undefined,
        persistedDraftEntryIntent: 'session', hydratedTempAuthoringDraft: null,
        hydratedPersistedAuthoringDraft: null,
    });
    const text = useNewSessionPromptValue(promptStore);
    const textSource = React.useMemo(() => ({
        getLength: () => promptStore.getPrompt().length, subscribe: promptStore.subscribe,
    }), [promptStore]);
    useNewSessionDraftAutoPersist({
        focused: props.focused, draftText: textSource,
        draftChangeKey: resolveBackendTargetKeyV2(backendTarget),
        persistDraftNow: () => {
            const agentTarget = resolveAgentExecutionTargetForBackendTarget({ backendTarget });
            if (!agentTarget) throw new Error('The draft fixture requires an executable Agent target');
            writeNewSessionDraft({
                scope: { serverId: props.serverId, accountId: 'df33-account' },
                draftId: props.draftId, patch: { text: promptStore.getPrompt(), authoring: { agentTarget } }, materializationIntent: 'userEdit',
            });
        },
    });
    return <>
        <button data-testid="fix53-configured" onClick={() => setBackendTarget(configuredEntry.backendTarget)}>Review</button>
        <button data-testid="fix53-saved-configured" onClick={() => setBackendTarget(savedConfiguredEntry.backendTarget)}>Saved review</button>
        <output data-testid="fix53-target">{resolveBackendTargetKeyV2(backendTarget)}</output>
        <textarea data-testid="fix53-draft-input" value={text} onInput={event => setSessionPrompt(event.currentTarget.value)} />
    </>;
}

function RetainedDraftTranscript(props: Readonly<{ session: Session; serverId: string; commits: { current: number } }>) {
    const [draftActive, setDraftActive] = React.useState(false);
    const [draftId, setDraftId] = React.useState('fix53-draft');
    const target = React.useMemo(() => ({ kind: 'session' as const,
        params: { id: props.session.id, serverId: props.serverId },
    }), [props.serverId, props.session.id]);
    const draftTarget = React.useMemo(() => ({ kind: 'newSession' as const,
        params: { draftId, draftOrigin: 'ordinary' },
    }), [draftId]);
    return <>
        <button data-testid="fix53-new" onClick={() => setDraftActive(true)}>New</button>
        <button data-testid="fix53-session" onClick={() => setDraftActive(false)}>Session</button>
        <button data-testid="fix53-fresh" onClick={() => setDraftId('fix53-fresh')}>Fresh draft</button>
        <RetainedPanelSurface isActive={draftActive}>
            <DestinationInstanceHost tabId="fix53-new" ref={draftTarget} pathname="/new"
                focused={draftActive} visible={draftActive} navigation={router}>
                <DraftInput key={draftId} draftId={draftId} serverId={props.serverId} focused={draftActive} />
            </DestinationInstanceHost>
        </RetainedPanelSurface>
        <div data-retained-hidden={String(draftActive)} style={{ display: draftActive ? 'none' : 'flex' }}>
            <RetainedPanelSurface isActive={!draftActive}>
                <DestinationInstanceHost tabId="fix53-session" ref={target} pathname={`/session/${props.session.id}`}
                    focused={!draftActive} visible={!draftActive} navigation={router}>
                    <AppSessionTranscriptSourceProvider sessionId={props.session.id} serverId={props.session.serverId}>
                        <React.Profiler id="fix53-transcript" onRender={() => { props.commits.current += 1; }}>
                            <ChatList session={props.session} sessionSurfaceKey="df33-surface"
                                onEditPendingMessage={() => {}} />
                        </React.Profiler>
                    </AppSessionTranscriptSourceProvider>
                </DestinationInstanceHost>
            </RetainedPanelSurface>
        </div>
    </>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalScrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
type ResizeObserverRecord = Readonly<{ callback: ResizeObserverCallback; elements: Set<Element> }>;
const resizeObservers = new Set<ResizeObserverRecord>();
let webLocks: WebLockManagerMockHandle | null = null;
beforeEach(() => { webLocks = installWebLockManagerMock(); });

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map(target => ({
            target, contentRect: target.getBoundingClientRect(), borderBoxSize: [],
            contentBoxSize: [], devicePixelContentBoxSize: [],
        })) as ResizeObserverEntry[];
        if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
}

type TranscriptFiber = Readonly<{
    child?: TranscriptFiber | null;
    sibling?: TranscriptFiber | null;
    return?: TranscriptFiber | null;
    stateNode?: { current?: TranscriptFiber };
    type?: { render?: { name?: string } };
    memoizedProps?: {
        onScroll?: unknown;
        onStartReached?: unknown;
        onEndReached?: unknown;
        onCommitLayoutEffect?: () => void;
        renderItem?: unknown;
        extraData?: unknown;
        catchUpOverlay?: unknown;
        onLayout?: (event: LayoutChangeEvent) => void;
    };
}>;

function readCommittedTranscriptScrollCallbacks(element: Element) {
    const fiberKey = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    if (!fiberKey) throw new Error('The retained transcript has no React fiber');
    let fiber = (element as unknown as Record<string, TranscriptFiber>)[fiberKey];
    while (fiber.return) fiber = fiber.return;
    const currentRoot = fiber.stateNode?.current;
    if (!currentRoot) throw new Error('The retained transcript has no committed root');
    const pending = [currentRoot];
    while (pending.length) {
        const current = pending.pop()!;
        if (current.type?.render?.name === 'LegendListTranscriptRendererInner') {
            const props = current.memoizedProps;
            if (typeof props?.onScroll !== 'function' || typeof props.onStartReached !== 'function'
                || typeof props.onEndReached !== 'function') {
                throw new Error('The committed transcript has no scroll callbacks');
            }
            return { onScroll: props.onScroll, onStartReached: props.onStartReached, onEndReached: props.onEndReached,
                onLayout: props.onLayout, onCommitLayoutEffect: props.onCommitLayoutEffect,
                renderItem: props.renderItem, extraData: props.extraData, catchUpOverlay: props.catchUpOverlay };
        }
        if (current.sibling) pending.push(current.sibling);
        if (current.child) pending.push(current.child);
    }
    throw new Error('The retained transcript renderer is not mounted');
}

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
    if (originalScrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollToDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('completed connected-Agent transcript', () => {
    it.each([
        { active: true, hasReply: true, capturedGeometry: false },
        { active: false, hasReply: true, capturedGeometry: false },
        // R47's Claude Start created a Session but failed before the first native reply.
        { active: true, hasReply: false, capturedGeometry: false },
        { active: true, hasReply: true, capturedGeometry: true },
    ])('retains the transcript across configured ACP selection, a fresh draft and refocus (active=$active, reply=$hasReply, capturedGeometry=$capturedGeometry)', async ({ active, hasReply, capturedGeometry }) => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'DF33', serverUrl: 'https://df33.test', accountId: 'df33-account' });
        homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://df33.test')!.token! });
        vi.useFakeTimers();
        resizeObservers.clear();
        vi.stubGlobal('ResizeObserver', class {
            private readonly record: ResizeObserverRecord;
            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }
            observe(target: Element) {
                resizeObservers.add(this.record);
                this.record.elements.add(target);
            }
            unobserve(target: Element) { this.record.elements.delete(target); }
            disconnect() { this.record.elements.clear(); resizeObservers.delete(this.record); }
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => Number(setTimeout(() => callback(Date.now()), 16)));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
        let viewportHeight = capturedGeometry ? 280 : 600;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.closest('[data-retained-hidden="true"]')) {
                return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
            }
            const style = window.getComputedStyle(this);
            const viewport = ['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflow);
            const capturedRowHeights = {
                'df33-prompt': 122, 'df33-reply': 62, 'df33-followup': 46, 'df33-empty': 1,
            };
            const message = this.matches('[data-testid^="transcript-message-"]')
                ? this : this.querySelector('[data-testid^="transcript-message-"]');
            const messageId = message?.getAttribute('data-testid')?.replace('transcript-message-', '');
            const rowHeight = capturedGeometry
                ? capturedRowHeights[messageId as keyof typeof capturedRowHeights] ?? 0
                : message ? 96.375 : 0;
            const height = viewport ? viewportHeight : rowHeight;
            const width = capturedGeometry ? 1170 : 800;
            return { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) };
        });
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.closest('[data-retained-hidden="true"]') ? 0 : viewportHeight;
        });
        // RN Web's UIManager.measure reads border-box offsets; Legend's DOM
        // artifact instead reads getBoundingClientRect directly.
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.getBoundingClientRect().height;
        });
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
            return this.getBoundingClientRect().width;
        });
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
            return this.closest('[data-retained-hidden="true"]') ? 0 : capturedGeometry ? 1170 : 800;
        });
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.closest('[data-retained-hidden="true"]') ? 0 : capturedGeometry ? 280 : 600;
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: () => undefined });
        const messages: readonly Message[] = [
            { kind: 'user-text', id: 'df33-prompt', seq: 1, localId: null, createdAt: 1,
                text: 'Please reply with exactly: Ready to talk. Do not use tools or change any files.' },
            ...(hasReply ? [{ kind: 'agent-text' as const, id: 'df33-reply', seq: 2, localId: null, createdAt: 2,
                text: 'Ready to talk. Do not use tools or change any files.' }] : []),
            ...(capturedGeometry ? [
                { kind: 'user-text' as const, id: 'df33-followup', seq: 3, localId: null, createdAt: 3, text: 'Thank you.' },
                { kind: 'agent-text' as const, id: 'df33-empty', seq: 4, localId: null, createdAt: 4, text: '' },
            ] : []),
        ];
        const session = createSessionFixture({ id: 'df33-session', serverId, active, activeAt: Date.now(), thinking: false });
        storage.setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: createSessionMessagesFixture({
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])), isLoaded: true,
        }) }, profileScope: { serverId, accountId: 'df33-account' },
            ...(capturedGeometry ? { settings: { ...storage.getState().settings, transcriptGroupingMode: 'linear' as const } } : {}),
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const commits = { current: 0 };
        await act(async () => {
            root?.render(<RetainedDraftTranscript session={session} serverId={serverId} commits={commits} />);
        });
        for (let pass = 0; pass < 8; pass++) {
            await act(async () => { flushResizeObservers(); await vi.runOnlyPendingTimersAsync(); });
        }
        expect(container.querySelector('[data-testid="transcript-message-df33-prompt"]')).not.toBeNull();
        const retainedMessageSelector = `[data-testid="transcript-message-${hasReply ? 'df33-reply' : 'df33-prompt'}"]`;
        const retainedMessage = container.querySelector(retainedMessageSelector);
        expect(retainedMessage).not.toBeNull();
        if (capturedGeometry) {
            // R52's 1px container is not evidence of a height flip. Preserve the
            // actual fourth mounted row while exercising the real web measurement path.
            for (const id of ['df33-prompt', 'df33-reply', 'df33-followup', 'df33-empty']) {
                expect(container.querySelector(`[data-testid="transcript-message-${id}"]`)).not.toBeNull();
            }
        }
        const beforeTyping = commits.current;
        await act(async () => container?.querySelector<HTMLButtonElement>('[data-testid="fix53-new"]')?.click());
        await act(async () => container?.querySelector<HTMLButtonElement>('[data-testid="fix53-configured"]')?.click());
        expect(container.querySelector('[data-testid="fix53-target"]')?.textContent).toBe(configuredEntry.backendTargetKey);
        await act(async () => container?.querySelector<HTMLButtonElement>('[data-testid="fix53-fresh"]')?.click());
        expect(container.querySelector('[data-testid="fix53-target"]')?.textContent).toBe(configuredEntry.backendTargetKey);
        const input = container.querySelector<HTMLTextAreaElement>('[data-testid="fix53-draft-input"]')!;
        for (const text of ['Please', 'Please reply', 'Please reply READY']) {
            await act(async () => {
                input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await vi.advanceTimersByTimeAsync(250);
                flushResizeObservers();
            });
        }
        expect(input.value).toBe('Please reply READY');
        expect(getSessionDraftSnapshot({ serverId, accountId: 'df33-account' }, { kind: 'newSession', draftId: 'fix53-fresh' }))
            .toMatchObject({ document: { composer: { text: { value: 'Please reply READY' } } } });
        // A retained live Session can receive queue updates while New Session owns
        // the visible pane. Mount and retire that row under zero hidden geometry.
        await act(async () => {
            storage.getState().applyPendingSnapshot(session.id, {
                messages: [createPendingMessageFixture({ text: 'Follow up when ready.' })], discarded: [],
            });
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
        await act(async () => {
            container?.querySelector<HTMLButtonElement>('[data-testid="fix53-saved-configured"]')?.click();
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
        expect(container.querySelector('[data-testid="fix53-target"]')?.textContent).toBe(savedConfiguredEntry.backendTargetKey);
        expect(input.value).toBe('Please reply READY');
        await act(async () => {
            storage.getState().applyPendingSnapshot(session.id, { messages: [], discarded: [] });
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
        await act(async () => container?.querySelector<HTMLButtonElement>('[data-testid="fix53-session"]')?.click());
        for (let pass = 0; pass < 8; pass++) {
            await act(async () => { flushResizeObservers(); await vi.runOnlyPendingTimersAsync(); });
        }
        expect(container.querySelector(retainedMessageSelector)).toBe(retainedMessage);
        if (capturedGeometry) {
            // R54 identifies these producer inputs changing in the repeated Legend
            // layout window. Drive real web measurement commits, rather than
            // replacing Legend or the observation host with a callback mock.
            const callbacks = [readCommittedTranscriptScrollCallbacks(retainedMessage!)];
            const commitsBeforeLayout = commits.current;
            for (const height of [281, 282, 280]) {
                viewportHeight = height;
                // RN Web captures its layout observer at module load, before
                // this suite installs browser geometry. Deliver that native
                // boundary event to the real host as well as Legend's observer.
                await act(async () => {
                    callbacks[0].onLayout?.({
                        nativeEvent: { layout: { x: 0, y: 0, width: 1170, height } },
                    } as LayoutChangeEvent);
                    // R56's SessionView also publishes a fresh edit closure as
                    // its composer state changes. Keep that real parent→row-host
                    // path alongside the child measurement-driven renders.
                    root?.render(<RetainedDraftTranscript session={session} serverId={serverId} commits={commits} />);
                });
                for (let pass = 0; pass < 8; pass++) {
                    await act(async () => { flushResizeObservers(); await vi.runOnlyPendingTimersAsync(); });
                }
                callbacks.push(readCommittedTranscriptScrollCallbacks(retainedMessage!));
            }
            expect(commits.current).toBeGreaterThan(commitsBeforeLayout);
            expect({
                onScroll: new Set(callbacks.map(value => value.onScroll)).size,
                onStartReached: new Set(callbacks.map(value => value.onStartReached)).size,
                onEndReached: new Set(callbacks.map(value => value.onEndReached)).size,
                onCommitLayoutEffect: new Set(callbacks.map(value => value.onCommitLayoutEffect)).size,
                renderItem: new Set(callbacks.map(value => value.renderItem)).size,
                extraData: new Set(callbacks.map(value => value.extraData)).size,
                catchUpOverlay: new Set(callbacks.map(value => value.catchUpOverlay)).size,
            }).toEqual({ onScroll: 1, onStartReached: 1, onEndReached: 1,
                onCommitLayoutEffect: 1, renderItem: 1, extraData: 1, catchUpOverlay: 1 });
        }
        // React rejects a nested update chain at 50. This also catches churn that settles just before it.
        expect(commits.current - beforeTyping).toBeLessThan(50);
    });
});
