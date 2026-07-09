/**
 * Identity-stability contract for the transcript item renderer.
 *
 * FlashList view holders bail out of re-rendering only when `renderItem` keeps its
 * identity (ViewHolder memo compares it with ===). ChatList re-renders on every
 * transcript apply, passing a fresh `props` object literal whose FIELDS are stable;
 * the renderer must derive its identity from the fields it actually uses, not from
 * the containing object.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useTranscriptItemRenderer, type TranscriptItemRendererDeps } from './useTranscriptRowHost';

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createRendererProps(overrides?: Partial<Record<string, unknown>>): TranscriptItemRendererDeps['props'] {
    return {
        sessionId: 's1',
        metadata: null,
        interaction: {
            canSendMessages: true,
            canApprovePermissions: true,
        },
        approvalRequests: [],
        messagePins: [],
        onToggleMessagePin: vi.fn(),
        onEditPendingMessage: vi.fn(),
        forkCommon: { forkNoticesByMessageId: {} },
        messageDisplayCommon: {},
        toolChromeCommon: {},
        rollbackActionsByMessageId: {},
        rollbackRanges: [],
        messagesById: {},
        activeThinkingMessageId: null,
        forkedTranscriptEnabled: false,
        ...overrides,
    } as unknown as TranscriptItemRendererDeps['props'];
}

function createRendererDeps(props: TranscriptItemRendererDeps['props']): TranscriptItemRendererDeps {
    const items: readonly never[] = [];
    return {
        buildRowShellSignature: vi.fn(() => ({ kind: 'message' } as never)),
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        getMessageById: vi.fn(() => null),
        getMessageOrigin: undefined,
        getMessageRevisionById: vi.fn(() => 1),
        handleRowLayoutMutation: vi.fn(),
        handleRowShellMeasured: vi.fn(),
        itemsRef: createRef(items),
        listDataRef: createRef(items),
        listOrientation: 'top-down' as never,
        measurementReconciler: {} as never,
        props,
        resolveCreatedAtForMessageId: vi.fn(() => null),
        resolveKindForMessageId: vi.fn(() => null),
        resolveRollbackActionForMessage: vi.fn(() => null),
        resolveThinkingExpanded: vi.fn(() => false),
        resolveToolCallMessagesForIds: vi.fn(() => []),
        setThinkingExpanded: vi.fn(),
        setToolCallsGroupExpanded: vi.fn(),
        toolTimelineChromeMode: 'cards',
        toolRouteCommonRef: createRef(undefined as never),
    };
}

describe('useTranscriptItemRenderer identity stability', () => {
    it('keeps renderItem identity when a fresh props object carries unchanged fields', async () => {
        const stableFieldValues = createRendererProps();
        const baseDeps = createRendererDeps(stableFieldValues);
        const hook = await renderHook(
            ({ props }: { props: TranscriptItemRendererDeps['props'] }) =>
                useTranscriptItemRenderer({ ...baseDeps, props }),
            { initialProps: { props: stableFieldValues } },
        );

        const first = hook.getCurrent().renderItem;
        // Fresh object literal, identical field values/identities — the ChatList re-render shape.
        await hook.rerender({ props: { ...stableFieldValues } as TranscriptItemRendererDeps['props'] });
        const second = hook.getCurrent().renderItem;

        expect(second).toBe(first);
    });

    it('changes renderItem identity when a used field actually changes', async () => {
        const initial = createRendererProps();
        const baseDeps = createRendererDeps(initial);
        const hook = await renderHook(
            ({ props }: { props: TranscriptItemRendererDeps['props'] }) =>
                useTranscriptItemRenderer({ ...baseDeps, props }),
            { initialProps: { props: initial } },
        );

        const first = hook.getCurrent().renderItem;
        await hook.rerender({
            props: { ...initial, onEditPendingMessage: vi.fn() } as TranscriptItemRendererDeps['props'],
        });
        const second = hook.getCurrent().renderItem;

        expect(second).not.toBe(first);
    });
});
