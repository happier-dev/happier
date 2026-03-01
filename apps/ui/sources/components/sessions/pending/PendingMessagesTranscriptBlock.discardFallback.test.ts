import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { PendingMessagesTranscriptBlock } from './PendingMessagesTranscriptBlock';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: (props: any) => {
        const children = Array.isArray(props.messages)
            ? props.messages.map((m: any, index: number) =>
                props.renderItem({
                    message: m,
                    index,
                    isDragging: false,
                    renderDragHandle: ({ children: handleChildren }: any) => handleChildren,
                }),
            )
            : null;
        return React.createElement('PendingMessagesDragReorderList', props, children);
    },
}));

const sendMessage = vi.fn();
const deletePendingMessage = vi.fn();
const discardPendingMessage = vi.fn();
const sessionAbort = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => null,
    useSetting: () => undefined,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
        deletePendingMessage: (...args: any[]) => deletePendingMessage(...args),
        discardPendingMessage: (...args: any[]) => discardPendingMessage(...args),
        updatePendingMessage: vi.fn(),
        restoreDiscardedPendingMessage: vi.fn(),
        deleteDiscardedPendingMessage: vi.fn(),
        fetchPendingMessages: vi.fn(),
        reorderPendingMessages: vi.fn(),
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAbort: (...args: any[]) => sessionAbort(...args),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: any[]) => modalConfirm(...args),
        alert: (...args: any[]) => modalAlert(...args),
        prompt: vi.fn(),
    },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                surfacePressedOverlay: '#eee',
                input: { background: '#fff' },
                button: { secondary: { background: '#eee', tint: '#000' } },
                box: { error: { background: '#fdd', text: '#a00' } },
                textDestructive: '#a00',
                textLink: '#00f',
                userMessageBackground: '#eee',
                userMessageText: '#000',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => (typeof input === 'function' ? input({ colors: {} }) : input),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({
                open: props.open,
                toggle: () => props.onOpenChange(!props.open),
                openMenu: () => props.onOpenChange(true),
                closeMenu: () => props.onOpenChange(false),
                selectedItem: null,
            })
            : props.trigger ?? null;
        return React.createElement('DropdownMenu', { open: props.open }, trigger);
    },
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        canScrollY: false,
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

describe('PendingMessagesTranscriptBlock discard fallback', () => {
    beforeEach(() => {
        sendMessage.mockReset();
        deletePendingMessage.mockReset();
        discardPendingMessage.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
    });

    function findPressableByTestId(tree: renderer.ReactTestRenderer, testID: string): ReactTestInstance | undefined {
        return tree.root.findAllByType('Pressable').find((node) => node.props.testID === testID);
    }

    function findNodeByTestId(tree: renderer.ReactTestRenderer, testID: string): ReactTestInstance | undefined {
        return tree.root.findAll((node) => (node.props as any)?.testID === testID)[0];
    }

    async function hoverPendingMessageRow(tree: renderer.ReactTestRenderer, messageId: string) {
        const row = findNodeByTestId(tree, `pendingMessages.row:${messageId}`);
        expect(row).toBeTruthy();
        await act(async () => {
            row!.props.onPointerEnter?.();
        });
    }

    it('falls back to discarding when delete fails after send', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockRejectedValueOnce(new Error('delete failed'));
        discardPendingMessage.mockResolvedValueOnce(undefined);

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
                tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                    sessionId: 's1',
                    pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                    discardedMessages: [],
                }));
            });

        await hoverPendingMessageRow(tree!, 'p1');

        const sendNow = findPressableByTestId(tree!, 'pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await act(async () => {
            await sendNow!.props.onPress();
        });

        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
        expect(discardPendingMessage).toHaveBeenCalledTimes(1);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });
});
