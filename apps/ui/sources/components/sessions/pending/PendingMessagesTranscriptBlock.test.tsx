import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPendingMessagesCommonModuleMocks } from './pendingMessagesTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function loadPendingMessagesTranscriptBlock() {
    const mod = await import('./PendingMessagesTranscriptBlock');
    return mod.PendingMessagesTranscriptBlock;
}

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

const sendPendingMessageNow = vi.fn();
const deletePendingMessage = vi.fn();
const discardPendingMessage = vi.fn();
const sessionAbort = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();
const reorderPendingMessages = vi.fn();

let sessionValue: any = null;

installPendingMessagesCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit');
        return createPartialStorageModuleMock(importOriginal, {
            useSession: () => sessionValue,
            useSetting: () => undefined,
            storage: { getState: () => ({}) },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: (...args: any[]) => modalConfirm(...args),
                alert: (...args: any[]) => modalAlert(...args),
                prompt: vi.fn(),
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                View: 'View',
                Text: 'Text',
                Pressable: 'Pressable',
                ScrollView: 'ScrollView',
                ActivityIndicator: 'ActivityIndicator',
                Platform: {
                    OS: 'web',
                    select: (value: any) => value?.web ?? value?.default,
                },
            }
        );
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
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
        });
    },
    icons: async () => ({
        Ionicons: 'Ionicons',
    }),
});

vi.mock('@/sync/sync', () => ({
    sync: {
        sendPendingMessageNow: (...args: any[]) => sendPendingMessageNow(...args),
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
        vi.resetModules();
        sendPendingMessageNow.mockReset();
        deletePendingMessage.mockReset();
        discardPendingMessage.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
        reorderPendingMessages.mockReset();
        sessionValue = null;
    });

    function flattenStyle(style: any): Record<string, any> {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, any>);
        }
        if (typeof style === 'object') return style as Record<string, any>;
        return {};
    }

    async function hoverPendingMessageRow(screen: Awaited<ReturnType<typeof renderScreen>>, messageId: string) {
        const row = screen.findByTestId(`pendingMessages.row:${messageId}`);
        expect(row).toBeTruthy();
        await act(async () => {
            invokeTestInstanceHandler(row, 'onPointerEnter', undefined, `pendingMessages.row:${messageId}`);
        });
    }

    async function hoverDiscardedMessageRow(screen: Awaited<ReturnType<typeof renderScreen>>, messageId: string) {
        const row = screen.findByTestId(`pendingMessages.discarded.row:${messageId}`);
        expect(row).toBeTruthy();
        await act(async () => {
            invokeTestInstanceHandler(row, 'onPointerEnter', undefined, `pendingMessages.discarded.row:${messageId}`);
        });
    }

    it('aborts+send+delete in order when send-now is pressed', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendPendingMessageNow.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        // Web-only: action icons show on hover.
        await hoverPendingMessageRow(screen, 'p1');

        const sendNow = screen.findByTestId('pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(sessionAbort).toHaveBeenCalledTimes(1);
        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({ localId: 'p1' }));
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);

        const abortOrder = sessionAbort.mock.invocationCallOrder[0]!;
        const sendOrder = sendPendingMessageNow.mock.invocationCallOrder[0]!;
        const deleteOrder = deletePendingMessage.mock.invocationCallOrder[0]!;

        expect(abortOrder).toBeLessThan(sendOrder);
        expect(sendOrder).toBeLessThan(deleteOrder);
    });

    it('renders a per-message pending affordance label', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const affordance = screen.findByTestId('pendingMessages.pendingAffordance:p1');
        expect(affordance).toBeTruthy();
        expect(flattenStyle(affordance!.props.style).position).toBe('absolute');
    });

    it('renders a block header label that reads as a section header', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'world', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        expect(screen.findByTestId('pendingMessages.headerLabel')).toBeTruthy();
    });

    it('wires reorder persistence via PendingMessagesDragReorderList', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        const list = screen.findByType('PendingMessagesDragReorderList');
        await act(async () => {
            invokeTestInstanceHandler(list, 'onReorderIds', ['p2', 'p1'], 'PendingMessagesDragReorderList');
        });

        expect(reorderPendingMessages).toHaveBeenCalledTimes(1);
        expect(reorderPendingMessages).toHaveBeenCalledWith('s1', ['p2', 'p1']);
    });

    it('does not show per-message action icons until hover on web', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const overlay = screen.findByTestId('pendingMessages.actionsOverlay:p1');
        expect(overlay).toBeTruthy();
        expect(flattenStyle(overlay!.props.style).opacity).toBe(0);
        expect(overlay!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlay!.props.style).pointerEvents).toBe('none');

        await hoverPendingMessageRow(screen, 'p1');

        const overlayAfterHover = screen.findByTestId('pendingMessages.actionsOverlay:p1');
        expect(overlayAfterHover).toBeTruthy();
        expect(flattenStyle(overlayAfterHover!.props.style).opacity).toBe(1);
        expect(overlayAfterHover!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlayAfterHover!.props.style).pointerEvents).toBe('auto');
    });

	    it('offers steer-now while a steer-capable session is thinking and does not abort the turn', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        sessionValue = {
	            thinking: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockResolvedValueOnce(undefined);
        deletePendingMessage.mockResolvedValueOnce(undefined);

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        const steerNow = screen.findByTestId('pendingMessages.steerNow:p1');
        expect(steerNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.steerNow:p1');

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
	        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({ localId: 'p1' }));
	        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
	    });

	    it('does not offer steer-now or send-now for pending rows that failed to decrypt', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        sessionValue = {
	            thinking: true,
	            presence: 'online',
	            agentStateVersion: 1,
	            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
	        };

	        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
	                sessionId: 's1',
	                pendingMessages: [{
	                    id: 'p1',
	                    text: '',
	                    displayText: 'Failed to decrypt',
	                    pendingDecryptFailure: { kind: 'decrypt_failed' },
	                    createdAt: 0,
	                    updatedAt: 0,
	                    localId: 'p1',
	                    rawRecord: {},
	                }],
	                discardedMessages: [],
	            }));

	        await hoverPendingMessageRow(screen, 'p1');

	        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
	        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
	        expect(screen.findByTestId('pendingMessages.edit:p1')).toBeTruthy();
	        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();
	    });

	    it('renders with app theme shape (no secondary background / no danger box)', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        await expect((async () => {
            await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                        sessionId: 's1',
                        pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                        discardedMessages: [],
                    }));
            })()).resolves.toBeUndefined();
    });

    it('does not delete or close when send fails', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendPendingMessageNow.mockRejectedValueOnce(new Error('send failed'));

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        const sendNow = screen.findByTestId('pendingMessages.sendNow:p1');
        expect(sendNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(1);
    });

    it('uses a smaller default max-height for the pending queue block', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const scroll = screen.findByType('ScrollView');
        expect(scroll.props.style?.maxHeight).toBe(64);
    });

    it('does not show discarded action icons until hover on web', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [],
                discardedMessages: [
                    { id: 'd1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason: 'manual', localId: 'd1', rawRecord: {} },
                ],
            }));

        const overlay = screen.findByTestId('pendingMessages.discarded.actionsOverlay:d1');
        expect(overlay).toBeTruthy();
        expect(flattenStyle(overlay!.props.style).opacity).toBe(0);
        expect(overlay!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlay!.props.style).pointerEvents).toBe('none');

        await hoverDiscardedMessageRow(screen, 'd1');

        const overlayAfterHover = screen.findByTestId('pendingMessages.discarded.actionsOverlay:d1');
        expect(overlayAfterHover).toBeTruthy();
        expect(flattenStyle(overlayAfterHover!.props.style).opacity).toBe(1);
        expect(overlayAfterHover!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlayAfterHover!.props.style).pointerEvents).toBe('auto');
    });

    it('hides the next pending chip while hovering a message on web', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        const chipP2Before = screen.findByTestId('pendingMessages.pendingAffordance:p2');
        expect(chipP2Before).toBeTruthy();
        expect(flattenStyle(chipP2Before!.props.style).opacity).not.toBe(0);

        await hoverPendingMessageRow(screen, 'p1');

        const chipP2After = screen.findByTestId('pendingMessages.pendingAffordance:p2');
        expect(chipP2After).toBeTruthy();
        expect(flattenStyle(chipP2After!.props.style).opacity).toBe(0);
    });

    it('does not render per-message up/down chevron actions', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p2');
        expect(screen.findByTestId('pendingMessages.moveUp:p2')).toBeFalsy();
        expect(screen.findByTestId('pendingMessages.moveDown:p1')).toBeFalsy();
    });

    it('renders reorder affordance without nested pressable action', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        const reorderHandle = screen.findByTestId('pendingMessages.reorder:p1');
        expect(reorderHandle).toBeTruthy();
        expect(reorderHandle!.type).not.toBe('Pressable');
        expect((reorderHandle!.props as any).pointerEvents).toBeUndefined();
        expect(flattenStyle((reorderHandle!.props as any).style).pointerEvents).toBe('none');
    });
});
