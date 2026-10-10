/**
 * Identity-stability contract for the M8 transcript items pipeline.
 *
 * ChatList passes fresh deps object literals during normal renders. The pipeline
 * must keep stable callbacks and stable derived arrays when individual fields are
 * unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

import { createToolCallMessageFixture, renderHook } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { useTranscriptItemsPipeline, useTranscriptToolAutoExpandEffect } from './useTranscriptItemsPipeline';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

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
    it.each(['linear', 'turns'])('hides previews in %s without dropping tools and reveals all rows locally', async (groupingMode) => {
        const messages = ['tool-1', 'tool-2'].map((id) => createToolCallMessageFixture({ id }));
        const deps = { ...buildDeps(createStableMembers()), groupingMode, showToolCalls: false,
            items: [{ kind: 'tool-calls-group' as const, id: 'tools', toolMessageIds: messages.map((m) => m.id), createdAt: 1 }],
            getMessageById: (id: string) => messages.find((m) => m.id === id) ?? null };
        const hook = await renderHook((value: typeof deps) => useTranscriptItemsPipeline(value), { initialProps: deps });
        expect(hook.getCurrent().decomposedItems.map((item) => item.kind)).toEqual(['tool-group-header']);
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
            { initialProps: buildDeps(members) },
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
