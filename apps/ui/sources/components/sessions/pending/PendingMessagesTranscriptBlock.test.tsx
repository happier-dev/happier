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
const reorderPendingMessages = vi.fn();

let sessionValue: any = null;

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionValue,
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
        reorderPendingMessages: (...args: any[]) => reorderPendingMessages(...args),
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
                surfaceHighest: '#eee',
                surface: '#fff',
                surfacePressedOverlay: '#eee',
                input: { background: '#fff' },
                button: {
                    // Match app theme shape: secondary has tint but no background.
                    secondary: { tint: '#000' },
                },
                box: {
                    // Match app theme shape: error (not danger).
                    error: { background: '#fdd', text: '#a00' },
                },
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

describe('PendingMessagesTranscriptBlock', () => {
    beforeEach(() => {
        sendMessage.mockReset();
        deletePendingMessage.mockReset();
        discardPendingMessage.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
        reorderPendingMessages.mockReset();
        sessionValue = null;
    });

    function findPressableByTestId(tree: renderer.ReactTestRenderer, testID: string): ReactTestInstance | undefined {
        return tree.root.findAllByType('Pressable').find((node) => node.props.testID === testID);
    }

    function findNodeByTestId(tree: renderer.ReactTestRenderer, testID: string): ReactTestInstance | undefined {
        return tree.root.findAll((node) => (node.props as any)?.testID === testID)[0];
    }

    function flattenStyle(style: any): Record<string, any> {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, any>);
        }
        if (typeof style === 'object') return style as Record<string, any>;
        return {};
    }

    async function hoverPendingMessageRow(tree: renderer.ReactTestRenderer, messageId: string) {
        const row = findNodeByTestId(tree, `pendingMessages.row:${messageId}`);
        expect(row).toBeTruthy();
        await act(async () => {
            row!.props.onPointerEnter?.();
        });
    }

    async function hoverDiscardedMessageRow(tree: renderer.ReactTestRenderer, messageId: string) {
        const row = findNodeByTestId(tree, `pendingMessages.discarded.row:${messageId}`);
        expect(row).toBeTruthy();
        await act(async () => {
            row!.props.onPointerEnter?.();
        });
    }

    it('aborts+send+delete in order when send-now is pressed', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));
        });

        // Web-only: action icons show on hover.
        await hoverPendingMessageRow(tree!, 'p1');

        const sendNow = findPressableByTestId(tree!, 'pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await act(async () => {
            await sendNow!.props.onPress();
        });

        expect(sessionAbort).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);

        const abortOrder = sessionAbort.mock.invocationCallOrder[0]!;
        const sendOrder = sendMessage.mock.invocationCallOrder[0]!;
        const deleteOrder = deletePendingMessage.mock.invocationCallOrder[0]!;

        expect(abortOrder).toBeLessThan(sendOrder);
        expect(sendOrder).toBeLessThan(deleteOrder);
    });

    it('renders a per-message pending affordance label', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));
        });

        const affordance = findNodeByTestId(tree!, 'pendingMessages.pendingAffordance:p1');
        expect(affordance).toBeTruthy();
        expect(flattenStyle(affordance!.props.style).position).toBe('absolute');
    });

    it('renders a block header label that reads as a section header', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'world', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));
        });

        expect(findNodeByTestId(tree!, 'pendingMessages.headerLabel')).toBeTruthy();
    });

    it('wires reorder persistence via PendingMessagesDragReorderList', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));
        });

        const list = tree!.root.findByType('PendingMessagesDragReorderList');
        await act(async () => {
            list.props.onReorderIds(['p2', 'p1']);
        });

        expect(reorderPendingMessages).toHaveBeenCalledTimes(1);
        expect(reorderPendingMessages).toHaveBeenCalledWith('s1', ['p2', 'p1']);
    });

    it('does not show per-message action icons until hover on web', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));
        });

        const overlay = findNodeByTestId(tree!, 'pendingMessages.actionsOverlay:p1');
        expect(overlay).toBeTruthy();
        expect(flattenStyle(overlay!.props.style).opacity).toBe(0);
        expect(overlay!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlay!.props.style).pointerEvents).toBe('none');

        await hoverPendingMessageRow(tree!, 'p1');

        const overlayAfterHover = findNodeByTestId(tree!, 'pendingMessages.actionsOverlay:p1');
        expect(overlayAfterHover).toBeTruthy();
        expect(flattenStyle(overlayAfterHover!.props.style).opacity).toBe(1);
        expect(overlayAfterHover!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlayAfterHover!.props.style).pointerEvents).toBe('auto');
    });

    it('offers steer-now while a steer-capable session is thinking and does not abort the turn', async () => {
        sessionValue = {
            thinking: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        modalConfirm.mockResolvedValueOnce(true);
        sendMessage.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));
        });

        await hoverPendingMessageRow(tree!, 'p1');

        const steerNow = findPressableByTestId(tree!, 'pendingMessages.steerNow:p1');
        expect(steerNow).toBeTruthy();

        await act(async () => {
            await steerNow!.props.onPress();
        });

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
    });

    it('renders with app theme shape (no secondary background / no danger box)', async () => {
        await expect((async () => {
            await act(async () => {
                    renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                        sessionId: 's1',
                        pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                        discardedMessages: [],
                    }));
                });
            })()).resolves.toBeUndefined();
    });

    it('does not delete or close when send fails', async () => {
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendMessage.mockRejectedValueOnce(new Error('send failed'));

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

        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(1);
    });

    it('uses a smaller default max-height for the pending queue block', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));
        });

        const scroll = tree!.root.findByType('ScrollView');
        expect(scroll.props.style?.maxHeight).toBe(64);
    });

    it('does not show discarded action icons until hover on web', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [],
                discardedMessages: [
                    { id: 'd1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason: 'manual', localId: 'd1', rawRecord: {} },
                ],
            }));
        });

        const overlay = findNodeByTestId(tree!, 'pendingMessages.discarded.actionsOverlay:d1');
        expect(overlay).toBeTruthy();
        expect(flattenStyle(overlay!.props.style).opacity).toBe(0);
        expect(overlay!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlay!.props.style).pointerEvents).toBe('none');

        await hoverDiscardedMessageRow(tree!, 'd1');

        const overlayAfterHover = findNodeByTestId(tree!, 'pendingMessages.discarded.actionsOverlay:d1');
        expect(overlayAfterHover).toBeTruthy();
        expect(flattenStyle(overlayAfterHover!.props.style).opacity).toBe(1);
        expect(overlayAfterHover!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlayAfterHover!.props.style).pointerEvents).toBe('auto');
    });

    it('hides the next pending chip while hovering a message on web', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));
        });

        const chipP2Before = findNodeByTestId(tree!, 'pendingMessages.pendingAffordance:p2');
        expect(chipP2Before).toBeTruthy();
        expect(flattenStyle(chipP2Before!.props.style).opacity).not.toBe(0);

        await hoverPendingMessageRow(tree!, 'p1');

        const chipP2After = findNodeByTestId(tree!, 'pendingMessages.pendingAffordance:p2');
        expect(chipP2After).toBeTruthy();
        expect(flattenStyle(chipP2After!.props.style).opacity).toBe(0);
    });

    it('does not render per-message up/down chevron actions', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));
        });

        await hoverPendingMessageRow(tree!, 'p2');
        expect(findPressableByTestId(tree!, 'pendingMessages.moveUp:p2')).toBeFalsy();
        expect(findPressableByTestId(tree!, 'pendingMessages.moveDown:p1')).toBeFalsy();
    });

    it('renders reorder affordance without nested pressable action', async () => {
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));
        });

        await hoverPendingMessageRow(tree!, 'p1');

        const reorderHandle = tree!.root.findAllByType('View').find((node) => (node.props as any)?.testID === 'pendingMessages.reorder:p1');
        expect(reorderHandle).toBeTruthy();
        expect(findPressableByTestId(tree!, 'pendingMessages.reorder:p1')).toBeFalsy();
        expect((reorderHandle!.props as any).pointerEvents).toBeUndefined();
        expect(flattenStyle((reorderHandle!.props as any).style).pointerEvents).toBe('none');
    });
});
