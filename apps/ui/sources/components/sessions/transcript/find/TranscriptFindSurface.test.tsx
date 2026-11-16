import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { KeyboardShortcutContextBridge, type KeyboardShortcutContextSnapshot } from '@/keyboard/KeyboardShortcutProvider';
import { executeFindAction, registerFindActionRuntime } from '@/keyboard/findActionRuntime';
import { createFindSurfaceRegistry } from '@/keyboard/findSurfaceRegistry';
import { NO_KEYBOARD_SHORTCUT_LABELS } from '@/keyboard/shortcutLabels';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createReadOnlySessionTranscriptSource } from '../source/readOnlySessionTranscriptSource';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import { TranscriptFindSurface } from './TranscriptFindSurface';
import { revealTranscriptFindMatch } from './revealTranscriptFindMatch';
import { createTranscriptFindModel, type TranscriptFindCorpus } from './useTranscriptFind';
import { buildChatListItems } from '../../chatListItems';
import { OlderLoadRetryOverlay } from '../OlderLoadRetryOverlay';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

describe('transcript Find surface registration', () => {
    it('withdraws addressed Find while retained ineligible and resumes its real controller when eligible again', async () => {
        const message = (id: string, seq: number): Message => ({
            kind: 'user-text', id, localId: null, createdAt: seq, seq, text: 'needle',
        });
        let corpus: TranscriptFindCorpus = {
            messages: [message('loaded', 2)],
            history: { isLoaded: true, hasOlder: true, isLoadingOlder: false },
        };
        // Paging and viewport scrolling are the external boundaries; source,
        // display projection, matching, reveal and registration remain real.
        let failNextPage = true;
        const loadOlder = vi.fn(async () => {
            if (failNextPage) {
                failNextPage = false;
                return { loaded: 0, hasMore: true, status: 'retryable_error' as const };
            }
            corpus = { messages: [message('older', 1), ...corpus.messages],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
            source.update({ messages: corpus.messages, historyState: corpus.history,
                reducerState: null, metadata: null, agentState: null });
            return { loaded: 1, hasMore: false, status: 'loaded' as const };
        });
        const source = createReadOnlySessionTranscriptSource({
            sessionId: 'session', serverId: 'home', messages: corpus.messages,
            reducerState: null, metadata: null, agentState: null,
            historyState: corpus.history, loadOlder,
        });
        const jump = vi.fn(async (target: TranscriptJumpTarget): Promise<TranscriptJumpResult> => ({ status: 'scrolled', target }));
        const model = createTranscriptFindModel({
            readCorpus: () => corpus,
            loadPage: () => source.history.loadOlder!(),
            jumpToTarget: jump,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items: [], setToolCallsGroupExpanded() {}, setThinkingExpanded() {},
                waitForVisualUpdate: async () => {}, jumpToTarget: jump, readClearancePx: () => 0,
            }, context),
        });
        const registry = createFindSurfaceRegistry();
        const release = registerFindActionRuntime(registry);
        const keyboard: KeyboardShortcutContextSnapshot = {
            registration: {
                find: registry, refreshFindAvailability() {}, registerHandlers: () => () => {},
                executeCommand: () => false, submitFindInput: () => false,
                labels: { getState: () => NO_KEYBOARD_SHORTCUT_LABELS, subscribe: () => () => {} },
            },
        };
        const viewportRef = React.createRef<React.ElementRef<typeof View>>();
        const publishCorpus = (next: TranscriptFindCorpus) => { corpus = next; };
        const measureMessage = () => null;
        function SourceSurface() {
            const ids = source.useMessageIdsOldestFirst();
            const byId = source.useMessagesById();
            const items = React.useMemo(() => buildChatListItems({
                messageIdsOldestFirst: ids, messagesById: byId, pendingMessages: [],
            }), [ids, byId]);
            return <TranscriptFindSurface model={model} source={source} sessionId="session" serverId="home"
                viewportRef={viewportRef} items={items} loadedMessages={[]}
                publishCorpus={publishCorpus} measureMessage={measureMessage} contentHeight={0}>
                <View testID="retained-transcript" />
            </TranscriptFindSurface>;
        }
        const render = (eligible: boolean, focused = true) => <KeyboardShortcutContextBridge snapshot={keyboard}>
            <PluginSurfaceFocusEligibilityProvider active={eligible}>
                {/* The hosting tab's own focus, from its destination owner. */}
                <DestinationInstanceHost tabId="transcript" ref={{ kind: 'project', params: { workspaceRefId: 'project-a' } }}
                    pathname="/projects/project-a" focused={focused} visible navigation={{ push() {}, replace() {}, back() {} }}>
                    <SourceSurface />
                </DestinationInstanceHost>
            </PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutContextBridge>;
        const execute = (input: unknown) => executeFindAction({
            actionId: 'ui.find', input, context: { surface: 'agent' },
        });
        const unavailable = { ok: true, result: { status: 'noMountedSurface' } };
        const hiddenOperations = [
            { op: 'read', target: 'transcript:home:session' },
            { op: 'set', target: 'transcript:home:session', query: 'hidden query' },
            { op: 'step', target: 'transcript:home:session', direction: -1 },
        ];
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            screen = await renderScreen(render(true));
            await screen.update(render(false));
            for (const operation of hiddenOperations) {
                await expect(execute(operation)).resolves.toEqual(unavailable);
            }
            expect(model.getSnapshot()).toMatchObject({ open: false, query: '' });
            expect(loadOlder).not.toHaveBeenCalled();
            expect(jump).not.toHaveBeenCalled();

            await screen.update(render(true));
            await act(async () => {
                expect(await execute({ op: 'set', target: 'transcript:home:session', query: 'needle' }))
                    .toMatchObject({ result: { status: 'results', total: 1 } });
                await model.settled();
            });
            expect(model.getSnapshot()).toMatchObject({ open: true, query: 'needle' });
            expect(jump).toHaveBeenCalledWith(expect.objectContaining({ routeMessageId: 'loaded' }), expect.anything());

            // A retained open model must not page or reveal through addressed Actions.
            // The transcript's own focused fact is an independent eligibility fence.
            await screen.update(render(true, false));
            jump.mockClear();
            const retained = model.getSnapshot();
            for (const operation of hiddenOperations) {
                await expect(execute(operation)).resolves.toEqual(unavailable);
            }
            await model.settled();
            expect(model.getSnapshot()).toBe(retained);
            expect(loadOlder).not.toHaveBeenCalled();
            expect(jump).not.toHaveBeenCalled();

            await screen.update(render(true));
            await act(async () => {
                await execute({ op: 'step', target: 'transcript:home:session', direction: -1 });
                await model.settled();
            });
            expect(model.status).toMatchObject({ coverage: 'partialErrors', total: 1 });
            expect(screen.findByTestId('transcript-find-retry')).not.toBeNull();
            await act(async () => {
                screen!.pressByTestId('transcript-find-retry');
                await model.settled();
            });
            expect(await execute({ op: 'read', target: 'transcript:home:session' })).toMatchObject({
                result: { status: 'results', current: 1, total: 2, coverage: 'complete' },
            });
            expect(loadOlder).toHaveBeenCalled();
            expect(jump).toHaveBeenCalledWith(expect.objectContaining({ routeMessageId: 'older' }), expect.anything());
        } finally {
            await screen?.unmount();
            release();
            model.dispose();
        }
    });
});

describe('transcript older-load failure notice beside Find', () => {
    const message: Message = { kind: 'user-text', id: 'loaded', localId: null, createdAt: 2, seq: 2, text: 'needle' };
    const history = { isLoaded: true, hasOlder: true, isLoadingOlder: false } as const;
    const corpus: TranscriptFindCorpus = { messages: [message], history };

    async function renderFailedOlderLoad(openFind: boolean) {
        const source = createReadOnlySessionTranscriptSource({
            sessionId: 'session', serverId: 'home', messages: [message], reducerState: null,
            metadata: null, agentState: null, historyState: history,
            loadOlder: async () => ({ loaded: 0, hasMore: true, status: 'retryable_error' as const }),
        });
        const model = createTranscriptFindModel({
            readCorpus: () => corpus, loadPage: null,
            jumpToTarget: async (target) => ({ status: 'scrolled', target }),
            reveal: async () => {},
        });
        if (openFind) { model.open(); model.setQuery('needle'); }
        const retryOlder = vi.fn();
        const viewportRef = React.createRef<React.ElementRef<typeof View>>();
        const screen = await renderScreen(<TranscriptFindSurface model={model} source={source} sessionId="session"
            serverId="home" viewportRef={viewportRef} items={[]} loadedMessages={[]}
            publishCorpus={() => {}} measureMessage={() => null} contentHeight={0}
            olderLoadFailed onRetryOlderLoad={retryOlder}>
            <OlderLoadRetryOverlay onRetry={retryOlder} />
        </TranscriptFindSurface>);
        return { screen, model, retryOlder };
    }

    it('shows one notice: the failure moves into the open Find note with the same Retry', async () => {
        const { screen, model, retryOlder } = await renderFailedOlderLoad(true);
        try {
            expect(screen.findByTestId('transcript.olderLoad.failed')).toBeNull();
            await act(async () => { screen.pressByTestId('transcript-find-older-load-retry'); });
            expect(retryOlder).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
            model.dispose();
        }
    });

    it('keeps the transcript banner when Find is closed', async () => {
        const { screen, model } = await renderFailedOlderLoad(false);
        try {
            expect(screen.findByTestId('transcript.olderLoad.failed')).not.toBeNull();
            expect(screen.findByTestId('transcript-find-older-load-retry')).toBeNull();
        } finally {
            await screen.unmount();
            model.dispose();
        }
    });
});
