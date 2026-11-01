/**
 * Identity-stability contract for the M8 transcript items pipeline.
 *
 * ChatList passes fresh deps object literals during normal renders. The pipeline
 * must keep stable callbacks and stable derived arrays when individual fields are
 * unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import type { Message } from '@happier-dev/session-core/messages';

import { createToolCallMessageFixture, renderHook, renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';
import { buildChatListItems, buildChatListItemsCached } from '@/components/sessions/chatListItems';
import { buildTranscriptTurnsCached } from '../turnGrouping/buildTranscriptTurns';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { TranscriptEventRow } = await import('../events/TranscriptEventRow');
const { useTranscriptItemsPipeline, useTranscriptToolAutoExpandEffect } = await import('./useTranscriptItemsPipeline');
const { AppSessionTranscriptSourceProvider } = await import('../source/appSessionTranscriptSource');

function Source(props: React.PropsWithChildren) {
    return <AppSessionTranscriptSourceProvider sessionId="s1" serverId={null}>{props.children}</AppSessionTranscriptSourceProvider>;
}

type ItemsPipelineDeps = Parameters<typeof useTranscriptItemsPipeline>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

const inactiveWindowState = {
    activatedAtMs: null,
    hasMoreNewer: null,
    hasMoreOlder: null,
    isWindowMode: false,
    newerCursor: null,
    olderCursor: null,
    targetSeq: null,
    windowId: null,
    windowMaxSeq: null,
    windowMinSeq: null,
};

function createStableMembers() {
    const items = [
        { id: 'm1', kind: 'message' as const, messageId: 'm1', seq: 1, createdAt: 1 },
        { id: 'm2', kind: 'message' as const, messageId: 'm2', seq: 2, createdAt: 2 },
    ];
    return {
        activeTargetWindowTargetRef: createRef(null),
        canonicalWindowedItemsRef: createRef(items),
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        getMessageById: vi.fn((messageId: string) => ({
            id: messageId,
            kind: 'user-text' as const,
            seq: messageId === 'm2' ? 2 : 1,
            localId: null,
            createdAt: 1,
            text: 'Prompt',
        })),
        getMessageRevisionById: vi.fn(() => 1),
        items,
        itemsRef: createRef(items),
        listDataRef: createRef(items),
        messagesById: {},
        preDecompositionItemsRef: createRef(items),
        renderWindowIndexMapRef: createRef(null),
        resolveThinkingExpanded: vi.fn(() => false),
        targetWindowActiveRef: createRef(false),
        resolveActionDraftFieldOptions: () => [],
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): ItemsPipelineDeps {
    return {
        ...members,
        activeThinkingMessageId: null,
        committedMessagesCount: 2,
        forkMessageMetadataById: null,
        groupingMode: 'linear',
        isLoaded: true,
        latestCommittedActivityKey: 'm2',
        listOrientation: 'standard',
        rowFontScaleKey: 'default',
        rowWidthBucket: 'w',
        sessionActive: true,
        sessionId: 's1',
        sessionThinking: false,
        targetWindowState: inactiveWindowState,
        transcriptToolCallsCollapsedPreviewCountSetting: 3,
    } satisfies ItemsPipelineDeps;
}

describe('useTranscriptItemsPipeline identity stability', () => {
    it.each(['full', 'cached-rebuild', 'cached-append', 'turns'] as const)(
        'idleCompaction.F2 keeps one mounted lifecycle row and quiet neighbors through %s projection',
        async (path) => {
            for (const terminalPhase of ['completed', 'failed', 'cancelled'] as const) {
                const lifecycleId = `idle-${terminalPhase}`;
                const beforeMessage: Message = { kind: 'user-text', id: 'before', localId: null, createdAt: 1, seq: 1, text: 'Before' };
                const afterMessage: Message = { kind: 'user-text', id: 'after', localId: null, createdAt: 3, seq: 3, text: 'After' };
                const started: Message = { kind: 'agent-event', id: 'started', localId: null, createdAt: 2, seq: 2,
                    event: { type: 'context-compaction', lifecycleId, trigger: 'idle', phase: 'started' } };
                const terminal: Message = { kind: 'agent-event', id: terminalPhase, localId: null, createdAt: 4, seq: 4,
                    event: { type: 'context-compaction', lifecycleId, trigger: 'idle', phase: terminalPhase } };
                const messagesById = Object.fromEntries([beforeMessage, started, afterMessage, terminal].map((message) => [message.id, message]));
                const initialIds = ['before', 'started', 'after'];
                const finalIds = [...initialIds, terminalPhase];
                const initial = buildChatListItemsCached({ cache: null, messageIdsOldestFirst: initialIds, messagesById, pendingMessages: [] });
                const project = (ids: string[], next: boolean) => {
                    if (path === 'turns') {
                        return buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst: ids, messagesById,
                            groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools' }).turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn }));
                    }
                    if (path === 'full') return buildChatListItems({ messageIdsOldestFirst: ids, messagesById, pendingMessages: [] });
                    return buildChatListItemsCached({ cache: next && path === 'cached-append' ? initial.cache : null,
                        messageIdsOldestFirst: ids, messagesById, pendingMessages: [] }).items;
                };
                const members = createStableMembers();
                const counts = new Map<string, { mounts: number; commits: number; unmounts: number }>();
                const Row = React.memo(function Row({ message }: { message: Message }) {
                    const identity = message.kind === 'agent-event' ? lifecycleId : message.id;
                    const count = counts.get(identity) ?? { mounts: 0, commits: 0, unmounts: 0 };
                    counts.set(identity, count);
                    React.useLayoutEffect(() => { count.commits += 1; });
                    React.useEffect(() => { count.mounts += 1; return () => { count.unmounts += 1; }; }, [count]);
                    return message.kind === 'agent-event' ? <TranscriptEventRow event={message.event} /> : null;
                });
                const { module: { LegendList } } = createCapturingLegendListMock({ memoizeItems: true });
                let advance = () => {};
                let visibleIds: string[] = [];
                function List() {
                    const [next, setNext] = React.useState(false);
                    advance = () => setNext(true);
                    const items = React.useMemo(() => project(next ? finalIds : initialIds, next), [next]);
                    const pipeline = useTranscriptItemsPipeline({ ...buildDeps(members), items, messagesById,
                        groupingMode: path === 'turns' ? 'turns' : 'linear', committedMessagesCount: next ? 4 : 3,
                        getMessageById: (id) => messagesById[id] ?? null });
                    const renderItem = React.useCallback(({ item }: { item: (typeof pipeline.listData)[number] }) => item.kind === 'message'
                        ? <Row message={messagesById[item.messageId]!} /> : null, []);
                    visibleIds = pipeline.listData.map(pipeline.keyExtractor);
                    return <LegendList data={pipeline.listData} keyExtractor={pipeline.keyExtractor}
                        renderItem={renderItem} />;
                }
                const screen = await renderScreen(<Source><List /></Source>);
                const originalIds = [...visibleIds];
                expect(new Set(originalIds).size).toBe(3);
                expect(originalIds).toContain('msg:before');
                expect(originalIds).toContain('msg:after');
                const mountedRow = screen.findByType(TranscriptEventRow);
                const beforeCounts = { ...counts.get('before')! };
                const afterCounts = { ...counts.get('after')! };
                await act(async () => { advance(); });
                expect(visibleIds).toHaveLength(3);
                expect(new Set(visibleIds)).toEqual(new Set(originalIds));
                expect(screen.findByType(TranscriptEventRow)).toBe(mountedRow);
                expect(screen.findByType(TranscriptEventRow).props.event.phase).toBe(terminalPhase);
                expect(counts.get(lifecycleId)).toEqual({ mounts: 1, commits: 2, unmounts: 0 });
                expect(counts.get('before')).toEqual(beforeCounts);
                expect(counts.get('after')).toEqual(afterCounts);
                await screen.unmount();
            }
        },
    );
    it.each(['linear', 'turns'])('hides previews in %s without dropping tools and reveals all rows locally', async (groupingMode) => {
        const messages = ['tool-1', 'tool-2'].map((id) => createToolCallMessageFixture({ id }));
        const deps = { ...buildDeps(createStableMembers()), groupingMode, showToolCalls: false,
            items: [{ kind: 'tool-calls-group' as const, id: 'tools', toolMessageIds: messages.map((m) => m.id), createdAt: 1 }],
            getMessageById: (id: string) => messages.find((m) => m.id === id) ?? null };
        const hook = await renderHook((value: typeof deps) => useTranscriptItemsPipeline(value), { initialProps: deps, wrapper: Source });
        expect(hook.getCurrent().decomposedItems.map((item) => item.kind)).toEqual(['tool-group-header', 'tool-group-footer']);
        expect(hook.getCurrent().decomposedItems[0]).toMatchObject({
            toolMessageIds: ['tool-1', 'tool-2'], hiddenCount: 2,
        });
        await hook.rerender({ ...deps, expandedToolCallsAnchorMessageIds: new Set(['tool-2']) });
        expect(hook.getCurrent().decomposedItems.map((item) => item.kind)).toEqual([
            'tool-group-header', 'tool-group-tool', 'tool-group-tool', 'tool-group-footer',
        ]);
        await hook.unmount();
    });

    it('does not auto-expand hidden tools in a short transcript', async () => {
        const expansions: unknown[] = [];
        const hook = await renderHook(() => useTranscriptToolAutoExpandEffect({
            showToolCalls: false,
            applyToolCallsGroupExpanded: (request) => { expansions.push(request); },
            expandedToolCallsAnchorMessageIds: new Set(), hasAutoExpandedToolCallsGroups: () => false,
            isScrollable: () => false, jumpToSeq: null, markAutoExpandedToolCallsGroups: () => {},
            maxTurnEntriesPerListItem: 3, sessionId: 's1', transcriptToolCallsCollapsedPreviewCountSetting: 0,
            preDecompositionItemsRef: { current: [{ kind: 'tool-calls-group', id: 'tools', toolMessageIds: ['tool-1', 'tool-2'], createdAt: 1 }] },
        }));
        expect(expansions).toEqual([]);
        await hook.unmount();
    });
    it('keeps derived arrays and item callbacks stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: ItemsPipelineDeps) => useTranscriptItemsPipeline(deps),
            { initialProps: buildDeps(members), wrapper: Source },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.decomposedItems).toBe(first.decomposedItems);
        expect(second.listData).toBe(first.listData);
        expect(second.keyExtractor).toBe(first.keyExtractor);
        expect(second.getItemType).toBe(first.getItemType);
        expect(second.resolveNearestSurvivingViewportAnchorIndex).toBe(first.resolveNearestSurvivingViewportAnchorIndex);
        expect(second.isViewportAnchorSeqLoaded).toBe(first.isViewportAnchorSeqLoaded);

        await hook.unmount();
    });
});
