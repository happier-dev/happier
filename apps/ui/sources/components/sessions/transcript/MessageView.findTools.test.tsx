import * as React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@happier-dev/session-core/messages';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';
import { createSessionFixture, createSessionMessagesFixture, createTestSessionTranscriptSource, makeToolCall, renderScreen, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TranscriptFindProvider } from './find/TranscriptFindContext';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { useSessionTranscriptSource } from './source/SessionTranscriptSourceContext';
import { buildChatListItems } from '../chatListItems';
import type { TranscriptFindCorpus } from './find/useTranscriptFind';
import type { ChatTranscriptListItem } from './chatListTypes';
import type { TranscriptJumpTarget } from './viewport/jump/transcriptJumpTargetTypes';

installMessageViewCommonModuleMocks();
installDisconnectedServerSocketBoundary();
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
// Legend is the native recycler boundary; child projection, units and content remain real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original }).module;
});
await loadSyncSingletonForTests();
const { getStorage, useSessionPendingMessages } = await import('@/sync/domains/state/storage');
const { createTranscriptFindModel } = await import('./find/useTranscriptFind');
const { MessageView } = await import('./MessageView');
const { ToolCallsGroupUnitToolRowWithSessionCommon } = await import('./toolCalls/units/ToolCallsGroupUnitToolRow');
const { ToolCallsGroupViewWithSessionCommon } = await import('./turns/toolCalls/ToolCallsGroupView');
const { createTranscriptSessionCommonPropsFixture } = await import('./toolCalls/units/toolCallsGroupUnitsTestFixtures');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { PendingMessagesTranscriptBlock } = await import('../pending/PendingMessagesTranscriptBlock');
const { TranscriptFindSurface } = await import('./find/TranscriptFindSurface');
const { revealTranscriptFindMatch } = await import('./find/revealTranscriptFindMatch');
const { ChainTranscriptList } = await import('./ChainTranscriptList');
const { TranscriptFindMessageProvider } = await import('./find/TranscriptFindContext');

let environment: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
beforeEach(async () => { environment = await restoreServerAccountForTest({ serverUrl: 'http://find-tools.test' }); });
afterEach(async () => { standardCleanup(); await environment.dispose(); });

describe('MessageView tool Find identity', () => {
    it('preserves stable server routes through real plain and structured child tool units', async () => {
        getStorage().setState(state => ({ settings: { ...state.settings,
            transcriptGroupingMode: 'turns', transcriptGroupToolCalls: true, transcriptShowToolCalls: true,
            transcriptTurnToolCallsGroupStrategy: 'all_tools_in_turn',
            toolViewTimelineChromeMode: 'activity_feed', transcriptToolCallsCollapsedPreviewCount: 2,
        } }));
        const messages: ToolCallMessage[] = [
            { kind: 'tool-call', id: 'child-plain', realID: 'persisted-child-plain', localId: null, seq: 1, createdAt: 1,
                tool: makeToolCall({ id: 'native-child-plain', name: 'Bash', state: 'completed',
                    input: { command: 'pwd' }, result: '/workspace' }), children: [] },
            { kind: 'tool-call', id: 'child-structured', realID: 'persisted-child-structured', localId: null, seq: 2, createdAt: 2,
                tool: makeToolCall({ id: 'native-child-structured', name: 'Bash', state: 'completed',
                    input: { command: 'review' }, result: 'Reviewed' }), children: [],
                meta: { happier: { kind: 'review_findings.v1', payload: { findings: [] } } } },
        ];
        const source = createTestSessionTranscriptSource({ sessionId: 'child-routes', messages });
        const screen = await renderWithSessionTranscriptSource(<ChainTranscriptList sessionId="child-routes"
            datasetKey="child-route-dataset" messages={messages} metadata={null}
            interaction={{ canSendMessages: true, canApprovePermissions: true }} />, source);
        try {
            const units = screen.findAllByType(ToolCallsGroupUnitToolRowWithSessionCommon);
            expect(units).toHaveLength(2);
            expect(units.map(unit => unit.props.messageRouteId)).toEqual([
                'server:persisted-child-plain', 'server:persisted-child-structured',
            ]);
            // Both plain chrome and structured MessageView consume the same stable route,
            // rather than silently falling back to their native tool id or undefined context.
            const identities = screen.findAllByType(TranscriptFindMessageProvider)
                .filter(node => messages.some(message => message.id === node.props.messageId));
            expect(identities.map(node => [node.props.messageId, node.props.routeMessageId])).toEqual([
                ['child-plain', 'server:persisted-child-plain'],
                ['child-structured', 'server:persisted-child-structured'],
            ]);
        } finally { await screen.unmount(); }
    });

    it('counts only landable transcript rows through pending crossover and reveals every counted tool mark', async () => {
        const sessionId = 'find-pending-crossover';
        const store = getStorage();
        store.getState().applySessions([createSessionFixture({ id: sessionId })]);
        store.setState(state => ({ settings: { ...state.settings, toolViewTimelineChromeMode: 'activity_feed' } }));
        const messages: Message[] = [
            { kind: 'user-text', id: 'queued-twin', localId: 'queued-input', seq: 1, createdAt: 1, text: 'riverglass queued' },
            { kind: 'user-text', id: 'normal', localId: null, seq: 2, createdAt: 2, text: 'riverglass journal' },
            { kind: 'tool-call', id: 'read', realID: 'persisted-read', localId: null, seq: 3, createdAt: 3,
                tool: makeToolCall({ id: 'read-call', name: 'Read', state: 'completed',
                    input: { file_path: '/tmp/riverglass.ts' }, result: '1\triverglass field notes' }), children: [] },
        ];
        const byId = Object.fromEntries(messages.map(message => [message.id, message]));
        store.setState(state => ({ sessionMessages: { ...state.sessionMessages, [sessionId]: createSessionMessagesFixture({
            messageIdsOldestFirst: messages.map(message => message.id), messagesById: byId, isLoaded: true,
        }) } }));
        store.getState().applyPendingMessages(sessionId, [{
            id: 'pending-row', localId: 'queued-input', source: 'server_pending',
            pendingDeliveryStatus: 'server_delivering', createdAt: 1, updatedAt: 1, text: 'riverglass queued', rawRecord: {},
        }]);
        let corpus: TranscriptFindCorpus = { messages: [], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
        let items: readonly ChatTranscriptListItem[] = [];
        let expandGroup = (_expanded: boolean) => {};
        const landed: TranscriptJumpTarget[] = [];
        const model = createTranscriptFindModel({
            readCorpus: () => corpus, loadPage: null,
            // Physical viewport movement is the external boundary. The app source, pending
            // projection, matcher, group reveal, tool body and rendered mark remain real.
            jumpToTarget: async target => ({ status: 'scrolled', target }),
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items, setToolCallsGroupExpanded: value => expandGroup(value.expanded), setThinkingExpanded() {},
                waitForVisualUpdate: async () => {}, readClearancePx: () => 0,
                jumpToTarget: async target => { landed.push(target); return { status: 'scrolled', target }; },
            }, context),
        });
        const publishCorpus = (next: TranscriptFindCorpus) => { corpus = next; };
        const viewportRef = React.createRef<React.ElementRef<typeof View>>();
        const measureMessage = () => null;
        function SessionRows() {
            const source = useSessionTranscriptSource();
            const ids = source.useMessageIdsOldestFirst();
            const messagesById = source.useMessagesById();
            const pending = useSessionPendingMessages(sessionId);
            const [expanded, setExpanded] = React.useState(false);
            expandGroup = setExpanded;
            const projected = React.useMemo(() => buildChatListItems({
                messageIdsOldestFirst: ids, messagesById, pendingMessages: pending.messages,
                discardedMessages: pending.discarded, groupConsecutiveToolCalls: true,
            }), [ids, messagesById, pending]);
            items = projected;
            const common = createTranscriptSessionCommonPropsFixture({ toolChromeCommon: { toolViewTimelineChromeMode: 'activity_feed' } });
            return <TranscriptFindSurface model={model} source={source} sessionId={sessionId} serverId={null}
                viewportRef={viewportRef} loadedMessages={[]} items={projected}
                publishCorpus={publishCorpus} measureMessage={measureMessage} contentHeight={0}>
                {projected.map(item => item.kind === 'message'
                    ? <MessageView key={item.id} message={messagesById[item.messageId]} metadata={null} sessionId={sessionId} />
                    : item.kind === 'tool-calls-group'
                        ? <ToolCallsGroupViewWithSessionCommon key={item.id} {...common} id={item.id} status="completed"
                            toolMessages={item.toolMessageIds.map(id => messagesById[id]).filter((message): message is ToolCallMessage => message.kind === 'tool-call')}
                            metadata={null} sessionId={sessionId} expanded={expanded} setExpanded={setExpanded}
                            interaction={{ canSendMessages: true, canApprovePermissions: true }} />
                        : item.kind === 'pending-queue' ? <PendingMessagesTranscriptBlock key={item.id} sessionId={sessionId}
                            pendingMessages={item.pendingMessages} discardedMessages={item.discardedMessages} /> : null)}
            </TranscriptFindSurface>;
        }
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={sessionId}><SessionRows /></AppSessionTranscriptSourceProvider>);
        try {
            await act(async () => { model.setQuery('riverglass'); await model.settled(); });
            expect(items.some(item => item.kind === 'pending-queue')).toBe(true);
            expect(model.status).toMatchObject({ current: 1, total: 3 });
            expect(corpus.messages.map(message => message.id)).toEqual(['normal', 'read']);
            for (let index = 0; index < 3; index += 1) {
                if (index > 0) await act(async () => { model.step(1); await model.settled(); });
                const marks = screen.findAllHostsByTestId('find-match-current');
                expect(marks.length).toBeGreaterThan(0);
                expect(marks.map(mark => mark.children.join('')).join('')).toBe('riverglass');
            }
            expect(new Set(landed.map(target => target.kind === 'route-message-id' ? target.routeMessageId : null)))
                .toEqual(new Set(messages.slice(1).map(buildMessageRouteId)));
            await act(async () => { store.getState().applyPendingMessages(sessionId, []); await model.settled(); });
            expect(model.status).toMatchObject({ total: 4 });
            expect(corpus.messages.map(message => message.id)).toEqual(['queued-twin', 'normal', 'read']);
            await act(async () => { model.setQuery('riverglass queued'); await model.settled(); });
            expect(model.status).toMatchObject({ current: 1, total: 1 });
            expect(screen.findAllHostsByTestId('find-match-current').map(mark => mark.children.join('')).join('')).toBe('riverglass queued');
        } finally { await screen.unmount(); model.dispose(); }
    });

    it.each([
        ['cards', 'message'], ['activity_feed', 'message'],
        ['cards', 'unit'], ['activity_feed', 'unit'], ['activity_feed', 'group'], ['cards', 'group'],
    ] as const)('draws counted Read and Diff body matches through %s %s rows using the original message identity', async (chrome, rowKind) => {
        getStorage().setState(state => ({ settings: { ...state.settings, toolViewTimelineChromeMode: chrome } }));
        // Claude's numbered plain-string Read result and an Edit diff are distinct from the
        // predecessor's one-line file.content Read and synthetic Diff input.files payloads.
        const readBody = Array.from({ length: 32 }, (_, index) => `${index + 1}\t${index === 14
            ? '// must not remount the modal' : `const line${index + 1} = ${index + 1};`}`).join('\n');
        const oldText = Array.from({ length: 32 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
        const newText = oldText + '\n// must not remount the modal';
        const messages: ToolCallMessage[] = [
            { kind: 'tool-call', id: 'internal-read', realID: 'persisted-read', localId: null, seq: 1, createdAt: 1,
                tool: makeToolCall({ id: 'read-call', name: 'Read', state: 'completed', input: { file_path: '/tmp/a.ts' },
                    result: readBody }), children: [] },
            { kind: 'tool-call', id: 'internal-diff', realID: 'persisted-diff', localId: null, seq: 2, createdAt: 2,
                tool: makeToolCall({ id: 'diff-call', name: 'Edit', state: 'completed', input: { file_path: '/tmp/a.ts',
                    old_string: oldText, new_string: newText }, result: {} }), children: [] },
        ];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {},
        });
        model.setQuery('must not remount the modal');
        await model.settled();
        expect(model.status).toMatchObject({ current: 1, total: 2 });
        const source = createTestSessionTranscriptSource({ messages });
        const common = createTranscriptSessionCommonPropsFixture({ toolChromeCommon: { toolViewTimelineChromeMode: chrome } });
        const interaction = { canSendMessages: true, canApprovePermissions: true } as const;
        const screen = await renderWithSessionTranscriptSource(<TranscriptFindProvider store={model.rowStore}>
            {messages.map(message => <View key={message.id} testID={`find-tool:${message.id}`}>
                {rowKind === 'message' ? <MessageView message={message} metadata={null} sessionId="s1" />
                    : rowKind === 'unit' ? <ToolCallsGroupUnitToolRowWithSessionCommon {...common}
                        messageRouteId={buildMessageRouteId(message)}
                        message={message} metadata={null} sessionId="s1" groupId="tools" expanded interaction={interaction} />
                    : <ToolCallsGroupViewWithSessionCommon {...common} id="tools" status="completed"
                        toolMessages={[message]} metadata={null} sessionId="s1" expanded setExpanded={() => {}}
                        interaction={interaction} />}
            </View>)}
        </TranscriptFindProvider>, source);
        const currentText = (messageId: string) => screen.findHostByTestId(`find-tool:${messageId}`)!
            .findAll(node => typeof node.type === 'string' && node.props.testID === 'find-match-current')
            .map(node => node.children.join('')).join('');
        expect(currentText('internal-read')).toBe('must not remount the modal');
        expect(currentText('internal-diff')).toBe('');
        await act(async () => { model.step(1); await model.settled(); });
        expect(currentText('internal-read')).toBe('');
        expect(currentText('internal-diff')).toBe('must not remount the modal');
        await act(() => model.close());
        expect(currentText('internal-read')).toBe('');
        expect(currentText('internal-diff')).toBe('');
        await screen.unmount();
        model.dispose();
    });
});
