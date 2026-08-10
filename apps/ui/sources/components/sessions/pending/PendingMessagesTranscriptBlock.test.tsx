import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import {
    getPendingMessageVisualState,
    resolvePendingMessageHeightBearingChrome,
    type PendingMessageHeightBearingChrome,
} from './pendingMessageVisualState';
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
const markPendingDeliveryHandled = vi.fn();
const dismissPendingDelivery = vi.fn();
const sendPendingDeliveryAsNew = vi.fn();
const sessionAbort = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();
const modalPrompt = vi.fn();
const reorderPendingMessages = vi.fn();
const actionExecute = vi.fn();
const resolvePreferredServerIdForSessionId = vi.fn();
const setClipboardStringSafe = vi.hoisted(() => vi.fn(async (_value: string) => true));

let sessionValue: any = null;
let settingValues: Record<string, unknown> = {};

installPendingMessagesCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit');
        return createPartialStorageModuleMock(importOriginal, {
            useSession: () => sessionValue === null
                ? null
                : {
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: null,
                    ...sessionValue,
                },
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

vi.mock('@/sync/sync', () => ({
    sync: {
        sendPendingMessageNow: (...args: any[]) => sendPendingMessageNow(...args),
        deletePendingMessage: (...args: any[]) => deletePendingMessage(...args),
        discardPendingMessage: (...args: any[]) => discardPendingMessage(...args),
        markPendingDeliveryHandled: (...args: any[]) => markPendingDeliveryHandled(...args),
        dismissPendingDelivery: (...args: any[]) => dismissPendingDelivery(...args),
        sendPendingDeliveryAsNew: (...args: any[]) => sendPendingDeliveryAsNew(...args),
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

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (...args: any[]) => actionExecute(...args),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (...args: unknown[]) => resolvePreferredServerIdForSessionId(...args),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafe(value),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>();
    return {
        ...actual,
        useServerFeaturesSnapshotForServerId: (serverId: string | null | undefined) => (
            serverId === 'server-owner'
                ? {
                    status: 'ready' as const,
                    features: {
                        capabilities: {
                            session: {
                                pendingInput: {
                                    protocolVersion: 1,
                                },
                            },
                            compatibility: {
                                pendingInput: {
                                    currentPendingInputProtocolVersion: 1,
                                },
                            },
                        },
                    },
                }
                : { status: 'loading' as const }
        ),
    };
});

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
        return React.createElement('DropdownMenu', {
            open: props.open,
            popoverAnchor: props.popoverAnchor,
            placement: props.placement,
            matchTriggerWidth: props.matchTriggerWidth,
        }, trigger, items);
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
        markPendingDeliveryHandled.mockReset();
        dismissPendingDelivery.mockReset();
        sendPendingDeliveryAsNew.mockReset();
        sessionAbort.mockReset();
        modalConfirm.mockReset();
        modalAlert.mockReset();
        reorderPendingMessages.mockReset();
        actionExecute.mockReset();
        actionExecute.mockResolvedValue({ ok: true, result: { ok: true, status: 'cleared' } });
        resolvePreferredServerIdForSessionId.mockReset();
        setClipboardStringSafe.mockReset();
        setClipboardStringSafe.mockResolvedValue(true);
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

    function terminalDraftBlockedPendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
        return {
            id: 'p1',
            text: 'hello',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
            rawRecord: {},
            ...overrides,
        };
    }

    it('cleans up a legacy provider-direct row after send-now when no server claim owns it', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'provider_direct' });
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

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'p1',
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
        sessionValue = {
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: Date.now(),
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

    it('keeps the durable server row after send-now when provider acceptance owns resolution', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
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

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'p1',
            deliveryIntent: 'interrupt_and_send',
        }));
        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(discardPendingMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('keeps the durable pending row when send-now only commits to the transcript', async () => {
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

        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(discardPendingMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    it('delegates pending edit to the composer owner instead of opening a prompt modal', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const onEditPendingMessage = vi.fn();
        modalPrompt.mockResolvedValueOnce('edited');

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello\nworld', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
                onEditPendingMessage,
            }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.edit:p1');

        expect(onEditPendingMessage).toHaveBeenCalledTimes(1);
        expect(onEditPendingMessage).toHaveBeenCalledWith(expect.objectContaining({
            id: 'p1',
            text: 'hello\nworld',
        }));
        expect(modalPrompt).not.toHaveBeenCalled();
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

    it('renders unknown delivery states as visible blocked pending rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'unknown',
                    pendingDeliveryStatusRaw: 'awaiting_moon_phase',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        expect(screen.findByTestId('pendingMessages.row:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.blockedDeliveryNotice:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.unknownDeliveryStatus:p1')).toBeTruthy();
    });

    /**
     * F-P2 (2026-08-10): `resolvePendingMessageHeightBearingChrome` is what the transcript
     * measurement layer keys the pending row's SIZE VERSION on, and it is only sound while it names
     * the same in-flow notice this block actually paints. Asserted from BOTH ends here: the
     * descriptor's answer, and the notice that appears in the tree.
     */
    it('paints exactly the in-flow notice its height-bearing chrome descriptor names', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const row = (overrides: Partial<PendingMessage>): PendingMessage => ({
            id: 'p1',
            text: 'hello',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            source: 'server_pending',
            rawRecord: {},
            ...overrides,
        } as PendingMessage);

        const cases: readonly Readonly<{
            chrome: PendingMessageHeightBearingChrome;
            messages: readonly PendingMessage[];
            noticeTestId: string | null;
        }>[] = [
            { chrome: 'none', messages: [row({ pendingDeliveryStatus: 'server_queued' })], noticeTestId: null },
            { chrome: 'none', messages: [row({ pendingDeliveryStatus: 'server_delivering' })], noticeTestId: null },
            { chrome: 'none', messages: [row({ source: 'local_outbound' })], noticeTestId: null },
            {
                chrome: 'blocked-notice',
                messages: [row({ pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'payload_too_large' })],
                noticeTestId: 'pendingMessages.blockedDeliveryNotice:p1',
            },
            {
                chrome: 'blocked-notice',
                messages: [row({ pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'ambiguous_terminal_delivery' })],
                noticeTestId: 'pendingMessages.blockedDeliveryNotice:p1',
            },
            {
                chrome: 'retry-notice',
                messages: [row({ source: 'local_outbound', sendState: 'failed' })],
                noticeTestId: 'pendingMessages.sendFailedNotice:p1',
            },
            {
                // A sibling holding provider custody is what makes p1 wait, and the wait is in flow.
                chrome: 'wait-notice',
                messages: [
                    row({ id: 'p0', localId: 'p0', pendingDeliveryStatus: 'server_delivering' }),
                    row({ pendingDeliveryStatus: 'server_queued' }),
                ],
                noticeTestId: 'pendingMessages.queuedReason:waiting_for_predecessor:p1',
            },
        ];

        for (const { chrome, messages, noticeTestId } of cases) {
            sessionValue = { active: true, presence: 'online', agentStateVersion: 1, runtimeActivityState: 'idle' };
            const subject = messages[messages.length - 1]!;
            const hasProviderDeliveryInFlight = messages.some((m) => m.pendingDeliveryStatus === 'server_delivering');
            expect(resolvePendingMessageHeightBearingChrome(
                getPendingMessageVisualState(subject, { hasProviderDeliveryInFlight }),
            ), `descriptor for ${JSON.stringify(subject.pendingDeliveryStatus ?? subject.sendState ?? subject.source)}`)
                .toBe(chrome);

            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [...messages],
                discardedMessages: [],
            }));

            const painted = [
                'pendingMessages.blockedDeliveryNotice:p1',
                'pendingMessages.sendFailedNotice:p1',
                'pendingMessages.queuedReason:waiting_for_predecessor:p1',
            ].filter((testId) => screen.findByTestId(testId) !== null);

            expect(painted, `painted notices for ${chrome}`).toEqual(noticeTestId ? [noticeTestId] : []);
        }
    });

    it('marks blocked pending delivery handled without replaying the row', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        markPendingDeliveryHandled.mockResolvedValueOnce(undefined);
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.markDeliveryHandled:p1');

        expect(modalConfirm).toHaveBeenCalledWith(
            'Mark pending message handled?',
            'Use this only if the provider already handled the message or you no longer want Happier to deliver it.',
            { confirmText: 'Mark handled' },
        );
        expect(modalConfirm.mock.invocationCallOrder[0]).toBeLessThan(markPendingDeliveryHandled.mock.invocationCallOrder[0]!);
        expect(markPendingDeliveryHandled).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).toHaveBeenCalledWith('s1', 'p1');
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
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
                    rawRecord: {},
                }],
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
        expect(dismissPendingDelivery).not.toHaveBeenCalled();
        expect(sendPendingDeliveryAsNew).not.toHaveBeenCalled();

        await act(async () => {
            confirmDeferred.resolve(true);
            await confirmDeferred.promise;
            await Promise.resolve();
        });

        expect(markPendingDeliveryHandled).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).toHaveBeenCalledWith('s1', 'p1');
    });

    it('offers explicit dismiss and send-as-new operations for uncertain delivery', async () => {
        modalConfirm.mockResolvedValue(true);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'p1',
                text: 'hello',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                localId: 'p1',
                source: 'server_pending',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.message:p1');
        await screen.pressByTestIdAsync('pendingMessages.dismissDelivery:p1');
        expect(dismissPendingDelivery).toHaveBeenCalledWith('s1', 'p1');

        await screen.pressByTestIdAsync('pendingMessages.message:p1');
        await screen.pressByTestIdAsync('pendingMessages.sendDeliveryAsNew:p1');
        expect(sendPendingDeliveryAsNew).toHaveBeenCalledWith('s1', 'p1');
    });

    it('does not offer provider replay actions for an ambiguous pending delivery', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    {
                        id: 'p1',
                        text: 'hello',
                        displayText: undefined,
                        createdAt: 0,
                        updatedAt: 0,
                        localId: 'p1',
                        source: 'server_pending',
                        pendingDeliveryStatus: 'blocked',
                        pendingDeliveryBlockedReason: 'ambiguous_terminal_delivery',
                        rawRecord: {},
                    },
                    {
                        id: 'p2',
                        text: 'later',
                        displayText: undefined,
                        createdAt: 1,
                        updatedAt: 1,
                        localId: 'p2',
                        source: 'server_pending',
                        pendingDeliveryStatus: 'server_queued',
                        rawRecord: {},
                    },
                ],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.retryDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.reorder:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it('continues waiting on the same uncertain rows without invoking a delivery operation', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                {
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'ambiguous_terminal_delivery',
                    rawRecord: {},
                },
                {
                    id: 'p2',
                    text: 'hello later',
                    displayText: undefined,
                    createdAt: 1,
                    updatedAt: 1,
                    localId: 'p2',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
                    rawRecord: {},
                },
            ],
            discardedMessages: [],
        }));

        for (const messageId of ['p1', 'p2']) {
            await screen.pressByTestIdAsync(`pendingMessages.message:${messageId}`);
            const continueWaiting = screen.findByTestId(`pendingMessages.continueWaiting:${messageId}`);
            expect(continueWaiting?.props.accessibilityLabel).toBe('Continue waiting');

            await screen.pressByTestIdAsync(`pendingMessages.continueWaiting:${messageId}`);

            expect(screen.findByTestId(`pendingMessages.row:${messageId}`)).toBeTruthy();
            expect(screen.findByTestId(`pendingMessages.continueWaiting:${messageId}`)).toBeNull();
        }
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it('offers duplicate-safe send-as-new recovery but no direct provider replay while server delivery is in progress', async () => {
        modalConfirm.mockResolvedValue(true);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'server_delivering',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.retryDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendDeliveryAsNew:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pendingMessages.sendDeliveryAsNew:p1');

        expect(sendPendingDeliveryAsNew).toHaveBeenCalledWith('s1', 'p1');
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('labels exact Claude-native custody as Queued in Claude', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            metadata: { flavor: 'claude', path: '/repo', host: 'host' },
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    pendingInputInterruptAndRunLocalId: 'p1',
                    pendingInputInterruptAndRunStateAt: 42,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'server-p1',
                text: 'hello',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                localId: 'p1',
                source: 'server_pending',
                pendingDeliveryStatus: 'server_delivering',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:server-p1')?.props.children)
            .toBe('Queued in Claude');
    });

    it('uses the canonical session owner when the hydrated session omits serverId', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        resolvePreferredServerIdForSessionId.mockReturnValue('server-owner');
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            metadata: { flavor: 'claude', path: '/repo', host: 'host' },
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    pendingInputInterruptAndRunLocalId: 'p1',
                    pendingInputInterruptAndRunStateAt: 42,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'server-p1',
                text: 'hello',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                localId: 'p1',
                source: 'server_pending',
                pendingDeliveryStatus: 'server_delivering',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'server-p1');
        await screen.pressByTestIdAsync('pendingMessages.message:server-p1');

        expect(resolvePreferredServerIdForSessionId).toHaveBeenCalledWith('s1');
        expect(screen.findByTestId('pendingMessages.interruptAndRun:server-p1')).toBeTruthy();
    });

    it('keeps generic delivery truthful when Claude custody is not established for the row', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            metadata: { flavor: 'claude', path: '/repo', host: 'host' },
            agentStateVersion: 1,
            agentState: {
                controlledByUser: false,
                capabilities: {
                    pendingInputInterruptAndRunLocalId: 'other-row',
                    pendingInputInterruptAndRunStateAt: 42,
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'server-p1',
                text: 'hello',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                localId: 'p1',
                source: 'server_pending',
                pendingDeliveryStatus: 'server_delivering',
                pendingDeliveryDetail: 'awaiting_acceptance',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:server-p1')?.props.children)
            .toBe('Delivering');
    });

    it('keeps direct send and steer actions available for server-owned queued rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'server_queued',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    function serverPendingRow(id: string): PendingMessage {
        return {
            id,
            text: `text-${id}`,
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: id,
            source: 'server_pending',
            pendingDeliveryStatus: 'server_queued',
            rawRecord: {},
        };
    }

    it('projects canonical active Activity into the visible queued reason for the FIFO head', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        settingValues.sessionPendingQueueDeliveryTiming = 'after_runtime_idle';
        sessionValue = {
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            runtimeActivityState: 'active',
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [serverPendingRow('activity-head')],
            discardedMessages: [],
        }));

        expect(screen.findByTestId(
            'pendingMessages.queuedReason:waiting_for_runtime_activity:activity-head',
        )).toBeTruthy();
    });

    it('does not project a FIFO predecessor wait for a later exact urgent action', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            runtimeActivityState: 'idle',
        };
        const laterUrgent = {
            ...serverPendingRow('urgent-later'),
            requestedAction: { v: 1, kind: 'send_now' } as const,
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [serverPendingRow('predecessor'), laterUrgent],
            discardedMessages: [],
        }));

        expect(screen.findByTestId(
            'pendingMessages.queuedReason:waiting_for_predecessor:urgent-later',
        )).toBeNull();
    });

    it('dispatches a later exact steer target without mutating durable FIFO order', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [serverPendingRow('a'), serverPendingRow('b'), serverPendingRow('c')],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'c');
        await screen.pressByTestIdAsync('pendingMessages.steerNow:c');

        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'c',
            deliveryIntent: 'steer_now',
        }));
    });

    it('targets the canonical local ID when a server projection ID differs', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };
        const projected = {
            ...serverPendingRow('canonical-local-id'),
            id: 'synthetic-projection-id',
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [projected],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'synthetic-projection-id');
        await screen.pressByTestIdAsync('pendingMessages.steerNow:synthetic-projection-id');

        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'canonical-local-id',
            deliveryIntent: 'steer_now',
        }));
    });

    it('does not reprioritize when steer-now targets the head message', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [serverPendingRow('a'), serverPendingRow('b'), serverPendingRow('c')],
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
        modalConfirm.mockResolvedValueOnce(true);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'transcript_committed' });
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [serverPendingRow('a'), serverPendingRow('b'), serverPendingRow('c')],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'c');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:c');

        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'c',
            deliveryIntent: 'interrupt_and_send',
        }));
    });

    it('does not offer removal for a delivering pending row', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'server_delivering',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p1')).toBeNull();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
    });

    it('ignores duplicate remove presses while the confirmation is unresolved', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const confirmDeferred = createDeferred<boolean>();
        modalConfirm.mockReturnValueOnce(confirmDeferred.promise);
        deletePendingMessage.mockResolvedValueOnce(undefined);
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'server_queued',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        const remove = screen.findByTestId('pendingMessages.remove:p1');
        expect(remove).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p1')).toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(remove, 'onPress', undefined, 'pendingMessages.remove:p1');
            invokeTestInstanceHandler(remove, 'onPress', undefined, 'pendingMessages.remove:p1');
            await Promise.resolve();
        });

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).not.toHaveBeenCalled();

        await act(async () => {
            confirmDeferred.resolve(true);
            await confirmDeferred.promise;
            await Promise.resolve();
        });

        expect(deletePendingMessage).toHaveBeenCalledTimes(1);
        expect(deletePendingMessage).toHaveBeenCalledWith('s1', 'p1');
        expect(discardPendingMessage).not.toHaveBeenCalled();
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
                    { id: 'projection-p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'projection-p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        const list = screen.findByType('PendingMessagesDragReorderList');
        await act(async () => {
            invokeTestInstanceHandler(list, 'onReorderIds', ['projection-p2', 'projection-p1'], 'PendingMessagesDragReorderList');
        });

        expect(reorderPendingMessages).toHaveBeenCalledTimes(1);
        expect(reorderPendingMessages).toHaveBeenCalledWith('s1', ['projection-p2', 'projection-p1']);
    });

    it('does not offer or dispatch reorder while any Pending row may have reached the provider', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    {
                        ...serverPendingRow('p1'),
                        pendingDeliveryStatus: 'server_delivering',
                    },
                    serverPendingRow('p2'),
                ],
                discardedMessages: [],
            }));

        const list = screen.findByType('PendingMessagesDragReorderList');
        await act(async () => {
            invokeTestInstanceHandler(list, 'onReorderIds', ['p2', 'p1'], 'PendingMessagesDragReorderList');
        });

        expect(reorderPendingMessages).not.toHaveBeenCalled();
        expect(screen.findByTestId('pendingMessages.reorder:p1')).toBeFalsy();
        expect(screen.findByTestId('pendingMessages.reorder:p2')).toBeFalsy();
    });

    it('shows per-message action icons without hover on web', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        const overlay = screen.findByTestId('pendingMessages.actionsOverlay:p1');
        expect(overlay).toBeTruthy();
        expect(overlay!.props.pointerEvents).toBe('auto');
        expect(screen.findByTestId('pendingMessages.copy:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();
    });

    it('copies the visible pending-message text', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'raw text', displayText: 'visible text', createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.copy:p1');

        expect(setClipboardStringSafe).toHaveBeenCalledWith('visible text');
    });

    it('reports clipboard failures without showing copied feedback', async () => {
        setClipboardStringSafe.mockResolvedValueOnce(false);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.copy:p1');

        expect(modalAlert).toHaveBeenCalledWith(t('common.error'), t('items.failedToCopyToClipboard'));
    });

    it('anchors a pending-message menu to the visible press point', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'x'.repeat(600), displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('pendingMessages.message:p1')!,
                'onPress',
                { nativeEvent: { pageX: 120, pageY: 360 } },
            );
        });

        const menu = screen.findByType('DropdownMenu' as any);
        expect(menu?.props.open).toBe(true);
        expect(menu?.props.popoverAnchor).toEqual({
            kind: 'rect',
            rect: { left: 120, top: 360, height: 1 },
        });
        expect(menu?.props.placement).toBe('auto-vertical');
        expect(menu?.props.matchTriggerWidth).toBe(false);

        await screen.pressByTestIdAsync('pendingMessages.menu.copy:p1');
        expect(setClipboardStringSafe).toHaveBeenCalledWith('x'.repeat(600));
    });

    it('offers steer-now while a steer-capable session is thinking and does not abort the turn', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

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

        const steerNow = screen.findByTestId('pendingMessages.steerNow:p1');
        expect(steerNow).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.steerNow:p1');

        // Lane Q (Q5): the explicit "Steer now" tap executes directly — no redundant confirm.
        expect(modalConfirm).toHaveBeenCalledTimes(0);
        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledTimes(1);
	        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
	            localId: 'p1',
	            deliveryIntent: 'steer_now',
	        }));
        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(discardPendingMessage).toHaveBeenCalledTimes(0);
    });

    it('shows materializing only on the row currently being steered now', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const sendStarted = createDeferred<void>();
        const releaseSend = createDeferred<{ type: 'retry_scheduled'; persistence: 'pending' }>();
        sendPendingMessageNow.mockImplementationOnce(async () => {
            sendStarted.resolve(undefined);
            return await releaseSend.promise;
        });

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'one', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'two', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        const steerNow = screen.findByTestId('pendingMessages.steerNow:p1');
        let pressPromise: Promise<void> = Promise.resolve();
        await act(async () => {
            pressPromise = Promise.resolve(steerNow!.props.onPress());
            await sendStarted.promise;
        });

        expect(screen.findByTestId('pendingMessages.materializingIndicator:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.materializingIndicator:p2')).toBeNull();

        await act(async () => {
            releaseSend.resolve({ type: 'retry_scheduled', persistence: 'pending' });
            await pressPromise;
        });
    });

    it('keeps steering-unavailable capability flags out of delivery-status notices', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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

        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'committed', persistence: 'provider_direct' });
        deletePendingMessage.mockResolvedValueOnce(undefined);

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeNull();

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();

        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(sessionAbort).toHaveBeenCalledTimes(0);
        expect(sendPendingMessageNow).toHaveBeenCalledWith('s1', expect.objectContaining({
            localId: 'p1',
            deliveryIntent: 'interrupt_and_send',
        }));
    });

    it('shows the terminal-draft variant of the notice when the typed pending row is terminal-draft blocked', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeTruthy();
    });

    it('offers a user-confirmed clear-composer action when a terminal draft blocks delivery', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeTruthy();
    });

    it('offers clear-composer when an idle terminal draft blocks pending delivery', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: false,
            active: true,
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
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeTruthy();
    });

    it('keeps typed queued pending rows visually queued despite stale terminal draft capability flags', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: false,
            active: true,
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
            pendingMessages: [{
                id: 'typed-queued',
                text: 'typed queued',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                localId: 'typed-queued',
                source: 'server_pending',
                pendingDeliveryStatus: 'server_queued',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeNull();
        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeNull();
        expect(screen.findByTestId('pendingMessages.blockedDeliveryNotice:typed-queued')).toBeNull();
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:typed-queued')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Pending');
        expect(screen.getTextContent()).not.toContain('Terminal draft is blocking delivery');
    });

    it('ignores a sticky terminal draft capability after the session becomes inactive', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: false,
            active: false,
            presence: 'offline',
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
            pendingMessages: [{
                id: 'p1',
                text: 'hello',
                displayText: undefined,
                createdAt: 0,
                updatedAt: 0,
                localId: 'p1',
                source: 'server_pending',
                pendingDeliveryStatus: 'server_queued',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerBlockedTerminalDraftNotice')).toBeNull();
        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeNull();
    });

    it('does not invoke clear-composer when confirmation is cancelled', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(false);
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(actionExecute).not.toHaveBeenCalled();
    });

    it('invokes the clear-composer session action after confirmation', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        actionExecute.mockResolvedValueOnce({ ok: true, result: { ok: true, status: 'cleared' } });
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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
                },
            },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(actionExecute).toHaveBeenCalledTimes(1);
        expect(actionExecute).toHaveBeenCalledWith(
            'session.terminalComposer.clear',
            { sessionId: 's1', expectedStateAtMs: 42 },
            expect.objectContaining({
                defaultSessionId: 's1',
                surface: 'ui_button',
            }),
        );
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('shows clear-composer as busy while the confirmed action is running', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        const actionStarted = createDeferred<void>();
        const releaseAction = createDeferred<{ ok: true; result: { ok: true; status: 'cleared' } }>();
        actionExecute.mockImplementationOnce(async () => {
            actionStarted.resolve(undefined);
            return await releaseAction.promise;
        });
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        const action = screen.findByTestId('pendingMessages.clearTerminalComposer');
        let pressPromise: Promise<void> = Promise.resolve();
        await act(async () => {
            pressPromise = Promise.resolve(action!.props.onPress());
            await actionStarted.promise;
        });

        expect(screen.findByTestId('pendingMessages.clearTerminalComposerSpinner')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')!.props.accessibilityState).toMatchObject({
            busy: true,
            disabled: true,
        });

        await act(async () => {
            releaseAction.resolve({ ok: true, result: { ok: true, status: 'cleared' } });
            await pressPromise;
        });
    });

    it('surfaces clear-composer unsupported or failure results', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        actionExecute.mockResolvedValueOnce({
            ok: true,
            result: { ok: false, status: 'unsupported', error: 'unsupported' },
        });
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
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
            pendingMessages: [terminalDraftBlockedPendingMessage()],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(modalAlert).toHaveBeenCalledTimes(1);
    });

    it('does not expose steer-now or non-steerable notice for stale terminal thinking', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(130_000);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: 10_000,
            active: true,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 129_000,
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        try {
            expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeNull();

            await hoverPendingMessageRow(screen, 'p1');

            expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('keeps force-send available without steer when the active flag lags a fresh in-progress turn', async () => {
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

            expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
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

            expect(screen.findByTestId('pendingMessages.nonSteerableNotice')).toBeNull();

            await hoverPendingMessageRow(screen, 'p1');

            expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
            expect(sessionAbort).toHaveBeenCalledTimes(0);
        } finally {
            nowSpy.mockRestore();
        }
    });

	    it('does not offer steer-now or send-now for pending rows that failed to decrypt', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        sessionValue = {
	            thinking: true,
                thinkingAt: 1_000,
                active: true,
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

    it('keeps the pending row when send-now is queued for retry', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
        sessionAbort.mockResolvedValueOnce(undefined);
        sendPendingMessageNow.mockResolvedValueOnce({ type: 'retry_scheduled', persistence: 'pending' });

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

    /**
     * D (2026-08-01) — the SEND crossover. A block holding exactly one queued utterance is showing
     * the message that is about to be replaced by its own committed bubble. Two independent
     * clippers used to shrink it — the block's compact scroll cap and the per-message line clamp —
     * and the committed bubble has neither, so the handover measured as a height jump of
     * +16..+136px on native (`.project/reviews/2026-08-01-send-transition/M-send-transition.md` §6,
     * 94.25 → 230 for a 258-char message). Clipping is a property of a QUEUE, not of one utterance.
     */
    describe('send crossover: one queued utterance paints like its committed bubble', () => {
        const LONG_TEXT = 'x'.repeat(400);

        function crossoverSettings() {
            return {
                transcriptPendingQueueMaxHeightPx: 80,
                transcriptPendingQueueExpandedMaxHeightPx: 520,
                transcriptPendingMessageCollapseThresholdChars: 160,
                transcriptPendingMessageCollapsedLines: 2,
            };
        }

        function longPendingMessage(id: string, createdAt: number) {
            return { id, text: LONG_TEXT, displayText: undefined, createdAt, updatedAt: createdAt, localId: id, rawRecord: {} };
        }

        it('does not clip a single long queued utterance', async () => {
            settingValues = crossoverSettings();
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [longPendingMessage('p1', 0)],
                discardedMessages: [],
            }));

            const scroll = screen.findByTestId('pendingMessages.scroll');
            expect(scroll!.props.style?.maxHeight).toBeUndefined();
            // The committed bubble renders markdown; a clipped preview renders plain clamped text.
            expect(screen.findByType('MarkdownView' as any)).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.viewMore:p1')).toBeNull();

            // Learning that the content overflows the compact bound must not re-clip it, and must
            // not offer an expand affordance for content that is already fully painted.
            await act(async () => {
                scroll!.props.onContentSizeChange(0, 400);
            });
            expect(screen.findByTestId('pendingMessages.scroll')!.props.style?.maxHeight).toBeUndefined();
            expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();

            // The delivery affordance the user reads is unchanged by any of this.
            expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:p1')).toBeTruthy();
        });

        it('still clips the block as soon as a second row shares it', async () => {
            settingValues = crossoverSettings();
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [longPendingMessage('p1', 0), longPendingMessage('p2', 1)],
                discardedMessages: [],
            }));

            expect(screen.findByTestId('pendingMessages.scroll')!.props.style?.maxHeight).toBe(80);
            expect(screen.findByTestId('pendingMessages.viewMore:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.viewMore:p2')).toBeTruthy();
        });
    });

    /**
     * A QUEUE — two or more rows. One row is the send crossover and is deliberately unclipped; see
     * the `send crossover` describe above and `pendingQueueContentClipping`.
     */
    function queuedPendingMessages() {
        return [
            { id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
            { id: 'p2', text: 'world', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
        ];
    }

    it('uses an 80px default max-height for the pending queue block', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
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
                pendingMessages: queuedPendingMessages(),
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
        expect(screen.findByProps({ name: 'caret-up' })).toBeTruthy();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('does not show a header toggle when pending content fits the compact height', async () => {
        settingValues = { transcriptPendingQueueMaxHeightPx: 80 };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 72);
        });

        expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('expands the pending queue from the header toggle without changing the compact default', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 160);
        });

        await screen.pressByTestIdAsync('pendingMessages.headerToggle');

        expect(screen.findByProps({ name: 'caret-down' })).toBeTruthy();
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
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 160);
        });
        await screen.pressByTestIdAsync('pendingMessages.headerToggle');
        await screen.pressByTestIdAsync('pendingMessages.headerToggle');

        expect(screen.findByProps({ name: 'caret-up' })).toBeTruthy();
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(80);
    });

    it('resets expanded pending queue state after all pending rows clear', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const firstQueue = queuedPendingMessages();
        const secondQueue = [
            { id: 'p3', text: 'again', displayText: undefined, createdAt: 2, updatedAt: 2, localId: 'p3', rawRecord: {} },
            { id: 'p4', text: 'and again', displayText: undefined, createdAt: 3, updatedAt: 3, localId: 'p4', rawRecord: {} },
        ];
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: firstQueue,
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
            pendingMessages: secondQueue,
            discardedMessages: [],
        }));
        const nextScroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            nextScroll!.props.onContentSizeChange(0, 160);
        });

        expect(screen.findByProps({ name: 'caret-up' })).toBeTruthy();
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
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:p1')).toBeTruthy();
    });

    it('never renders Not sent when a retained durable Pending row has stale local failure state', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'p1',
                text: 'hello',
                createdAt: 0,
                updatedAt: 0,
                localId: 'p1',
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'server_queued',
                sendState: 'failed',
                rawRecord: {},
            }],
            discardedMessages: [],
        }));

        expect(screen.getTextContent()).toContain('Waiting for the runtime to reconnect');
        expect(screen.getTextContent()).not.toContain('Not sent');
        expect(screen.findByTestId('pendingMessages.sendFailedNotice:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.message:p1')?.props.accessibilityLabel).toContain('Waiting');
    });

    it('renders uncertain delivery from both current effect-possible blocked reasons', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                {
                    id: 'delayed',
                    text: 'delayed',
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'delayed',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
                    rawRecord: {},
                },
                {
                    id: 'uncertain',
                    text: 'uncertain',
                    createdAt: 1,
                    updatedAt: 1,
                    localId: 'uncertain',
                    source: 'server_pending',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'ambiguous_terminal_delivery',
                    rawRecord: {},
                },
            ],
            discardedMessages: [],
        }));

        expect(screen.getTextContent()).toContain('Delivery state uncertain');
        expect(screen.getTextContent()).not.toContain('Confirmation delayed');
        expect(screen.getTextContent()).not.toContain('Not sent');
        expect(screen.findByTestId('pendingMessages.message:delayed')?.props.accessibilityLabel)
            .toContain('Delivery state uncertain');
        expect(screen.findByTestId('pendingMessages.message:uncertain')?.props.accessibilityLabel)
            .toContain('Delivery state uncertain');
    });

    it('does not expose legacy send or steer actions for server-accepted pending rows', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'local_outbound',
                    deliveryStatus: 'accepted',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
    });

    it('keeps a durable outbox enqueue on retry-or-remove actions until its exact envelope settles', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };
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

    it('lets durable acceptance ambiguity override stale client delivery metadata', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: true,
            thinkingAt: Date.now(),
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'accepted blocked',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'server_pending',
                    deliveryStatus: 'accepted',
                    pendingDeliveryStatus: 'blocked',
                    pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.retryDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.edit:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
    });

    it('shows a saving indicator for local outbound rows that are still being persisted', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{
                    id: 'p1',
                    text: 'hello',
                    displayText: undefined,
                    createdAt: 0,
                    updatedAt: 0,
                    localId: 'p1',
                    source: 'local_outbound',
                    deliveryStatus: 'queued',
                    rawRecord: {},
                }],
                discardedMessages: [],
            }));

        expect(screen.findByTestId('pendingMessages.savingIndicator:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.acceptedIndicator:p1')).toBeNull();
    });

    it('shows discarded action icons without hover on web', async () => {
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
        expect(overlay!.props.pointerEvents).toBe('auto');
        expect(screen.findByTestId('pendingMessages.discarded.copy:d1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.discarded.remove:d1')).toBeTruthy();
    });

    it('copies discarded pending-message text', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [],
            discardedMessages: [
                { id: 'd1', text: 'discarded raw', displayText: 'discarded visible', createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason: 'manual', localId: 'd1', rawRecord: {} },
            ],
        }));

        await screen.pressByTestIdAsync('pendingMessages.discarded.copy:d1');

        expect(setClipboardStringSafe).toHaveBeenCalledWith('discarded visible');
    });

    it('anchors a discarded-message menu to the visible press point', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [],
            discardedMessages: [
                { id: 'd1', text: 'x'.repeat(600), displayText: undefined, createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason: 'manual', localId: 'd1', rawRecord: {} },
            ],
        }));

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('pendingMessages.discarded.message:d1')!,
                'onPress',
                { nativeEvent: { pageX: 200, pageY: 420 } },
            );
        });

        const menu = screen.findByType('DropdownMenu' as any);
        expect(menu?.props.open).toBe(true);
        expect(menu?.props.popoverAnchor).toEqual({
            kind: 'rect',
            rect: { left: 200, top: 420, height: 1 },
        });
        expect(menu?.props.placement).toBe('auto-vertical');
        expect(menu?.props.matchTriggerWidth).toBe(false);

        await screen.pressByTestIdAsync('pendingMessages.discarded.menu.copy:d1');
        expect(setClipboardStringSafe).toHaveBeenCalledWith('x'.repeat(600));
    });

    it('renders system-discarded tombstones with their reason and a remove action', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [],
                discardedMessages: [
                    {
                        id: 'd1',
                        text: 'runtime-switched message',
                        displayText: undefined,
                        createdAt: 0,
                        updatedAt: 0,
                        discardedAt: 1,
                        discardedReason: 'switch_to_local',
                        localId: 'd1',
                        rawRecord: {},
                    },
                ],
            }));

        expect(screen.findByTestId('pendingMessages.discarded.reason:d1')?.props.children).toBe('switch_to_local');

        await hoverDiscardedMessageRow(screen, 'd1');

        expect(screen.findByTestId('pendingMessages.discarded.remove:d1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.discarded.requeue:d1')).toBeTruthy();
    });

    it('keeps pending status chips visible while hovering another message on web', async () => {
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
        expect(flattenStyle(chipP2After!.props.style).opacity).not.toBe(0);
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
        expect((reorderHandle!.props as any).pointerEvents).toBe('none');
        expect(flattenStyle((reorderHandle!.props as any).style).pointerEvents).toBeUndefined();
    });
});
