import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
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
const dismissPendingDelivery = vi.fn();
const deleteDiscardedPendingMessage = vi.fn();
const markPendingDeliveryHandled = vi.fn();
const sendPendingDeliveryAsNew = vi.fn();
const sessionAbort = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();
const modalPrompt = vi.fn();
const reorderPendingMessages = vi.fn();
const executeDefaultAction = vi.fn();
const resolvePreferredServerIdForSessionId = vi.fn();
const serverFeaturesSnapshotState = vi.hoisted(() => ({
    current: { status: 'loading' } as any,
}));

let sessionValue: any = null;
let settingValues: Record<string, unknown> = {};

installPendingMessagesCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit');
        return createPartialStorageModuleMock(importOriginal, {
            useSession: () => sessionValue,
            useSetting: (key: string) => settingValues[key],
            storage: { getState: () => ({}) },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: (...args: any[]) => modalConfirm(...args),
                alert: (...args: any[]) => modalAlert(...args),
                prompt: (...args: any[]) => modalPrompt(...args),
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

const agentCatalogMocks = vi.hoisted(() => {
    const resolveAgentIdFromFlavor = (flavor: unknown) => {
        if (flavor === 'claude') return 'claude';
        if (flavor === 'codex') return 'codex';
        if (flavor === 'pi') return 'pi';
        return null;
    };
    const getAgentCore = (agentId: string) => ({
        id: agentId,
        permissions: {
            promptProtocol: agentId === 'codex' ? 'codexDecision' : 'claude',
        },
        sessionStorage: {
            direct: true,
            persisted: true,
        },
        model: {
            defaultMode: 'default',
            supportsSelection: false,
        },
        resume: {},
        runtimeInput: {
            inFlightSteerSupported: agentId === 'pi',
        },
    });
    return { getAgentCore, resolveAgentIdFromFlavor };
});

vi.mock('@/agents/registry/registryCore', () => ({
    AGENT_IDS: ['claude', 'codex', 'pi'],
    CANONICAL_AGENT_IDS: ['claude', 'codex', 'pi'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: agentCatalogMocks.getAgentCore,
    resolveAgentIdFromFlavor: agentCatalogMocks.resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata: (metadata: unknown) => {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
        return agentCatalogMocks.resolveAgentIdFromFlavor((metadata as { flavor?: unknown }).flavor);
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: agentCatalogMocks.getAgentCore,
    isAgentId: (agentId: unknown) => typeof agentId === 'string' && ['claude', 'codex', 'pi'].includes(agentId),
    resolveAgentIdFromFlavor: agentCatalogMocks.resolveAgentIdFromFlavor,
    buildWakeResumeExtras: ({ session }: { session?: { metadata?: Record<string, unknown> } | null }) => {
        const connectedServices = session?.metadata?.connectedServices;
        return connectedServices ? { connectedServices } : {};
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendPendingMessageNow: (...args: any[]) => sendPendingMessageNow(...args),
        deletePendingMessage: (...args: any[]) => deletePendingMessage(...args),
        discardPendingMessage: (...args: any[]) => discardPendingMessage(...args),
        dismissPendingDelivery: (...args: any[]) => dismissPendingDelivery(...args),
        markPendingDeliveryHandled: (...args: any[]) => markPendingDeliveryHandled(...args),
        sendPendingDeliveryAsNew: (...args: any[]) => sendPendingDeliveryAsNew(...args),
        updatePendingMessage: vi.fn(),
        restoreDiscardedPendingMessage: vi.fn(),
        deleteDiscardedPendingMessage: (...args: any[]) => deleteDiscardedPendingMessage(...args),
        fetchPendingMessages: vi.fn(),
        reorderPendingMessages: (...args: any[]) => reorderPendingMessages(...args),
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAbort: (...args: any[]) => sessionAbort(...args),
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (...args: any[]) => executeDefaultAction(...args),
    }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => serverFeaturesSnapshotState.current,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (...args: unknown[]) => resolvePreferredServerIdForSessionId(...args),
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
        const items = props.open
            ? props.items.map((item: any) => React.createElement(
                'DropdownMenuItem',
                {
                    key: item.id,
                    testID: item.testID,
                    accessibilityRole: 'button',
                    accessibilityLabel: item.title,
                    disabled: item.disabled,
                    onPress: () => {
                        if (!item.disabled) props.onSelect(item.id);
                    },
                },
                item.title,
            ))
            : null;
        return React.createElement('DropdownMenu', { open: props.open }, trigger, items);
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
        sendPendingMessageNow.mockResolvedValue({ type: 'committed', persistence: 'provider_direct' });
        deletePendingMessage.mockReset();
        discardPendingMessage.mockReset();
        dismissPendingDelivery.mockReset();
        deleteDiscardedPendingMessage.mockReset();
        markPendingDeliveryHandled.mockReset();
        sendPendingDeliveryAsNew.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
        modalPrompt.mockReset();
        reorderPendingMessages.mockReset();
        executeDefaultAction.mockReset();
        executeDefaultAction.mockResolvedValue({ ok: true, result: { ok: true, status: 'cleared', sessionId: 's1' } });
        resolvePreferredServerIdForSessionId.mockReset();
        serverFeaturesSnapshotState.current = { status: 'loading' };
        sessionValue = null;
        settingValues = {};
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

    function createFreshSteerCapableSession(): Record<string, unknown> {
        return {
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };
    }

    function queuedMessage(id: string, createdAt: number): PendingMessage {
        return {
            id,
            localId: id,
            text: `command-${id}`,
            displayText: undefined,
            createdAt,
            updatedAt: createdAt,
            rawRecord: { command: `command-${id}` },
        };
    }

    function renderedPendingOrder(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
        const list = screen.findByType('PendingMessagesDragReorderList');
        return list.props.messages.map((message: PendingMessage) => message.id);
    }

    it('delegates send-now interrupt intent and deletes after commit', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'provider_direct' });
        deletePendingMessage.mockResolvedValueOnce(undefined);
        const message = { id: 'storage-p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'canonical-local-p1', rawRecord: {} };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [message],
                discardedMessages: [],
            }));

        // Web-only: action icons show on hover.
        await hoverPendingMessageRow(screen, 'storage-p1');

        const sendNow = screen.findByTestId('pendingMessages.sendNow:storage-p1');
        expect(sendNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.sendNow:storage-p1');

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'canonical-local-p1',
            deliveryIntent: 'interrupt_and_send',
        }));
        expect(deletePendingMessage).toHaveBeenCalledTimes(1);

        const sendOrder = sendPendingMessageNow.mock.invocationCallOrder[0]!;
        const deleteOrder = deletePendingMessage.mock.invocationCallOrder[0]!;

        expect(sendOrder).toBeLessThan(deleteOrder);
    });

    it('describes resuming an inactive session without claiming that a turn will be stopped', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(false);
        sessionValue = {
            active: false,
            presence: 'offline',
            thinking: false,
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(modalConfirm).toHaveBeenCalledWith(
            t('session.pendingMessages.sendConfirm.title'),
            t('session.pendingMessages.sendConfirm.resumeBody'),
            { confirmText: t('session.pendingMessages.actions.sendNow') },
        );
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('keeps the interruption warning for send-now during an active turn', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(false);
        sessionValue = createFreshSteerCapableSession();

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(modalConfirm).toHaveBeenCalledWith(
            t('session.pendingMessages.sendConfirm.interruptTitle'),
            t('session.pendingMessages.sendConfirm.body'),
            { confirmText: t('session.pendingMessages.actions.sendNowInterrupt') },
        );
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('explains that background work continues when sending to the foreground agent now', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(false);
        sessionValue = {
            active: true,
            presence: 'online',
            thinking: false,
            agentStateVersion: 1,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');
        const sendNow = screen.findByTestId('pendingMessages.sendNow:p1');
        expect(sendNow?.props.accessibilityLabel).toBe(
            t('session.pendingMessages.actions.sendToAgentNow'),
        );

        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(modalConfirm).toHaveBeenCalledWith(
            t('session.pendingMessages.sendConfirm.backgroundTitle'),
            t('session.pendingMessages.sendConfirm.backgroundBody'),
            { confirmText: t('session.pendingMessages.actions.sendToAgentNow') },
        );
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('keeps the pending row after provider-direct send-now while provider acceptance is pending', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockResolvedValueOnce({
            type: 'committed',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).not.toHaveBeenCalled();
    });

    it('keeps the pending row after send-now transcript-only commit', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'transcript_committed' });

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'p1',
            deliveryIntent: 'interrupt_and_send',
        }));
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
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
        const affordanceStyle = flattenStyle(affordance!.props.style);
        expect(affordanceStyle.position).toBe('absolute');
        expect(affordanceStyle.borderWidth).toBe(0);
        expect(affordanceStyle.paddingVertical).toBe(1);
    });

    it('uses the transcript markdown typography for pending message markdown rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(markdownView.props.textStyle).toMatchObject({
            fontSize: 16,
            lineHeight: 24,
        });
        const message = screen.findByTestId('pendingMessages.message:p1');
        expect(flattenStyle(message!.props.style({ pressed: false }))).toMatchObject({
            textAlign: 'left',
        });
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
        expect(flattenStyle(overlayAfterHover!.props.style).bottom).toBe(8);
        expect(overlayAfterHover!.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(overlayAfterHover!.props.style).pointerEvents).toBe('auto');

        const remove = screen.findByTestId('pendingMessages.remove:p1');
        expect(remove).toBeTruthy();
        const removeStyle = typeof remove!.props.style === 'function'
            ? remove!.props.style({ pressed: false })
            : remove!.props.style;
        expect(flattenStyle(removeStyle).pointerEvents).toBe('auto');
    });

    it('sends steer-now directly while a steer-capable session is thinking and does not abort the turn', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        sessionValue = createFreshSteerCapableSession();

        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'provider_direct' });
        deletePendingMessage.mockResolvedValueOnce(undefined);
        const message = { id: 'storage-p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'canonical-local-p1', rawRecord: {} };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [message],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'storage-p1');

        const steerNow = screen.findByTestId('pendingMessages.steerNow:storage-p1');
        expect(steerNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.steerNow:storage-p1');

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(modalConfirm).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
	        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
	            localId: 'canonical-local-p1',
	            deliveryIntent: 'steer_now',
	        }));
	        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
	    });

    it('dispatches a later exact steer target without mutating durable FIFO order', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                queuedMessage('a', 0),
                queuedMessage('b', 1),
                queuedMessage('c', 2),
            ],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'c');
        await screen.pressByTestIdAsync('pendingMessages.steerNow:c');

        expect(renderedPendingOrder(screen)).toEqual(['a', 'b', 'c']);
        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', {
            localId: 'c',
            createdAt: 2,
            rawRecord: { command: 'command-c' },
            text: 'command-c',
            displayText: undefined,
            deliveryIntent: 'steer_now',
        });
    });

    it('does not reprioritize when steer-now targets the head message', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                { id: 'a', text: 'aaa', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'a', rawRecord: {} },
                { id: 'b', text: 'bbb', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'b', rawRecord: {} },
                { id: 'c', text: 'ccc', displayText: undefined, createdAt: 2, updatedAt: 2, localId: 'c', rawRecord: {} },
            ],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'a');
        await screen.pressByTestIdAsync('pendingMessages.steerNow:a');

        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'a',
            deliveryIntent: 'steer_now',
        }));
    });

    it('dispatches a later exact send-now target without mutating durable FIFO order', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'transcript_committed' });

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                queuedMessage('a', 0),
                queuedMessage('b', 1),
                queuedMessage('c', 2),
            ],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'c');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:c');

        expect(renderedPendingOrder(screen)).toEqual(['a', 'b', 'c']);
        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', {
            localId: 'c',
            createdAt: 2,
            rawRecord: { command: 'command-c' },
            text: 'command-c',
            displayText: undefined,
            deliveryIntent: 'interrupt_and_send',
        });
    });

    it('preserves durable FIFO order when the send-now action fails', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockRejectedValueOnce(new Error('send-now action failed'));

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                queuedMessage('a', 0),
                queuedMessage('b', 1),
                queuedMessage('c', 2),
            ],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'c');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:c');

        expect(renderedPendingOrder(screen)).toEqual(['a', 'b', 'c']);
        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', {
            localId: 'c',
            createdAt: 2,
            rawRecord: { command: 'command-c' },
            text: 'command-c',
            displayText: undefined,
            deliveryIntent: 'interrupt_and_send',
        });
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalledTimes(1);
    });

    it('sends discarded steer-now directly without confirmation', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'provider_direct' });
        deleteDiscardedPendingMessage.mockResolvedValueOnce(undefined);

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [],
            discardedMessages: [
                { id: 'discarded-projection-d1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason: 'manual', localId: 'canonical-local-d1', rawRecord: {} },
            ],
        }));

        await hoverDiscardedMessageRow(screen, 'discarded-projection-d1');

        const steerNow = screen.findByTestId('pendingMessages.discarded.steerNow:discarded-projection-d1');
        expect(steerNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.discarded.steerNow:discarded-projection-d1');

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(modalConfirm).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'canonical-local-d1',
            deliveryIntent: 'steer_now',
        }));
        expect(deleteDiscardedPendingMessage).toHaveBeenCalledWith('s1', 'discarded-projection-d1');
    });

    it.each(['dismissed_uncertain', 'resent_as_new'] as const)(
        'keeps %s uncertainty tombstones visible but non-executable',
        async (discardedReason) => {
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            sessionValue = createFreshSteerCapableSession();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [],
                discardedMessages: [{
                    id: 'd1', localId: 'd1', text: 'archived uncertainty', displayText: undefined,
                    createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason, rawRecord: {},
                }],
            }));

            expect(screen.findByTestId('pendingMessages.discarded.row:d1')).toBeTruthy();
            await hoverDiscardedMessageRow(screen, 'd1');
            expect(screen.findByTestId('pendingMessages.discarded.requeue:d1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.discarded.remove:d1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.discarded.steerNow:d1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.discarded.sendNow:d1')).toBeNull();
        },
    );

    it('does not offer steer-now when stale thinking follows a completed primary turn projection', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            ...createFreshSteerCapableSession(),
            thinkingAt: 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 2_000,
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
    });

    it('keeps steer and force-send available when the active flag lags a fresh in-progress turn', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(130_000);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: false,
            active: false,
            activeAt: 100_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 129_500,
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: true,
                },
            },
        };

        try {
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

            expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeNull();

            await hoverPendingMessageRow(screen, 'p1');

            expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.edit:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('keeps force-send available when a recent in-progress turn is no longer live', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(130_000);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: false,
            active: false,
            activeAt: 100_000,
            presence: 'offline',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 129_500,
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: true,
                },
            },
        };

        try {
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

            await hoverPendingMessageRow(screen, 'p1');

            expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.edit:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('keeps direct send and steer actions available without a provider reissue action for blocked pending delivery rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        markPendingDeliveryHandled.mockResolvedValueOnce(undefined);
        modalConfirm.mockResolvedValueOnce(true);

        const pendingMessage: PendingMessage = {
            id: 'p1',
            localId: 'p1',
            text: 'blocked delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.blockedDeliveryNotice:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.retryDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();

        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pendingMessages.markDeliveryHandled:p1');
        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).toHaveBeenCalledWith('s1', 'p1');
    });

    it.each([
        ['delivery_outcome_uncertain', 'Delivery status needs review'],
    ] as const)('keeps effect-possible blocked reason %s visible with truthful manual recovery actions', async (
        pendingDeliveryBlockedReason,
        expectedLabel,
    ) => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        modalConfirm.mockResolvedValueOnce(true);
        markPendingDeliveryHandled.mockResolvedValueOnce(undefined);
        const pendingMessage: PendingMessage = {
            id: 'p1',
            localId: 'p1',
            text: 'effect-possible delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason,
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                pendingMessage,
                {
                    ...pendingMessage,
                    id: 'p2',
                    localId: 'p2',
                    text: 'later queued delivery',
                    pendingDeliveryStatus: 'server_queued',
                    pendingDeliveryBlockedReason: undefined,
                } as PendingMessage,
            ],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.blockedDeliveryReason:p1')?.props.children).toBe(expectedLabel);
        expect(screen.findByTestId('pendingMessages.retryDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.dismissDelivery:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendAsNew:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.edit:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.reorder:p1')).toBeNull();

        await screen.pressByTestIdAsync('pendingMessages.markDeliveryHandled:p1');

        expect(markPendingDeliveryHandled).toHaveBeenCalledWith('s1', 'p1');
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it('dismisses or sends an uncertain delivery as a new identity without retrying the original', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        dismissPendingDelivery.mockResolvedValueOnce(undefined);
        sendPendingDeliveryAsNew.mockResolvedValueOnce(undefined);
        const pendingMessage: PendingMessage = {
            id: 'p1', localId: 'p1', text: 'uncertain delivery', displayText: undefined,
            createdAt: 0, updatedAt: 0, rawRecord: {}, source: 'server_pending',
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
        } as PendingMessage;

        const dismissScreen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await dismissScreen.pressByTestIdAsync('pendingMessages.message:p1');
        await dismissScreen.pressByTestIdAsync('pendingMessages.dismissDelivery:p1');
        expect(dismissPendingDelivery).toHaveBeenCalledWith('s1', 'p1');
        expect(discardPendingMessage).not.toHaveBeenCalled();

        const sendScreen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await sendScreen.pressByTestIdAsync('pendingMessages.message:p1');
        await sendScreen.pressByTestIdAsync('pendingMessages.sendAsNew:p1');
        expect(sendPendingDeliveryAsNew).toHaveBeenCalledWith('s1', 'p1');
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('continues waiting on a delivery-outcome uncertainty without invoking a delivery operation', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const pendingMessage: PendingMessage = {
            id: 'p1',
            localId: 'p1',
            text: 'effect-possible delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.message:p1');
        const continueWaiting = screen.findByTestId('pendingMessages.continueWaiting:p1');
        expect(continueWaiting?.props.accessibilityLabel).toBe('Continue waiting');

        await screen.pressByTestIdAsync('pendingMessages.continueWaiting:p1');

        expect(screen.findByTestId('pendingMessages.row:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.continueWaiting:p1')).toBeNull();
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it('ignores duplicate mark-handled presses while the confirmation is unresolved', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const confirmDeferred = createDeferred<boolean>();
        modalConfirm.mockReturnValueOnce(confirmDeferred.promise);
        markPendingDeliveryHandled.mockResolvedValueOnce(undefined);
        const pendingMessage: PendingMessage = {
            id: 'p1',
            localId: 'p1',
            text: 'blocked delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');
        const markHandled = screen.findByTestId('pendingMessages.markDeliveryHandled:p1');
        expect(markHandled).toBeTruthy();

        await act(async () => {
            invokeTestInstanceHandler(markHandled, 'onPress', undefined, 'pendingMessages.markDeliveryHandled:p1');
            invokeTestInstanceHandler(markHandled, 'onPress', undefined, 'pendingMessages.markDeliveryHandled:p1');
            await Promise.resolve();
        });

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();

        await act(async () => {
            confirmDeferred.resolve(true);
            await confirmDeferred.promise;
            await Promise.resolve();
        });

        expect(markPendingDeliveryHandled).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).toHaveBeenCalledWith('s1', 'p1');
    });

    it.each([
        'server_delivering',
        'external_handoff',
    ] as const)('keeps provider-effect-possible %s rows visible without mutation actions', async (pendingDeliveryStatus) => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();

        const pendingMessage: PendingMessage = {
            id: 'p-delivering',
            localId: 'p-delivering',
            text: 'delivering delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus,
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                pendingMessage,
                {
                    ...pendingMessage,
                    id: 'p-queued',
                    localId: 'p-queued',
                    text: 'later queued delivery',
                    pendingDeliveryStatus: 'server_queued',
                } as PendingMessage,
            ],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p-delivering');

        expect(screen.findByTestId('pendingMessages.pendingAffordance:p-delivering')?.props.accessibilityLabel).toBe('Delivering');
        if (pendingDeliveryStatus === 'server_delivering') {
            expect(screen.findByTestId('pendingMessages.deliveringIndicator:p-delivering')).toBeTruthy();
        } else {
            expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:p-delivering')?.props.children).toBe('Delivering');
        }
        expect(screen.findByTestId('pendingMessages.retryDelivery:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.edit:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.reorder:p-delivering')).toBeNull();

        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it('labels exact Claude-native custody as Queued in Claude', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        serverFeaturesSnapshotState.current = {
            status: 'ready',
            features: {
                capabilities: {
                    compatibility: {
                        pendingInput: { currentPendingInputProtocolVersion: 1 },
                    },
                },
            },
        };
        resolvePreferredServerIdForSessionId.mockReturnValue('server-a');
        sessionValue = {
            ...createFreshSteerCapableSession(),
            metadata: { flavor: 'claude', path: '/repo', host: 'host' },
            agentState: {
                controlledByUser: false,
                capabilities: {
                    pendingInputInterruptAndRunLocalId: 'p-delivering',
                    pendingInputInterruptAndRunStateAt: 42,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'server-p-delivering',
                localId: 'p-delivering',
                text: 'delivering delivery',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                rawRecord: {},
                source: 'server_pending',
                pendingDeliveryStatus: 'server_delivering',
            } as PendingMessage],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:server-p-delivering')?.props.children)
            .toBe('Queued in Claude');
        expect(resolvePreferredServerIdForSessionId).toHaveBeenCalledWith('s1');

        modalConfirm.mockResolvedValueOnce(true);
        await screen.pressByTestIdAsync('pendingMessages.message:server-p-delivering');
        await screen.pressByTestIdAsync('pendingMessages.interruptAndRun:server-p-delivering');

        expect(executeDefaultAction).toHaveBeenCalledWith(
            'session.pendingInput.interruptAndRun',
            { sessionId: 's1', localId: 'p-delivering', expectedStateAtMs: 42 },
            { defaultSessionId: 's1', surface: 'ui' },
        );
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
    });

    it('keeps non-retry direct actions available for pre-effect server rows with stale client delivery metadata', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();

        const pendingMessage: PendingMessage = {
            id: 'p-accepted-blocked',
            localId: 'p-accepted-blocked',
            text: 'accepted blocked delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p-accepted-blocked');

        expect(screen.findByTestId('pendingMessages.retryDelivery:p-accepted-blocked')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p-accepted-blocked')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p-accepted-blocked')).toBeNull();
        expect(screen.findByTestId('pendingMessages.edit:p-accepted-blocked')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p-accepted-blocked')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerNow:p-accepted-blocked')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendNow:p-accepted-blocked')).toBeTruthy();
    });

    it('keeps direct send and steer actions available for server-owned queued rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();

        const pendingMessage: PendingMessage = {
            id: 'p-queued',
            localId: 'p-queued',
            text: 'queued delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'server_queued',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p-queued');

        expect(screen.findByTestId('pendingMessages.steerNow:p-queued')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendNow:p-queued')).toBeTruthy();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it('ignores duplicate remove presses while the confirmation is unresolved', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const confirmDeferred = createDeferred<boolean>();
        modalConfirm.mockReturnValueOnce(confirmDeferred.promise);
        deletePendingMessage.mockResolvedValueOnce(undefined);
        const pendingMessage: PendingMessage = {
            id: 'p-delivering',
            localId: 'p-delivering',
            text: 'delivering delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p-delivering');
        const remove = screen.findByTestId('pendingMessages.remove:p-delivering');
        expect(remove).toBeTruthy();

        await act(async () => {
            invokeTestInstanceHandler(remove, 'onPress', undefined, 'pendingMessages.remove:p-delivering');
            invokeTestInstanceHandler(remove, 'onPress', undefined, 'pendingMessages.remove:p-delivering');
            await Promise.resolve();
        });

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();

        await act(async () => {
            confirmDeferred.resolve(true);
            await confirmDeferred.promise;
            await Promise.resolve();
        });

        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledWith('s1', 'p-delivering');
        expect(discardPendingMessage).not.toHaveBeenCalled();
    });

    it('shows a non-steerable notice and interrupt action when active-turn steer is unavailable', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: false,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeTruthy();
        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeFalsy();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
    });

    it('shows the terminal-draft variant of the notice when the CLI published user_terminal_draft', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: false,
                    inFlightSteerUnavailableReason: 'user_terminal_draft',
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeTruthy();
    });

    it('offers to clear the terminal composer for active-turn terminal draft blockage', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionValue = {
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: false,
                    inFlightSteerUnavailableReason: 'user_terminal_draft',
                    inFlightSteerStateAt: 42,
                    terminalComposerClearSupported: true,
                    terminalComposerDraftPresent: true,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeTruthy();
        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(executeDefaultAction).toHaveBeenCalledWith(
            'session.terminalComposer.clear',
            { sessionId: 's1', expectedStateAtMs: 42 },
            { defaultSessionId: 's1', surface: 'ui', placement: 'pending_messages' },
        );
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('offers to clear the terminal composer when an idle session reports a terminal draft', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            active: true,
            thinking: false,
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    terminalComposerClearSupported: true,
                    terminalComposerDraftPresent: true,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeTruthy();
    });

    it('ignores a sticky terminal-draft capability when the session is inactive (no runtime, no ghost draft)', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            active: false,
            thinking: false,
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    terminalComposerClearSupported: true,
                    terminalComposerDraftPresent: true,
                    inFlightSteerUnavailableReason: 'user_terminal_draft',
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeNull();
        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeNull();
    });

    it('does not call the clear action when terminal composer clear is canceled', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(false);
        sessionValue = {
            active: true,
            thinking: false,
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    terminalComposerClearSupported: true,
                    terminalComposerDraftPresent: true,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(executeDefaultAction).not.toHaveBeenCalled();
        expect(screen.findByTestId('pendingMessages.row:p1')).toBeTruthy();
    });

    it('keeps pending rows and alerts when terminal composer clear fails', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        executeDefaultAction.mockResolvedValueOnce({
            ok: true,
            result: { ok: false, status: 'dialog_open', error: 'dialog_open', sessionId: 's1' },
        });
        sessionValue = {
            active: true,
            thinking: false,
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    terminalComposerClearSupported: true,
                    terminalComposerDraftPresent: true,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expect(modalAlert).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('pendingMessages.row:p1')).toBeTruthy();
    });

	    it('does not offer steer-now or send-now for pending rows that failed to decrypt', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        sessionValue = createFreshSteerCapableSession();

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

    it('keeps the pending row when send-now is queued for retry', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'retry_scheduled' });

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(discardPendingMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('uses an 80px default max-height for the pending queue block', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const scroll = screen.findByType('ScrollView');
        expect(scroll.props.style?.maxHeight).toBe(80);
        expect(scroll.props.style?.marginTop).toBe(0);
        expect(scroll.props.contentContainerStyle).toMatchObject({ paddingTop: 6, paddingBottom: 0 });
    });

    it('shows the collapsed header toggle only when pending content overflows the compact height', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 160);
        });

        const headerToggle = screen.findByTestId('pendingMessages.headerToggle');
        expect(headerToggle).toBeTruthy();
        const headerToggleStyle = flattenStyle(headerToggle!.props.style({ pressed: false }));
        expect(headerToggleStyle.borderWidth).toBe(0);
        expect(headerToggleStyle.paddingHorizontal).toBe(0);
        expect(headerToggleStyle.paddingVertical).toBe(0);
        expect(screen.findByProps({ name: 'chevron-up' })).toBeTruthy();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('does not show a header toggle when pending content fits the compact height', async () => {
        settingValues = { transcriptPendingQueueMaxHeightPx: 80 };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 72);
        });

        expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('keeps the pending queue viewport above the row estimate when web content measurement underflows', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueReorderRowHeightPx: 52,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 6);
        });

        expect(screen.findByType('ScrollView').props.style?.height).toBe(52);
        expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();
    });

    it('expands the pending queue from the header toggle without changing the compact default', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 160);
        });

        await screen.pressByTestIdAsync('pendingMessages.headerToggle');

        expect(screen.findByProps({ name: 'chevron-down' })).toBeTruthy();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(520);
    });

    it('collapses the pending queue from the expanded header toggle', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 160);
        });
        await screen.pressByTestIdAsync('pendingMessages.headerToggle');
        await screen.pressByTestIdAsync('pendingMessages.headerToggle');

        expect(screen.findByProps({ name: 'chevron-up' })).toBeTruthy();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('resets expanded pending queue state after all pending rows clear', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const firstPendingMessage = { id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} };
        const secondPendingMessage = { id: 'p2', text: 'world', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [firstPendingMessage],
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 160);
        });
        await screen.pressByTestIdAsync('pendingMessages.headerToggle');
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(520);

        await screen.update(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [],
            discardedMessages: [],
        }));

        await screen.update(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [secondPendingMessage],
            discardedMessages: [],
        }));
        const nextScroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            nextScroll!.props.onContentSizeChange(0, 160);
        });

        expect(screen.findByProps({ name: 'chevron-up' })).toBeTruthy();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('shows the queued affordance instead of a loading spinner for accepted pending rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', deliveryStatus: 'accepted', rawRecord: {} }],
                discardedMessages: [],
            }));

        expect(screen.findByTestId('pendingMessages.acceptedIndicator:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.queuedIndicator:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:p1')).toBeTruthy();
    });

    it('renders explicit queued actions and malformed actions with truthful visible labels', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = { active: true, presence: 'online' };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ ...queuedMessage('steer', 0), pendingRequestedAction: { v: 1, kind: 'steer_now' } }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:steer')?.props.children).toBe('Steer now');

        await screen.update(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ ...queuedMessage('send', 0), pendingRequestedAction: { v: 1, kind: 'send_now' } }],
            discardedMessages: [],
        }));
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:send')?.props.children).toBe('Send now');

        await screen.update(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ ...queuedMessage('malformed', 0), pendingRequestedActionMalformed: true }],
            discardedMessages: [],
        }));
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:malformed')?.props.children).toBe('Delivery action needs review');
    });

    it('renders canonical Activity and predecessor defer reasons from live session facts', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        settingValues.sessionPendingQueueDeliveryTiming = 'after_runtime_idle';
        sessionValue = {
            active: true,
            presence: 'online',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [queuedMessage('head', 0), queuedMessage('later', 1)],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:head')?.props.children)
            .toBe('Waiting for runtime activity to finish');
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:later')?.props.children)
            .toBe('Waiting for an earlier message');
    });

    it('delegates pending edit to the composer owner without opening a prompt', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const onEditPendingMessage = vi.fn();
        const message: PendingMessage = {
            id: 'p1',
            text: 'hello\nfrom queue',
            displayText: 'hello\nfrom queue',
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [message],
                discardedMessages: [],
                onEditPendingMessage,
            }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.edit:p1');

        expect(modalPrompt).toHaveBeenCalledTimes(0);
        expect(onEditPendingMessage).toHaveBeenCalledTimes(1);
        expect(onEditPendingMessage).toHaveBeenCalledWith({
            id: 'p1',
            text: 'hello\nfrom queue',
            displayText: 'hello\nfrom queue',
            message,
        });
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

    it('keeps a durable outbox enqueue on retry-or-remove actions until its exact envelope settles', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'p1', text: 'durable prompt', createdAt: 0, updatedAt: 0, localId: 'p1',
                source: 'local_outbound', deliveryStatus: 'queued', sendState: 'failed',
                pendingOutboxScope: { serverId: 'server-a', accountId: 'account-a' },
                pendingOutboxOperation: 'enqueue', rawRecord: {},
            }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');
        expect(screen.findByTestId('pendingMessages.retrySend:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.edit:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
    });
});
