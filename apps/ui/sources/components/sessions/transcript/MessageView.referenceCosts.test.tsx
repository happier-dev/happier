import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { installMessageViewCommonModuleMocks, revealTranscriptMessageActions } from './messageViewTestHelpers';

// Platform boundaries only: the source, storage, reference projection and Markdown stay real.
installMessageViewCommonModuleMocks({ storage: (importOriginal) => importOriginal() });
const { initializeRealAppRuntimeForTests } = await import('@/dev/testkit/harness/realAppRuntimeHarness');
await initializeRealAppRuntimeForTests();
const { createSessionFixture, renderHook, renderScreen, standardCleanup, flushHookEffects, renderWithSessionTranscriptSource } = await import('@/dev/testkit');
const { storage, useSession } = await import('@/sync/domains/state/storage');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { useSessionTranscriptSource } = await import('./source/SessionTranscriptSourceContext');
const { useTranscriptSessionCommon } = await import('./transcriptSessionCommon');
const { MessageView } = await import('./MessageView');
const { ChatListMessageRow } = await import('./ChatListRows');
const { CommittedMessageActions } = await import('./messageActions/CommittedMessageActions');
const { TranscriptMessageSelectionProvider, TranscriptMessageSelectionBoundary } = await import('./messageSelection/TranscriptMessageSelectionContext');
const { PluginMessageActionHostProvider } = await import('./messageActions/PluginMessageActions');
const { useChatListRootState } = await import('./useChatListRootState');
const { PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
// @ts-expect-error RN-web publishes this DOM-listener hook without a declaration.
const webHoverModule = await import('react-native-web/dist/modules/useHover/index.js');
const useWebHover = webHoverModule.default as (
    target: React.RefObject<EventTarget>, config: Readonly<{ onHoverStart?: () => void; onHoverEnd?: () => void }>
) => void;

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    storage.setState(storage.getInitialState(), true);
});

describe('transcript inline reference arrival costs', () => {
    it('keeps committed action and jump rows unchanged across real root streaming chunks', async () => {
        const session = createSessionFixture({ id: 'reveal-churn' });
        const committed: NormalizedMessage[] = Array.from({ length: 4 }, (_, index) => {
            const common = { id: `committed-${index}`, seq: index + 1, localId: null, createdAt: index + 1, isSidechain: false };
            return index % 2 === 0 ? { ...common, role: 'user', content: { type: 'text', text: `Prompt ${index}` } }
                : { ...common, role: 'agent', content: [{ type: 'text', text: `Answer ${index}`, uuid: common.id, parentUUID: null }] };
        });
        const chunk = (index: number): NormalizedMessage => ({
            id: 'reveal-stream', localId: 'reveal-stream', createdAt: 5, seq: 5,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: `Streaming answer ${index}`, uuid: 'reveal-stream', parentUUID: null }],
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'reveal-stream',
                segmentState: 'streaming', startedAtMs: 1, updatedAtMs: index + 1 } },
        });
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, [...committed, chunk(0)]);
        storage.getState().applyMessagesLoaded(session.id);
        const ids = storage.getState().sessionMessages[session.id]!.messageIdsOldestFirst;
        const committedRouteIds = new Set(Object.values(storage.getState().sessionMessages[session.id]!.messagesById)
            .filter(message => message.localId !== 'reveal-stream').map(buildMessageRouteId));
        // Instrument renders without replacing any internal implementation.
        const actionRenders = vi.spyOn(await import('./messageActions/CommittedMessageActions'), 'CommittedMessageActions');
        const rowRenders = vi.spyOn(await import('./messageActions/MessageActionRow'), 'MessageActionRow');
        const jumpRenders = vi.spyOn(await import('./navigation/TranscriptJumpHighlightOverlay'), 'TranscriptJumpAttention');
        const resolveThinkingExpanded = () => false;
        const setThinkingExpanded = () => {};
        const getMessageRevisionById = (id: string) => storage.getState().sessionMessages[session.id]?.messageRevisionsById?.[id] ?? null;
        function Transcript() {
            const currentSession = useSession(session.id) ?? session;
            const { internalProps: props, boundary, pluginMessageActionHost } = useChatListRootState({ session: currentSession, sessionSurfaceKey: session.id });
            return <PluginMessageActionHostProvider host={pluginMessageActionHost}>
                <TranscriptMessageSelectionBoundary key={boundary.key} sessionId={boundary.sessionId}
                    eligibleMessageIdsInOrder={boundary.eligibleMessageIdsInOrder} enabled={boundary.selectionEnabled}>
                {ids.map(id => <ChatListMessageRow key={id} messageId={id}
                sessionId={props.sessionId} metadata={props.metadata} activeThinkingMessageId={props.activeThinkingMessageId}
                interaction={props.interaction} eventEmphasisByMessageId={props.eventEmphasisByMessageId}
                rollbackAction={props.rollbackActionsByMessageId[id] ?? null} rollbackRanges={props.rollbackRanges}
                messagePins={props.messagePins} onToggleMessagePin={props.onToggleMessagePin}
                forkCommon={props.forkCommon} messageDisplayCommon={props.messageDisplayCommon}
                toolChromeCommon={props.toolChromeCommon} toolRouteCommon={props.toolRouteCommon}
                resolveThinkingExpanded={resolveThinkingExpanded} setThinkingExpanded={setThinkingExpanded}
                getMessageRevisionById={getMessageRevisionById} />)}
                </TranscriptMessageSelectionBoundary>
            </PluginMessageActionHostProvider>;
        }
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id}>
            <PluginContextualResourceStoreProvider><Transcript /></PluginContextualResourceStoreProvider>
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 5, turns: 2 });
        expect(new Set(actionRenders.mock.calls.filter(([props]) => props.message.localId !== 'reveal-stream')
            .map(([props]) => props.message.id)).size).toBe(committed.length);
        expect(rowRenders.mock.calls.length).toBeGreaterThanOrEqual(committed.length);
        expect(jumpRenders.mock.calls.length).toBeGreaterThanOrEqual(committed.length);
        actionRenders.mockClear();
        rowRenders.mockClear();
        jumpRenders.mockClear();
        for (let index = 1; index <= 5; index++) {
            await act(async () => { storage.getState().applyMessages(session.id, [chunk(index)]); });
        }
        const counts = {
            committedActions: actionRenders.mock.calls.filter(([props]) => props.message.localId !== 'reveal-stream').length,
            committedActionRows: rowRenders.mock.calls.filter(([props]) => committedRouteIds.has(props.messageId)).length,
            committedJumpAttention: jumpRenders.mock.calls.filter(([props]) => props.routeMessageId && committedRouteIds.has(props.routeMessageId)).length,
            streamingActions: actionRenders.mock.calls.filter(([props]) => props.message.localId === 'reveal-stream').length,
            streamingActionRows: rowRenders.mock.calls.filter(([props]) => !committedRouteIds.has(props.messageId)).length,
            streamingJumpAttention: jumpRenders.mock.calls.filter(([props]) => !props.routeMessageId || !committedRouteIds.has(props.routeMessageId)).length,
        };
        console.info('reveal-churn-render-counts', JSON.stringify(counts));
        expect(counts.committedActions).toBe(0);
        expect(counts.committedActionRows).toBe(0);
        expect(counts.committedJumpAttention).toBe(0);
        expect(actionRenders.mock.calls.at(-1)?.[0].copyText).toBe('Streaming answer 5');
        actionRenders.mockClear();
        await act(async () => { storage.getState().applySettingsLocal({ transcriptMessageCopyActionEnabled: false }); });
        const changedCommittedActions = actionRenders.mock.calls.filter(([props]) => props.message.localId !== 'reveal-stream');
        expect(new Set(changedCommittedActions.map(([props]) => props.message.id)).size).toBe(committed.length);
        expect(changedCommittedActions.every(([props]) => props.settings.transcriptMessageCopyActionEnabled === false)).toBe(true);
        expect(screen.tree.root.findAll(node => node.props.accessibilityLabel === 'common.copy')).toHaveLength(0);
    });

    it.each(['user-text', 'agent-text'] as const)('does not reinstall %s action hover listeners during row reveal changes', async (kind) => {
        const message: UserTextMessage | AgentTextMessage = kind === 'agent-text'
            ? { kind, id: 'action-identity', localId: null, createdAt: 1, text: 'Committed answer', isThinking: false }
            : { kind, id: 'action-identity', localId: null, createdAt: 1, text: 'Committed prompt' };
        storage.getState().applySettingsLocal({ transcriptMessageSelectionEnabled: true });
        const element = (current: typeof message) => <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={[message.id]}>
            <MessageView sessionId="s1" metadata={null} message={current} />
        </TranscriptMessageSelectionProvider>;
        const screen = await renderWithSessionTranscriptSource(element(message));
        await flushHookEffects({ cycles: 5, turns: 2 });
        const readActions = () => screen.tree.root.findByType(CommittedMessageActions).props as React.ComponentProps<typeof CommittedMessageActions>;
        const initial = readActions();
        await revealTranscriptMessageActions(screen, message.id);
        // The row's hover host (`hoverProps`) replaced per-button hover callbacks.
        expect(initial.hoverProps?.onPointerEnter).toBeTypeOf('function');
        const target = new EventTarget();
        const installs = vi.spyOn(target, 'addEventListener');
        const targetRef = { current: target };
        expect(useWebHover).toBeTypeOf('function');
        const hover = await renderHook((actions: typeof initial) => {
            useWebHover(targetRef, {
                onHoverStart: actions.hoverProps?.onPointerEnter, onHoverEnd: actions.hoverProps?.onPointerLeave,
            });
            return true;
        }, { initialProps: initial });
        expect(hover.getCurrent()).toBe(true);
        const enterEvent = installs.mock.calls.map(([event]) => event)
            .find(event => event === 'mouseenter' || event === 'pointerenter');
        expect(enterEvent).toBeDefined();
        installs.mockClear();
        const hoverHost = screen.tree.root.findAll(node => typeof node.type === 'string'
            && typeof node.props.onPointerEnter === 'function' && typeof node.props.onPointerLeave === 'function')[0];
        expect(hoverHost).toBeDefined();
        for (let index = 0; index < 5; index += 1) {
            await act(async () => hoverHost!.props.onPointerEnter());
            expect(readActions().showActions).toBe(true);
            await act(async () => hoverHost!.props.onPointerLeave());
            const current = readActions();
            expect(current.showActions).toBe(false);
            await hover.rerender(current);
        }
        expect(installs.mock.calls.filter(([event]) => event === enterEvent)).toHaveLength(0);
        await screen.update(element({ ...message, text: 'Updated committed text' }));
        expect(readActions().copyText).toBe('Updated committed text');
        await hover.rerender(readActions());
        expect(installs.mock.calls.filter(([event]) => event === enterEvent)).toHaveLength(0);
        await act(async () => { target.dispatchEvent(new Event(enterEvent!)); });
        expect(readActions().showActions).toBe(true);
        await act(async () => { readActions().hoverProps?.onPointerLeave(); readActions().onActionsFocus(); });
        expect(readActions().showActions).toBe(true);
        await act(async () => readActions().onActionsBlur());
        expect(readActions().showActions).toBe(false);
        await hover.unmount();
    });

    it('does not re-admit unchanged reference records when the message hover changes', async () => {
        const records = Array.from({ length: 8 }, (_, index) => {
            const ref = `session:hover-reference-${index}`;
            const label = `Reference ${index}`;
            return { kind: 'happier.session', ref, label, token: formatInlineReferenceTokenV1({ label, ref }) };
        });
        const visits = { envelopePeeks: 0, mentionArrayReads: 0, mentionFieldReads: 0 };
        const mentions = records.map(record => ({
            get kind() { visits.mentionFieldReads += 1; return record.kind; },
            get ref() { visits.mentionFieldReads += 1; return record.ref; },
            get label() { visits.mentionFieldReads += 1; return record.label; },
            get token() { visits.mentionFieldReads += 1; return record.token; },
        }));
        const structuredInput = { v: 1 as const, get mentions() {
            visits.mentionArrayReads += 1;
            return mentions;
        } };
        // Keep the ordinary missing-happier shape. Its cheap completion-kind
        // fallback may peek at this envelope without admitting any mentions.
        const meta: NonNullable<UserTextMessage['meta']> = { get happierStructuredInputV1() {
            visits.envelopePeeks += 1;
            return structuredInput;
        } };
        const message: UserTextMessage = {
            kind: 'user-text', id: 'hover-reference-costs', localId: null, createdAt: 1,
            text: records.map(record => record.token).join(' '), meta,
        };
        const screen = await renderWithSessionTranscriptSource(<MessageView sessionId="s1" metadata={null} message={message} />);
        await flushHookEffects({ cycles: 5, turns: 2 });
        expect(visits.mentionArrayReads).toBeGreaterThan(0);
        expect(visits.mentionFieldReads).toBeGreaterThan(0);
        const beforeHover = { ...visits };
        const hoverHost = screen.tree.root.findAll(node => typeof node.type === 'string'
            && typeof node.props.onPointerEnter === 'function' && typeof node.props.onPointerLeave === 'function')[0];
        expect(hoverHost).toBeDefined();
        for (let index = 0; index < 5; index += 1) {
            await act(async () => hoverHost!.props.onPointerEnter());
            await act(async () => hoverHost!.props.onPointerLeave());
        }
        const hover = {
            envelopePeeks: visits.envelopePeeks - beforeHover.envelopePeeks,
            mentionArrayReads: visits.mentionArrayReads - beforeHover.mentionArrayReads,
            mentionFieldReads: visits.mentionFieldReads - beforeHover.mentionFieldReads,
        };
        console.info('transcript-reference-hover-work', JSON.stringify(hover));
        expect(hover.mentionArrayReads).toBe(0);
        expect(hover.mentionFieldReads).toBe(0);

        const beforeUpdate = { ...visits };
        await screen.update(<MessageView sessionId="s1" metadata={null} message={{ ...message,
            // Use the uninstrumented fixture record so setup itself cannot
            // satisfy the changed-message sensitivity control.
            text: `Updated ${records[0]!.token}`,
        }} />);
        expect(screen.findAllByType('EnrichedMarkdownText').some(node => String(node.props.markdown).startsWith('Updated '))).toBe(true);
        const update = {
            mentionArrayReads: visits.mentionArrayReads - beforeUpdate.mentionArrayReads,
            mentionFieldReads: visits.mentionFieldReads - beforeUpdate.mentionFieldReads,
        };
        console.info('transcript-reference-changed-message-work', JSON.stringify(update));
        expect(update.mentionArrayReads).toBeGreaterThan(0);
        expect(update.mentionFieldReads).toBeGreaterThan(0);
    });

    it('keeps historical chip rows uncommitted on unrelated arrivals and tail streaming updates', async () => {
        const session = createSessionFixture({ id: 'reference-costs' });
        const historicalCount = 100;
        const mentions = Array.from({ length: 8 }, (_, index) => {
            const ref = `session:reference-${index}`;
            const label = `Reference ${index}`;
            return { kind: 'happier.session', ref, label, token: formatInlineReferenceTokenV1({ label, ref }) };
        });
        const makeMessage = (index: number, text = mentions.map(mention => mention.token).join(' ')): NormalizedMessage => {
            const common = {
                id: `reference-message-${index}`, seq: index + 1, localId: null, createdAt: index + 1,
                isSidechain: false, meta: { happierStructuredInputV1: { v: 1 as const, mentions } },
            };
            return index % 2 === 0
                ? { ...common, role: 'user', content: { type: 'text', text } }
                : { ...common, role: 'agent', content: [{ type: 'text', text, uuid: common.id, parentUUID: null }] };
        };
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, Array.from({ length: historicalCount }, (_, index) => makeMessage(index)));
        storage.getState().applyMessagesLoaded(session.id);
        const historicalIds = new Set(storage.getState().sessionMessages[session.id]!.messageIdsOldestFirst);
        const chunk = (text: string, updatedAtMs: number): NormalizedMessage => ({
            id: 'stream-segment', localId: 'stream-segment', createdAt: historicalCount + 1,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text, uuid: 'stream-segment', parentUUID: null }],
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
                segmentLocalId: 'stream-segment', segmentState: 'streaming', startedAtMs: 1, updatedAtMs } },
        });
        storage.getState().applyMessages(session.id, [chunk('Starting answer', 1)]);
        let historicalCommits = 0;
        const rowProps = {
            sessionId: session.id, metadata: session.metadata, activeThinkingMessageId: null,
            resolveThinkingExpanded: () => false, setThinkingExpanded: () => {},
            rollbackRanges: [], messagePins: [], onToggleMessagePin: () => {},
            getMessageRevisionById: (id: string) => storage.getState().sessionMessages[session.id]?.messageRevisionsById?.[id] ?? null,
        };
        const Row = React.memo(function Row({ id, common }: Readonly<{ id: string; common: ReturnType<typeof useTranscriptSessionCommon> }>) {
            const interaction = useSessionTranscriptSource().useInteraction();
            return <React.Profiler id={id} onRender={() => { if (historicalIds.has(id)) historicalCommits += 1; }}>
                <ChatListMessageRow {...rowProps} messageId={id} interaction={interaction}
                    forkCommon={common.fork} messageDisplayCommon={common.messageDisplay}
                    toolChromeCommon={common.toolChrome} toolRouteCommon={common.toolRoute} />
            </React.Profiler>;
        });
        function Transcript() {
            const ids = useSessionTranscriptSource().useMessageIdsOldestFirst();
            const common = useTranscriptSessionCommon();
            return <>{ids.map(id => <Row key={id} id={id} common={common} />)}</>;
        }
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id}>
            <Transcript />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 5, turns: 2 });
        expect(screen.findAllByType('EnrichedMarkdownText').length).toBeGreaterThanOrEqual(historicalCount);
        historicalCommits = 0;
        for (let index = historicalCount; index < historicalCount + 5; index += 1) {
            await act(async () => {
                await storage.getState().applyMessages(session.id, [makeMessage(index, 'Unrelated arrival')]);
            });
        }
        expect(historicalCommits).toBe(0);
        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                storage.getState().applyMessages(session.id, [chunk(`Streaming answer ${index}`, index + 2)]);
            });
        }
        expect(historicalCommits).toBe(0);
        const streamingActions = screen.tree.root.findAllByType(CommittedMessageActions)
            .find(node => node.props.message.localId === 'stream-segment');
        expect(streamingActions?.props.copyText).toBe('Streaming answer 4');
    });
});
