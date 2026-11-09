// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { ChatTranscriptListItem } from '../chatListTypes';
import type { TranscriptFindCorpus } from './useTranscriptFind';
import { View } from 'react-native';
import { buildChatListItems } from '../../chatListItems';
import type { restoreTranscriptJumpEnvironment } from '../viewport/jump/host/transcriptJumpHostTestHarness';

vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
// Install the network boundary before the jump harness or renderers reach Sync.
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { CommandView } = await import('../CommandView');
const { FindBarPlacement } = await import('@/components/ui/find/FindBarPlacement');
const { FindBar } = await import('@/components/ui/find/FindBar');
const { FindHighlightedText } = await import('@/components/ui/text/FindHighlightedText');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { createReadOnlySessionTranscriptSource } = await import('../source/readOnlySessionTranscriptSource');
const { createTranscriptJumpHostTestHarness, createTranscriptJumpWebMetrics, emptyTranscriptJumpPage,
    restoreTranscriptJumpEnvironment: restoreEnvironment } = await import('../viewport/jump/host/transcriptJumpHostTestHarness');
const { TranscriptFindSurface } = await import('./TranscriptFindSurface');
const { isTranscriptTargetObservedAtAlignment } = await import('../viewport/window/useTranscriptTargetWindowHostAdapter');
const { createTranscriptFindModel } = await import('./useTranscriptFind');
const { revealTranscriptFindMatch } = await import('./revealTranscriptFindMatch');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let environment: Awaited<ReturnType<typeof restoreTranscriptJumpEnvironment>> | undefined;
let webLocks: WebLockManagerMockHandle;
const historyReads: URL[] = [];
beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(900);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    historyReads.length = 0;
    environment = await restoreEnvironment((url) => { historyReads.push(url); return Response.json(emptyTranscriptJumpPage()); });
});
afterEach(async () => { await environment?.dispose(); webLocks.restore(); standardCleanup(); });

function installMessage(message: Message) {
    getStorage().setState(state => ({ sessionMessages: { ...state.sessionMessages,
        s1: createSessionMessagesFixture({ messagesById: { [message.id]: message }, messageIdsOldestFirst: [message.id], isLoaded: true }),
    } }));
}

describe('web Find reveal through the real jump owner', () => {
    it.each([390, 1440])('routes Enter, reverse and Escape through the transcript owner at %spx, including its seated input', async width => {
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
        await act(async () => { window.dispatchEvent(new Event('resize')); });
        const [{ KeyboardShortcutProvider }, { FindComposerSlotProvider, FindComposerSlotHost }] = await Promise.all([
            import('@/keyboard/KeyboardShortcutProvider'), import('@/components/ui/find/FindComposerSlot'),
        ]);
        const messages: Message[] = [{ kind: 'user-text', id: 'keyboard-message', localId: null,
            seq: 1, createdAt: 1, text: 'needle needle' }];
        const items = buildChatListItems({ messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])), pendingMessages: [] });
        let corpus: TranscriptFindCorpus = { messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 's1', serverId: null, messages,
            historyState: corpus.history, reducerState: null, metadata: null, agentState: null });
        // Viewport movement is the OS boundary; matching, registration and keyboard dispatch stay real.
        const model = createTranscriptFindModel({ readCorpus: () => corpus, loadPage: null,
            jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {} });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        const viewport = React.createRef<React.ElementRef<typeof View>>();
        function Screen() {
            return <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active><FindComposerSlotProvider>
                <View testID="session-view-retained-surface:s1">
                    <View ref={viewport}><TranscriptFindSurface model={model} source={source} sessionId="s1" serverId={null}
                        focused viewportRef={viewport} items={items} loadedMessages={messages}
                        publishCorpus={next => { corpus = next; }} measureMessage={() => null} contentHeight={200}>
                        <View />
                    </TranscriptFindSurface></View>
                    <FindComposerSlotHost composer={<div data-testid="agent-input-composer"><input data-testid="keyboard-origin" /></div>} />
                </View>
            </FindComposerSlotProvider></PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
        }
        const key = async (target: HTMLElement, init: KeyboardEventInit) => {
            const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
            await act(async () => { target.dispatchEvent(event); await model.settled(); });
            return event;
        };
        try {
            await act(async () => { root.render(<Screen />); });
            const origin = container.querySelector<HTMLInputElement>('[data-testid="keyboard-origin"]')!;
            const focus = origin.focus.bind(origin);
            // jsdom focuses display:none descendants; browsers refuse them. Keep
            // that OS eligibility boundary real while the phone slot hides its composer.
            vi.spyOn(origin, 'focus').mockImplementation(options => {
                for (let node: HTMLElement | null = origin; node; node = node.parentElement) {
                    if (getComputedStyle(node).display === 'none') return;
                }
                focus(options);
            });
            await act(async () => { origin.focus(); });
            expect((await key(origin, { key: 'f', code: 'KeyF', ctrlKey: true })).defaultPrevented).toBe(true);
            await act(async () => { model.setQuery('needle'); await model.settled(); });
            const field = container.querySelector<HTMLInputElement>('[data-testid="transcript-find.input"]')!;
            expect(field).not.toBeNull();
            expect(field.closest('[data-testid="find-composer-slot"]') !== null).toBe(width === 390);
            await act(async () => { field.focus(); });
            expect(model.status).toMatchObject({ current: 1, total: 2 });
            expect((await key(field, { key: 'Enter', code: 'Enter' })).defaultPrevented).toBe(true);
            expect(model.status).toMatchObject({ current: 2, total: 2 });
            await key(field, { key: 'Enter', code: 'Enter', isComposing: true });
            expect(model.status).toMatchObject({ current: 2, total: 2 });
            expect((await key(field, { key: 'Enter', code: 'Enter', shiftKey: true })).defaultPrevented).toBe(true);
            expect(model.status).toMatchObject({ current: 1, total: 2 });
            expect((await key(field, { key: 'Escape', code: 'Escape' })).defaultPrevented).toBe(true);
            expect(model.getSnapshot().open).toBe(false);
            expect(document.activeElement).toBe(origin);
        } finally { await act(async () => { root.unmount(); }); model.dispose(); container.remove(); }
    });
    it.each(['plain', 'e2ee'] as const)('finds a fetched %s page through normalization, reducer, Action registration and the real jump host', async (mode) => {
        const { SessionMessagesPageV1Schema} = await import('@happier-dev/protocol/sessions/messages/sessionMessagesPageV1');
        const { runSessionMessagesPagePipeline } = await import('@/sync/engine/sessions/sessionMessagesPagePipeline');
        const { createFindSurfaceRegistry } = await import('@/keyboard/findSurfaceRegistry');
        const { registerFindActionRuntime } = await import('@/keyboard/findActionRuntime');
        const { UiFindOutputSchema } = await import('@happier-dev/protocol/actions/findActionSpecs');
        const { SessionEncryption } = await import('@/sync/encryption/sessionEncryption');
        const { SecretBoxEncryption } = await import('@/sync/encryption/encryptor');
        const { EncryptionCache } = await import('@/sync/encryption/encryptionCache');
        const encryption = mode === 'e2ee'
            ? new SessionEncryption('s1', new SecretBoxEncryption(new Uint8Array(32).fill(7)), new EncryptionCache()) : null;
        const raw = { role: 'user' as const, content: { type: 'text' as const, text: '😀 needle and needle' } };
        const content = mode === 'plain' ? { t: 'plain' as const, v: raw }
            : { t: 'encrypted' as const, c: await encryption!.encryptRawRecord(raw) };
        const page = SessionMessagesPageV1Schema.parse({ messages: [{ id: 'wire-find-message', seq: 5,
            localId: null, sidechainId: null, createdAt: 5, updatedAt: 5,
            content }],
            hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
        await runSessionMessagesPagePipeline({ sessionId: 's1', purpose: 'older', lifecyclePolicy: 'suppress',
            page: { direction: 'older', requestPath: '/messages', scope: 'main' }, sessionEncryptionMode: mode,
            getSessionEncryption: () => encryption, request: async () => Response.json(page), sessionReceivedMessages: new Map(),
            applyMessages: (id, rows) => getStorage().getState().applyMessages(id, rows), log: { log() {} } });
        const stored = getStorage().getState().sessionMessages.s1;
        if (!stored) throw new Error('Transcript pipeline did not publish its Session');
        const message = stored.messagesById[stored.messageIdsOldestFirst[0]!];
        if (!message) throw new Error('Transcript reducer did not publish the fetched message');
        expect(message).toMatchObject({ kind: 'user-text', text: '😀 needle and needle' });
        const items: ChatTranscriptListItem[] = [{ kind: 'message', id: 'pipeline-row', messageId: message.id,
            seq: 5, createdAt: 5 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'pipeline-row', top: 500 }], scrollTop: 1000 });
        const element = harness.metrics.current.element;
        const row = element.querySelector<HTMLElement>('[data-testid="transcript-item-pipeline-row"]')!;
        const rect = (y: number, height: number) => ({ top: y - element.scrollTop, bottom: y + height - element.scrollTop,
            height, width: 800, left: 0, right: 800, x: 0, y: y - element.scrollTop, toJSON() {} });
        row.getBoundingClientRect = () => rect(1500, 80);
        const root = createRoot(row);
        const hook = await harness.render({ platformOS: 'web', resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        const model: ReturnType<typeof createTranscriptFindModel> = createTranscriptFindModel({
            readCorpus: () => ({ messages: Object.values(getStorage().getState().sessionMessages.s1.messagesById),
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, readClearancePx: () => 96,
                waitForVisualUpdate: async () => {
                    const ranges = model.rowStore.getSnapshot(message.id)?.blocks[0]?.sourceRanges;
                    // This external renderer-commit boundary must finish before the
                    // jump measures DOM. Nested act defers it until the outer Action act.
                    flushSync(() => { root.render(<FindHighlightedText text="😀 needle and needle" ranges={ranges} />); });
                    const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
                    expect(mark.textContent).toBe('needle');
                    // The first text line starts at the row edge; the fitting-row
                    // placement owner seats that edge below the 96px Find capsule.
                    mark.getBoundingClientRect = () => rect(1500, 20);
                }, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        const registry = createFindSurfaceRegistry();
        const releaseSurface = registry.register({ surfaceId: 'pipeline-chat', controller: model, containsFocus: () => true,
            open: () => model.open(), isOpen: () => model.getSnapshot().open, isInputFocused: () => false });
        const releaseRuntime = registerFindActionRuntime(registry);
        const context = { surface: 'ui' as const, serverId: environment!.home.id };
        const executor = createDefaultActionExecutor();
        try {
            await act(async () => {
                expect(await executor.execute('ui.find', { op: 'set', target: 'pipeline-chat', query: 'needle' }, context))
                    .toMatchObject({ ok: true });
                await model.settled();
            });
            const read = await executor.execute('ui.find', { op: 'read', target: 'pipeline-chat' }, context);
            if (!read.ok) throw new Error('Find Action was unavailable');
            const projected = UiFindOutputSchema.parse(read.result);
            expect(projected).toEqual({ status: 'results', current: 1, total: 2, coverage: 'complete' });
            expect(UiFindOutputSchema.safeParse({ ...projected, corpus: '😀 needle and needle' }).success).toBe(false);
            expect(model.rowStore.getSnapshot(message.id)?.blocks[0]?.sourceRanges[0]).toMatchObject({ start: 3, end: 9, current: true });
            expect(row.querySelector('[data-testid="find-match-current"]')!.getBoundingClientRect().top).toBe(96);
            releaseSurface();
            await expect(executor.execute('ui.find', { op: 'read', target: 'pipeline-chat' }, context))
                .resolves.toEqual({ ok: true, result: { status: 'noMountedSurface' } });
        } finally { releaseSurface(); releaseRuntime(); model.dispose(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it.each(['first-row', 'tall-card'] as const)('lands a complete-coverage %s after the renderer bootstrap changes scrollTop', async (kind) => {
        const tall = kind === 'tall-card';
        const output = `${'diff line\n'.repeat(55)}must not remount the modal\n${'diff line\n'.repeat(20)}`;
        const query = tall ? 'must not remount the modal' : 'remount';
        const message: Message = tall
            ? { kind: 'tool-call', id: 'bootstrap-message', localId: null, seq: 50, createdAt: 1, children: [],
                tool: { id: 'bash', name: 'Bash', state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2,
                    description: null, input: { command: 'git diff --no-color' }, result: { stdout: output, stderr: '' } } }
            : { kind: 'user-text', id: 'bootstrap-message', localId: null, seq: 1, createdAt: 1, text: query };
        installMessage(message);
        const items: ChatTranscriptListItem[] = [{ kind: 'message', id: 'bootstrap-row', messageId: message.id,
            seq: message.seq!, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'bootstrap-row', top: 0 }],
            scrollTop: 1500, scrollHeight: 3000 });
        const element = harness.metrics.current.element;
        const row = element.querySelector<HTMLElement>('[data-testid="transcript-item-bootstrap-row"]')!;
        const contentY = tall ? 500 : 96;
        const itemHeight = tall ? 1400 : 80;
        const rect = (y: number, height: number) => ({ top: y - element.scrollTop, bottom: y + height - element.scrollTop,
            height, width: 800, left: 0, right: 800, x: 0, y: y - element.scrollTop, toJSON() {} });
        row.getBoundingClientRect = () => rect(contentY, itemHeight);
        const root = createRoot(row);
        await act(async () => root.render(tall ? <CommandView command="git diff --no-color" stdout={output}
            stdoutFindRanges={[{ start: output.indexOf(query), end: output.indexOf(query) + query.length, current: true }]} />
            : <FindHighlightedText text={query} ranges={[{ start: 0, end: query.length, current: true }]} />));
        const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
        mark.getBoundingClientRect = () => rect(contentY + (tall ? 1000 : 0), 20);
        row.remove();
        // The browser renderer can synchronously scroll and mount its requested row. The DOM
        // rectangles then describe the new physical offset, not the driver's pre-bootstrap read.
        harness.listRef.current = { ...harness.renderer,
            scrollToIndex: () => { element.appendChild(row); element.scrollTop = contentY; } };
        const completedLandings: boolean[] = [];
        const hook = await harness.render({ platformOS: 'web',
            executeViewportCommandWithAnimation: command => {
                const applied = harness.base.executeViewportCommand(command);
                if (applied && command.kind === 'jump-to-seq') completedLandings.push(isTranscriptTargetObservedAtAlignment({
                    align: command.align, item: row, metrics: { ...harness.metrics.current!, scrollTop: element.scrollTop },
                }));
                return applied;
            } });
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 96, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        try {
            await act(async () => { model.setQuery(query); await model.settled(); });
            expect(model.status).toMatchObject({ current: 1, total: 1, coverage: 'complete' });
            // The renderer approach may precede the mount; the exact landing that completes the jump is aligned.
            expect(completedLandings.at(-1)).toBe(true);
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(mark.getBoundingClientRect().bottom).toBeLessThan(element.clientHeight);
            // Complete coverage: the reveal lands without reading any history page.
            expect(historyReads).toEqual([]);
        } finally { model.dispose(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it.each([false, true])('reveals the current CommandView output line (grouped=%s)', async (grouped) => {
        const output = `${'diff line\n'.repeat(55)}must not remount the modal\n${'diff line\n'.repeat(20)}`;
        const start = output.indexOf('must not remount');
        const message: Message = { kind: 'tool-call', id: 'tool-message', realID: 'persisted-tool', localId: null,
            seq: 50, createdAt: 1, children: [], tool: { id: 'bash', name: 'Bash', state: 'completed',
                createdAt: 1, startedAt: 1, completedAt: 2, description: null,
                input: { command: 'git diff --no-color' }, result: { stdout: output, stderr: '' } } };
        installMessage(message);
        const items: ChatTranscriptListItem[] = grouped ? [
            { kind: 'tool-group-header', id: 'group#header', groupId: 'group', toolMessageIds: [message.id], expanded: true, hiddenCount: 0, createdAt: 1 },
            { kind: 'tool-group-tool', id: 'tool-row', groupId: 'group', toolMessageIds: [message.id], toolMessageId: message.id, expanded: true, seq: 50, createdAt: 1 },
        ] : [{ kind: 'message', id: 'tool-row', messageId: message.id, seq: 50, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [
            { id: 'group#header', top: -1050, height: 50 }, { id: 'tool-row', top: -1000, height: 1400 },
        ], scrollTop: 1500, scrollHeight: 3000 });
        const element = harness.metrics.current.element;
        const row = element.querySelector<HTMLElement>('[data-testid="transcript-item-tool-row"]')!;
        const rect = (y: number, height: number) => ({ top: y - element.scrollTop, bottom: y + height - element.scrollTop,
            height, width: 800, left: 0, right: 800, x: 0, y: y - element.scrollTop, toJSON() {} });
        row.getBoundingClientRect = () => rect(500, 1400);
        const root = createRoot(row);
        const hook = await harness.render({ platformOS: 'web', resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items, setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => 96, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            }, context),
        });
        try {
            await act(async () => { root.render(<CommandView command="git diff --no-color" stdout={output}
                stdoutFindRanges={[{ start, end: start + 'must not remount the modal'.length, current: true }]} />); });
            const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
            expect(mark.textContent).toBe('must not remount the modal');
            mark.getBoundingClientRect = () => rect(1500, 20);
            await act(async () => { model.setQuery('must not remount the modal'); await model.settled(); });
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(mark.getBoundingClientRect().bottom).toBeLessThan(element.clientHeight);
        } finally { model.dispose(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it.each(['continue', 'stop', 'close'] as const)('handles a query entered before hydration and later clearance (intent=%s)', async (intent) => {
        const message: Message = { kind: 'user-text', id: 'first-message', localId: null, seq: 1, createdAt: 1, text: 'remount' };
        installMessage(message);
        const items: ChatTranscriptListItem[] = [{ kind: 'message', id: 'first-row', messageId: message.id, seq: 1, createdAt: 1 }];
        const harness = createTranscriptJumpHostTestHarness({ rows: items, messages: { [message.id]: message } });
        harness.metrics.current = createTranscriptJumpWebMetrics({ rows: [{ id: 'first-row', top: 10 }], scrollTop: 0 });
        const element = harness.metrics.current.element;
        let clearance = 0;
        let contentY = 10;
        let scrollTop = 1500;
        // Browser clamping and the recycler's header-resize compensation are external geometry facts.
        Object.defineProperty(element, 'scrollTop', { get: () => scrollTop, set: value => { scrollTop = Math.max(0, value); } });
        const row = element.querySelector('[data-testid="transcript-item-first-row"]')!;
        const rect = () => ({ top: contentY - scrollTop, bottom: contentY + 80 - scrollTop, height: 80,
            width: 800, left: 0, right: 800, x: 0, y: contentY - scrollTop, toJSON() {} });
        row.getBoundingClientRect = rect;
        const root = createRoot(row);
        await act(async () => { root.render(<FindHighlightedText text="remount" ranges={[{ start: 0, end: 7, current: true }]} />); });
        const mark = row.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
        mark.getBoundingClientRect = rect;
        const hook = await harness.render({ platformOS: 'web', resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        let corpus: TranscriptFindCorpus = { messages: [], history: { isLoaded: false, hasOlder: false, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 's1', serverId: null, messages: [],
            historyState: corpus.history, reducerState: null, metadata: null, agentState: null });
        const model = createTranscriptFindModel({ readCorpus: () => corpus, loadPage: null,
            jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => clearance,
                jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><TranscriptFindSurface model={model} source={source} sessionId="s1" serverId={null}
            focused viewportRef={React.createRef()} items={items} loadedMessages={[]} publishCorpus={next => { corpus = next; }}
            measureMessage={() => null} contentHeight={2000} onClearanceChange={value => { clearance = value; }}><></></TranscriptFindSurface></PluginSurfaceFocusEligibilityProvider>);
        try {
            await act(async () => { model.setQuery('remount'); await model.settled(); });
            expect(model.status).toMatchObject({ current: null, total: 0, coverage: 'loaded' });
            if (intent !== 'continue') await act(async () => model[intent]());
            await act(async () => source.update({ messages: [message],
                historyState: { isLoaded: true, hasOlder: false, isLoadingOlder: false },
                reducerState: null, metadata: null, agentState: null }));
            await model.settled();
            if (intent !== 'continue') {
                expect(scrollTop).toBe(1500);
                expect(model.getSnapshot().open).toBe(intent !== 'close');
                return;
            }
            // Hydration selects the first result with no new query, step or clearance event.
            expect(model.status).toMatchObject({ current: 1, total: 1 });
            expect(mark.getBoundingClientRect().top).toBe(10);
            const placement = screen.tree.root.findByType(FindBarPlacement);
            const onLayout = placement.props.onLayout;
            if (!onLayout) throw new Error('Find placement requires its layout boundary');
            // The header expands, preserving the old visible row before the Find clearance effect runs.
            contentY = 96; scrollTop = 86;
            await act(async () => { onLayout(createLayoutChangeEvent({ x: 14, y: 10, width: 560, height: 74 })); });
            await model.settled();
            expect(clearance).toBe(96);
            expect(rect().top).toBe(96);
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(model.status).toMatchObject({ current: 1, total: 1 });
            expect(model.query).toBe('remount');
        } finally { await act(async () => model.dispose()); await screen.unmount(); await act(async () => root.unmount()); await hook.unmount(); }
    });

    it('re-seats match 8 below the older-history note that appears during that step', async () => {
        const messages: Message[] = Array.from({ length: 8 }, (_, index) => ({
            kind: 'user-text', id: `message-${index + 1}`, localId: null, seq: index + 1,
            createdAt: index + 1, text: 'remount',
        }));
        const items: ChatTranscriptListItem[] = messages.map(message => ({
            kind: 'message', id: `row-${message.id}`, messageId: message.id, seq: message.seq!, createdAt: message.createdAt,
        }));
        const harness = createTranscriptJumpHostTestHarness({ rows: items,
            messages: Object.fromEntries(messages.map(message => [message.id, message])) });
        harness.metrics.current = createTranscriptJumpWebMetrics({
            rows: items.map((item, index) => ({ id: item.id, top: index * 120, height: 80 })),
            scrollTop: 0, scrollHeight: 2000,
        });
        const element = harness.metrics.current.element;
        const targetRow = element.querySelector<HTMLElement>('[data-testid="transcript-item-row-message-8"]')!;
        const rect = () => ({ top: 840 - element.scrollTop, bottom: 920 - element.scrollTop,
            height: 80, width: 800, left: 0, right: 800, x: 0, y: 840 - element.scrollTop, toJSON() {} });
        targetRow.getBoundingClientRect = rect;
        const root = createRoot(targetRow);
        await act(async () => root.render(<FindHighlightedText text="remount" ranges={[{ start: 0, end: 7, current: true }]} />));
        const mark = targetRow.querySelector<HTMLElement>('[data-testid="find-match-current"]')!;
        mark.getBoundingClientRect = rect;
        const hook = await harness.render({ platformOS: 'web',
            resolveWebScrollMetrics: () => ({ ...harness.metrics.current!, scrollTop: element.scrollTop }) });
        let clearance = 0;
        let corpus: TranscriptFindCorpus = { messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 's1', serverId: null, messages,
            historyState: corpus.history, reducerState: null, metadata: null, agentState: null });
        const model = createTranscriptFindModel({ readCorpus: () => corpus, loadPage: null,
            jumpToTarget: hook.getCurrent().jumpToTranscriptTarget,
            reveal: (match, context) => revealTranscriptFindMatch(match, { items,
                setToolCallsGroupExpanded() {}, setThinkingExpanded() {}, waitForVisualUpdate: async () => {},
                readClearancePx: () => clearance, jumpToTarget: hook.getCurrent().jumpToTranscriptTarget }, context),
        });
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><TranscriptFindSurface
            model={model} source={source} sessionId="s1" serverId={null} focused viewportRef={React.createRef()}
            items={items} loadedMessages={messages} publishCorpus={next => { corpus = next; }} measureMessage={() => null}
            contentHeight={2000} onClearanceChange={value => { clearance = value; }}><></></TranscriptFindSurface></PluginSurfaceFocusEligibilityProvider>);
        try {
            await act(async () => { model.setQuery('remount'); await model.settled(); });
            const placement = screen.tree.root.findByType(FindBarPlacement);
            const onLayout = placement.props.onLayout;
            if (!onLayout) throw new Error('Find placement requires its layout boundary');
            await act(async () => onLayout(createLayoutChangeEvent({ x: 14, y: 10, width: 560, height: 34 })));
            for (let index = 1; index < 7; index += 1) {
                await act(async () => { model.step(1); await model.settled(); });
            }
            expect(screen.tree.root.findByType(FindBar).props.note).toBeUndefined();
            await act(async () => {
                model.step(1);
                await model.settled();
                source.update({ messages, historyState: { isLoaded: true, hasOlder: true, isLoadingOlder: false },
                    reducerState: null, metadata: null, agentState: null });
            });
            expect(screen.tree.root.findByType(FindBar).props.note).toMatchObject({ icon: 'history' });
            expect(mark.getBoundingClientRect().top).toBe(56);
            // Native layout reports the new note's height only after the step decides its presence.
            await act(async () => onLayout(createLayoutChangeEvent({ x: 14, y: 10, width: 560, height: 74 })));
            await model.settled();
            expect(clearance).toBe(96);
            expect(mark.getBoundingClientRect().top).toBe(96);
            expect(model.status).toMatchObject({ current: 8, total: 8, coverage: 'loaded' });
        } finally { await act(async () => model.dispose()); await screen.unmount(); await act(async () => root.unmount()); await hook.unmount(); }
    });
});
