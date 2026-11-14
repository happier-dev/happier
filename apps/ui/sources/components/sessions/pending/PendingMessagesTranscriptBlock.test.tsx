import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { resolvePendingMessagesPresentationByRecipient } from './pendingMessageVisualState';
import { installPendingMessagesCommonModuleMocks } from './pendingMessagesTestHelpers';
import { resolvePendingQueueHeadMaxHeightPx } from './pendingQueueContentClipping';

/** `transcriptMarkdownTextStyle.lineHeight` in the test theme. */
const LINE_PX = 24;
/** The head stays fully visible; the collapsed backlog scrolls in the compact strip beneath it. */
const QUEUE_CAP_PX = resolvePendingQueueHeadMaxHeightPx(LINE_PX) + 80;


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function loadPendingMessagesTranscriptBlock() {
    return PendingMessagesTranscriptBlockAtHome;
}

/** Every product host renders the block at its Session's exact Home; unnamed renders use the active one. */
function PendingMessagesTranscriptBlockAtHome(props: React.ComponentProps<typeof PendingMessagesTranscriptBlockComponent>) {
    return React.createElement(PendingMessagesTranscriptBlockComponent, { serverId: 'home-a', ...props });
}

/**
 * A send/steer press asks the one retained-input Action for the viewer's exact Home. What happens to
 * the row after the delivery settles belongs to that Action (`sync/ops/actions/pendingSendNow.test.ts`).
 */
function expectSendNowAction(input: Readonly<Record<string, unknown>>, sessionId = 's1', serverId = 'home-a') {
    expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.sendNow',
        expect.objectContaining({ sessionId, serverId, ...input }),
        expect.objectContaining({ surface: 'ui', authority: 'present_user', serverId }));
}

vi.mock('./PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: (props: any) => {
        const children = Array.isArray(props.messages)
            ? props.messages.map((m: any, index: number) =>
                props.renderItem({
                    message: m,
                    index,
                    isDragging: false,
                    renderDragHandle: ({ testID, accessibilityLabel }: { testID?: string; accessibilityLabel?: string }) => React.createElement('View', { testID, accessibilityLabel }),
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
const resolvePendingDeliveryLabelKeyForSession = vi.hoisted(() => vi.fn());
const resolvePendingDeliveryTransientActionForSession = vi.hoisted(() => vi.fn());
const writeClipboardText = vi.fn(async (_value: string) => {});
const serverFeaturesSnapshotState = vi.hoisted(() => ({
    current: { status: 'loading' } as any,
}));

let sessionValue: any = null;
let settingValues: Record<string, unknown> = {};

installPendingMessagesCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSession: () => sessionValue,
            useActiveServerAccountScope: () => ({ serverId: 'home-a', accountId: 'account-a' }),
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

// Install the suite's boundary fixtures before import, and charge cold transforms to collection.
const { PendingMessagesTranscriptBlock: PendingMessagesTranscriptBlockComponent } = await import('./PendingMessagesTranscriptBlock');

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
    useLayoutMaxWidth: () => 800,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 800 }),
}));

describe('PendingMessagesTranscriptBlock', () => {
    beforeEach(async () => {
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
        resolvePreferredServerIdForSessionId.mockReturnValue('home-a');
        // The row actions act for the viewer's exact Account; the real store owns the active scope.
        (await import('@/sync/domains/state/storageStore')).storage.getState()
            .activateProfileScope({ serverId: 'home-a', accountId: 'account-a' });
        resolvePendingDeliveryLabelKeyForSession.mockReset();
        resolvePendingDeliveryLabelKeyForSession.mockReturnValue(null);
        resolvePendingDeliveryTransientActionForSession.mockReset();
        resolvePendingDeliveryTransientActionForSession.mockReturnValue(null);
        writeClipboardText.mockReset();
        writeClipboardText.mockResolvedValue(undefined);
        installBrowserClipboardBoundary(writeClipboardText);
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

    it('presents a retained resume refusal as failed with its own cause', async () => {
        const errorDetail = { kind: 'connected_service_resume_unreachable', continuityErrorCode: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity', agentId: 'gemini', reason: 'gemini_resume_unreachable', uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity', source: 'spawn_resume', agentId: 'gemini', retryable: false, suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account', 'open_connected_accounts'], diagnostics: { reason: 'gemini_resume_unreachable' } } } as const;
        const message = { ...queuedMessage('resume', 1), discardedAt: 2, discardedReason: 'resume_failed' as const, pendingFailure: { code: 'resume_failed' as const, errorDetail } };
        const Component = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(Component, { sessionId: 's1', pendingMessages: [], discardedMessages: [message] }));
        const renderedText = screen.findByTestId('pendingMessages.discarded.message:resume')?.findAll(node => node.type === 'Text').flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
        expect(renderedText).toContain(t('session.pendingMessages.errors.sendFailed'));
        expect(renderedText).not.toContain(t('session.pendingMessages.discarded.label'));
        expect(renderedText).toContain(t('connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume'));
    });

    it.each([undefined, { kind: 'execution_run' as const, runId: 'run-a' }])('keeps main Pending presentation isolated from a Run row for recipient %j', async (recipient) => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            recipient,
            pendingMessages: [
                queuedMessage('main', 1),
                { ...queuedMessage('run', 2), recipient: { kind: 'execution_run', runId: 'run-a' } },
            ],
            discardedMessages: [],
        }));
        expect(screen.findAllByTestId('pendingMessages.row:main')).toHaveLength(recipient ? 0 : 1);
        expect(screen.findAllByTestId('pendingMessages.row:run')).toHaveLength(recipient ? 1 : 0);
    });

    it('delegates send-now interrupt intent to the retained-input Action', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(true);
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
        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expectSendNowAction({ localId: 'canonical-local-p1', deliveryIntent: 'interrupt_and_send' });
        // The press never writes the queue itself; the Action owns the row after the commit.
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
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

    it('does not describe resuming a running session whose live presence is not yet observed (fresh client)', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValueOnce(false);
        sessionValue = { active: true, presence: undefined, thinking: false };

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expect(modalConfirm).toHaveBeenCalledWith(
            t('session.pendingMessages.sendConfirm.title'),
            t('session.pendingMessages.sendConfirm.body'),
            { confirmText: t('session.pendingMessages.actions.sendNow') },
        );
    });

    it('leaves inactive managed held input to the existing wake recovery control', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = { active: false, presence: 'offline', thinking: false };
        const message = { ...queuedMessage('held', 0), source: 'server_pending' as const,
            pendingDeliveryStatus: 'server_queued' as const, pendingActivationHoldReason: 'resume_not_requested' as const };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', pendingMessages: [message], discardedMessages: [],
        }));
        await hoverPendingMessageRow(screen, 'held');
        expect(screen.findByTestId('pendingMessages.sendNow:held')).toBeNull();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        sessionValue = { active: true, presence: 'online', thinking: false };
        await screen.update(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', pendingMessages: [message], discardedMessages: [],
        }));
        await hoverPendingMessageRow(screen, 'held');
        expect(screen.findByTestId('pendingMessages.sendNow:held')).toBeTruthy();
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

    // Provider-acceptance-pending, transcript-only and retry outcomes keep the row at the Action owner:
    // `sync/ops/actions/pendingSendNow.test.ts` ("keeps the row when …").

    it('renders a per-message pending affordance label', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        expect(screen.findByTestId('pendingMessages.pendingAffordance:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:p1')).toBeTruthy();
    });

    it('paints several queued updates from one worker as one counted notice without touching the queue', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
        const followed = (id: string, createdAt: number, sourceSessionId: string): PendingMessage => ({
            ...queuedMessage(id, createdAt),
            pendingHostFollowInput: SessionFollowInputV1Schema.parse({
                v: 1, delivery: 'next_turn',
                original: { sourceSessionId, sourceTurn: { id: `turn-${id}`, status: 'completed' } },
                event: { kind: 'finished' },
            }),
        });
        const pendingMessages = [followed('a1', 1, 'worker-a'), followed('b1', 2, 'worker-b'), followed('a2', 3, 'worker-a'), followed('a3', 4, 'worker-a')];
        const screen = await renderScreen(React.createElement(AppSessionTranscriptSourceProvider, { sessionId: 's1',
            children: React.createElement(PendingMessagesTranscriptBlock, { sessionId: 's1', pendingMessages, discardedMessages: [] }) }));
        expect(['a1', 'b1', 'a2', 'a3'].map((id) => screen.findAllByTestId(`pendingMessages.row:${id}`).length)).toEqual([1, 1, 0, 0]);
        expect(screen.getTextContent()).toContain(t('sessionWork.workerUpdate.updateCount', { count: 3 }));
        expect(screen.getTextContent()).not.toContain(t('sessionWork.workerUpdate.updateCount', { count: 4 }));
        expect(renderedPendingOrder(screen)).toEqual(['a1', 'b1', 'a2', 'a3']);
    });

    it('exposes pending and discarded rows by their message-specific accessible names', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [
                { id: 'p1', text: 'first queued instruction', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                { id: 'p2', text: 'second queued instruction', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
            ],
            discardedMessages: [
                { id: 'd1', text: 'first discarded instruction', displayText: undefined, createdAt: 0, updatedAt: 0, discardedAt: 1, discardedReason: 'manual', localId: 'd1', rawRecord: {} },
                { id: 'd2', text: 'second discarded instruction', displayText: undefined, createdAt: 1, updatedAt: 1, discardedAt: 2, discardedReason: 'manual', localId: 'd2', rawRecord: {} },
            ],
        }));

        const pendingFirst = screen.findByTestId('pendingMessages.message:p1')?.props.accessibilityLabel;
        const pendingSecond = screen.findByTestId('pendingMessages.message:p2')?.props.accessibilityLabel;
        const discardedFirst = screen.findByTestId('pendingMessages.discarded.message:d1')?.props.accessibilityLabel;
        const discardedSecond = screen.findByTestId('pendingMessages.discarded.message:d2')?.props.accessibilityLabel;

        expect(pendingFirst).toContain('first queued instruction');
        expect(pendingSecond).toContain('second queued instruction');
        expect(discardedFirst).toContain('first discarded instruction');
        expect(discardedSecond).toContain('second discarded instruction');
        expect(pendingFirst).not.toBe(pendingSecond);
        expect(discardedFirst).not.toBe(discardedSecond);
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

    it('titles the queue with its count, so queued messages never read as delivered ones (owner 11-10)', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    { id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
                    { id: 'p2', text: 'world', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
                ],
                discardedMessages: [],
            }));

        const label = screen.findByTestId('pendingMessages.headerLabel');
        expect(label).toBeTruthy();
        expect(screen.getTextContent()).toContain('(2)');
        // A queue that fits its bound has nothing to expand.
        expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();
    });

    it('passes the main Session queue to the shared semantic reorder binding', async () => {
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
        expect(list.props.sessionId).toBe('s1');
        expect(list.props.recipient).toBeNull();
        expect(list.props.onReorderIds).toBeUndefined();
    });

    it('keeps pending remove and send-now on the mounted exact Home', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        modalConfirm.mockResolvedValue(true);
        (await import('@/sync/domains/state/storageStore')).storage.getState()
            .activateProfileScope({ serverId: 'home-b', accountId: 'account-b' });
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            serverId: 'home-b',
            sessionId: 'same-session',
            pendingMessages: [
                queuedMessage('p1', 1),
                queuedMessage('p2', 2),
            ],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.remove:p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p2');

        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.withdraw',
            expect.objectContaining({ sessionId: 'same-session', localId: 'p1', serverId: 'home-b' }),
            expect.objectContaining({ serverId: 'home-b', expectedAccountId: 'account-b' }));
        expectSendNowAction({ localId: 'p2', deliveryIntent: 'interrupt_and_send' }, 'same-session', 'home-b');
    });

    it('keeps a queued row\'s actions in their band and reveals them on hover, like a committed message', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        // A hidden slot is not clickable: the shared reveal says so through the prop or, on web, its style.
        const overlayPointerEvents = () => {
            const overlay = screen.findHostByTestId('pendingMessages.actionsOverlay:p1')!;
            return overlay.props.pointerEvents ?? flattenStyle(overlay.props.style).pointerEvents;
        };
        expect(overlayPointerEvents()).toBe('none');
        expect(screen.findByTestId('pendingMessages.copy:p1')).toBeTruthy();
        await act(async () => {
            screen.findHostByTestId('pendingMessages.row:p1')!.props.onPointerEnter();
        });
        expect(overlayPointerEvents()).toBe('auto');

        const remove = screen.findByTestId('pendingMessages.remove:p1');
        expect(remove).toBeTruthy();
        expect(remove!.props.disabled).not.toBe(true);
        await act(async () => {
            screen.findHostByTestId('pendingMessages.row:p1')!.props.onPointerLeave();
        });
        expect(overlayPointerEvents()).toBe('none');
    });

    it('copies the visible pending-message text', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'raw text', displayText: 'visible text', createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        await screen.pressByTestIdAsync('pendingMessages.copy:p1');

        expect(writeClipboardText).toHaveBeenCalledWith('visible text');
    });

    it('reports clipboard failures', async () => {
        writeClipboardText.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'));
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
        expect(writeClipboardText).toHaveBeenCalledWith('x'.repeat(600));
    });

    it('sends steer-now directly while a steer-capable session is thinking and does not abort the turn', async () => {
	        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
	        sessionValue = createFreshSteerCapableSession();

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
        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expectSendNowAction({ localId: 'canonical-local-p1', deliveryIntent: 'steer_now' });
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
        expectSendNowAction({ localId: 'c', deliveryIntent: 'steer_now' });
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
        expectSendNowAction({ localId: 'a', deliveryIntent: 'steer_now' });
    });

    it('dispatches a later exact send-now target without mutating durable FIFO order', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        modalConfirm.mockResolvedValueOnce(true);

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
        expectSendNowAction({ localId: 'c', deliveryIntent: 'interrupt_and_send' });
    });

    it('preserves durable FIFO order when the send-now action fails', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        modalConfirm.mockResolvedValueOnce(true);
        executeDefaultAction.mockResolvedValueOnce({ ok: false, errorCode: 'send_failed', error: 'send-now action failed' });

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
        expectSendNowAction({ localId: 'c', deliveryIntent: 'interrupt_and_send' });
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalledTimes(1);
    });

    it('sends discarded steer-now directly without confirmation', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
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
        // The discarded row's retirement after the commit is the Action owner's (pendingSendNow.test.ts).
        expectSendNowAction({ localId: 'canonical-local-d1', deliveryIntent: 'steer_now' });
        expect(deleteDiscardedPendingMessage).not.toHaveBeenCalled();
    });

    it.each(['dismissed_uncertain', 'resent_as_new'] as const)(
        'keeps %s uncertainty tombstones visible but non-mutating',
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
            expect(screen.findByTestId('pendingMessages.discarded.copy:d1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.discarded.requeue:d1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.discarded.remove:d1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.discarded.steerNow:d1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.discarded.sendNow:d1')).toBeNull();

            await act(async () => {
                invokeTestInstanceHandler(
                    screen.findByTestId('pendingMessages.discarded.message:d1')!,
                    'onPress',
                    { nativeEvent: { pageX: 180, pageY: 400 } },
                );
            });
            await screen.pressByTestIdAsync('pendingMessages.discarded.menu.copy:d1');
            expect(writeClipboardText).toHaveBeenCalledWith('archived uncertainty');
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

    it('uses canonical input readiness when an inactive runtime retains an in-progress turn', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(130_000);
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = {
            thinking: false,
            active: false,
            activeAt: 100_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 129_500,
            agentStateVersion: 0,
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

            // An inactive runtime is not running, so it offers no in-flight steering to explain.
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

            await hoverPendingMessageRow(screen, 'p1');

            expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.edit:p1')).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();
        } finally {
            nowSpy.mockRestore();
        }
    });


    /**
     * CALM-1110: a blocked row states its reason as one line of meta in its own status row ("Blocked ·
     * reason"), never as a separate bordered notice, so no delivery state can change the row's height.
     */
    it('states a blocked reason inside the status row, in one line, and paints no separate notice', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const row = (overrides: Partial<PendingMessage>): PendingMessage => ({
            id: 'p1',
            localId: 'p1',
            text: 'hello',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            ...overrides,
        } as PendingMessage);

        const cases: readonly Readonly<{ blocked: boolean; message: PendingMessage }>[] = [
            { blocked: false, message: row({ pendingDeliveryStatus: 'server_queued' }) },
            { blocked: false, message: row({ pendingDeliveryStatus: 'server_delivering' }) },
            { blocked: false, message: row({ source: 'local_outbound' }) },
            { blocked: false, message: row({ source: 'local_outbound', sendState: 'failed' }) },
            { blocked: true, message: row({ pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance' }) },
        ];

        for (const { blocked, message } of cases) {
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [message],
                discardedMessages: [],
            }));
            const label = JSON.stringify(message.pendingDeliveryStatus ?? message.sendState ?? message.source);
            expect(screen.findByTestId('pendingMessages.blockedDeliveryNotice:p1'), label).toBeNull();
            const reason = screen.findByTestId('pendingMessages.blockedDeliveryReason:p1');
            expect(reason !== null, label).toBe(blocked);
            if (!reason) continue;
            const affordance = screen.findByTestId('pendingMessages.pendingAffordance:p1')!;
            expect(affordance.findAll(node => node === reason)).toHaveLength(1);
            expect(reason.props.numberOfLines).toBe(1);
            const reasonText = t('session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance');
            expect(String(affordance.props.accessibilityLabel)).toContain(reasonText);
        }
    });

    it('gives a launch-owned first message no second writer and settles a refusal on the row with its draft', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const { t } = await import('@/text');
        const launchRow = (pendingLaunch: PendingMessage['pendingLaunch']): PendingMessage => ({
            id: 'first-turn', localId: 'first-turn', text: 'Start here', createdAt: 0, updatedAt: 0, rawRecord: {},
            source: 'local_outbound', pendingLaunch,
        });
        const menuIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType('DropdownMenuItem')
            .map(item => String(item.props.testID ?? item.props.title));

        const starting = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', serverId: 'home-a', pendingMessages: [launchRow({ state: 'starting' })], discardedMessages: [],
        }));
        expect(starting.findByTestId('pendingMessages.startingIndicator:first-turn')).toBeTruthy();
        expect(starting.findByTestId('pendingMessages.pendingAffordanceLabel:first-turn')?.props.children).toBe(t('newSession.startingSession'));
        await hoverPendingMessageRow(starting, 'first-turn');
        for (const control of ['retrySend', 'remove', 'sendNow', 'reorder', 'openDraft']) {
            expect(starting.findByTestId(`pendingMessages.${control}:first-turn`), control).toBeNull();
        }
        await starting.pressByTestIdAsync('pendingMessages.message:first-turn');
        expect(menuIds(starting)).toEqual(['pendingMessages.menu.copy:first-turn']);

        const failed = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', serverId: 'home-a', discardedMessages: [],
            pendingMessages: [launchRow({ state: 'failed', message: 'The selected model is unavailable.', draftId: 'draft-1' })],
        }));
        expect(failed.findByTestId('pendingMessages.pendingAffordanceLabel:first-turn')?.props.children)
            .toBe(t('session.pendingMessages.deliveryStatus.notStarted'));
        expect(failed.findByTestId('pendingMessages.blockedDeliveryReason:first-turn')?.props.children)
            .toBe('The selected model is unavailable.');
        expect(failed.findByTestId('pendingMessages.openDraft:first-turn')).toBeTruthy();
        expect(failed.findByTestId('pendingMessages.retrySend:first-turn')).toBeNull();
        await failed.pressByTestIdAsync('pendingMessages.message:first-turn');
        expect(menuIds(failed)).toEqual(['pendingMessages.menu.copy:first-turn', 'pendingMessages.menu.openDraft:first-turn']);
        // Open draft is the public `session.draft.open` Action agents reach too, never a private route push.
        await failed.pressByTestIdAsync('pendingMessages.openDraft:first-turn');
        await vi.waitFor(() => expect(executeDefaultAction).toHaveBeenCalledWith('session.draft.open', { draftId: 'draft-1' },
            expect.objectContaining({ surface: 'ui', serverId: 'home-a' })));
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
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
            serverId: 'home-a',
            pendingMessages: [pendingMessage],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.blockedDeliveryReason:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.retryDelivery:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();

        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pendingMessages.markDeliveryHandled:p1');
        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.markHandled',
            expect.objectContaining({ sessionId: 's1', localId: 'p1' }),
            expect.objectContaining({ surface: 'ui', expectedAccountId: 'account-a' }));
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
    });

    it('splits the action row gap between neighbouring touch targets, so Mark handled never lands on Remove', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const { layoutHitArea, hitAreaOverlap } = await import('@/dev/testkit/harness/hitFrameReach');
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        const pendingMessage = {
            id: 'p1', localId: 'p1', text: 'blocked delivery', displayText: undefined, createdAt: 0, updatedAt: 0,
            rawRecord: {}, source: 'server_pending', pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        } as PendingMessage;
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <PendingMessagesTranscriptBlock sessionId="s1" serverId="home-a" pendingMessages={[pendingMessage]} discardedMessages={[]} />
            </HappierUiPlatformProvider>,
        );
        await hoverPendingMessageRow(screen, 'p1');
        const row = flattenStyle(screen.findHostByTestId('pendingMessages.actionsOverlay:p1')!.props.style);
        const drawn = { width: 18, height: 18 };
        const markHandled = await layoutHitArea(() => screen.findHostByTestId('pendingMessages.markDeliveryHandled:p1'), drawn);
        const remove = await layoutHitArea(() => screen.findHostByTestId('pendingMessages.remove:p1'), drawn);
        // Neighbours meet halfway across the row's real gap; the destructive Remove never takes Mark handled's side.
        expect(hitAreaOverlap(markHandled, remove, { axis: 'horizontal', gap: Number(row.gap) })).toBe(0);
        // Above the row is the message's own press target: each action reaches only half the gap to it.
        expect(markHandled.insets.top).toBeLessThanOrEqual(Number(row.marginTop) / 2);
        expect(remove.insets.top).toBeLessThanOrEqual(Number(row.marginTop) / 2);
        // The band leaves enough room that each small action still meets the 24 px pointer floor (WCAG 2.5.8).
        for (const area of [markHandled, remove]) {
            expect(drawn.width + area.insets.left + area.insets.right).toBeGreaterThanOrEqual(24);
            expect(drawn.height + area.insets.top + area.insets.bottom).toBeGreaterThanOrEqual(24);
        }
    });

    it.each([
        // An effect may already have started, so this reason gets its own sentence instead of the
        // generic `unknown` label ("Delivery status needs review"), which reads like nothing was sent.
        ['delivery_outcome_uncertain', 'This may already have reached the agent — check before resending'],
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
            pendingRecovery: { canSendAsNew: true },
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            serverId: 'home-a',
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

        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.markHandled',
            expect.objectContaining({ sessionId: 's1', localId: 'p1' }), expect.objectContaining({ surface: 'ui' }));
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();
    });

    it.each([true, false])('uses projected Send as new eligibility on the uncertain row and its menu (%s)', async canSendAsNew => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const pendingMessage: PendingMessage = {
            id: 'reply-custody', localId: 'reply-custody', text: 'uncertain original',
            createdAt: 0, updatedAt: 0, rawRecord: {}, source: 'server_pending',
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
            pendingRecovery: { canSendAsNew },
        };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', serverId: 'home-a', pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await hoverPendingMessageRow(screen, pendingMessage.id);
        expect(Boolean(screen.findByTestId('pendingMessages.sendAsNew:reply-custody'))).toBe(canSendAsNew);
        expect(screen.findByTestId('pendingMessages.dismissDelivery:reply-custody')).toBeTruthy();
        await screen.pressByTestIdAsync('pendingMessages.message:reply-custody');
        const menuItems = screen.findAllByType('DropdownMenuItem');
        expect(menuItems.some(item => item.props.testID === 'pendingMessages.sendAsNew:reply-custody')).toBe(canSendAsNew);
        expect(menuItems.some(item => item.props.testID === 'pendingMessages.dismissDelivery:reply-custody')).toBe(true);
    });

    it.each([undefined, { kind: 'execution_run' as const, runId: 'run-a' }])('dismisses or sends an uncertain delivery as a new identity without retrying the original (%j)', async recipient => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        dismissPendingDelivery.mockResolvedValueOnce(undefined);
        sendPendingDeliveryAsNew.mockResolvedValueOnce(undefined);
        const pendingMessage: PendingMessage = {
            id: 'p1', localId: 'wire-local', recipient, text: 'uncertain delivery', displayText: undefined,
            createdAt: 0, updatedAt: 0, rawRecord: {}, source: 'server_pending',
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
            pendingRecovery: { canSendAsNew: true },
        } as PendingMessage;

        const dismissScreen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', serverId: 'home-a', recipient, pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await dismissScreen.pressByTestIdAsync('pendingMessages.message:p1');
        await dismissScreen.pressByTestIdAsync('pendingMessages.dismissDelivery:p1');
        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.dismiss',
            expect.objectContaining({ sessionId: 's1', localId: 'wire-local', ...(recipient ? { targetExecutionRunId: recipient.runId } : {}) }),
            expect.objectContaining({ surface: 'ui', serverId: 'home-a', expectedAccountId: 'account-a' }));
        expect(dismissPendingDelivery).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();

        const sendScreen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', serverId: 'home-a', recipient, pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await sendScreen.pressByTestIdAsync('pendingMessages.message:p1');
        await sendScreen.pressByTestIdAsync('pendingMessages.sendAsNew:p1');
        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.sendAsNew',
            expect.objectContaining({ sessionId: 's1', localId: 'wire-local', ...(recipient ? { targetExecutionRunId: recipient.runId } : {}) }),
            expect.objectContaining({ surface: 'ui', serverId: 'home-a', expectedAccountId: 'account-a' }));
        expect(sendPendingDeliveryAsNew).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('keeps canceled recovery quiet and retains the original Pending row', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        executeDefaultAction.mockResolvedValueOnce({ ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' });
        const pendingMessage: PendingMessage = {
            id: 'p1', localId: 'p1', text: 'uncertain delivery', createdAt: 0, updatedAt: 0,
            rawRecord: {}, source: 'server_pending', pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
        };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', serverId: 'home-a', pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await screen.pressByTestIdAsync('pendingMessages.message:p1');
        await screen.pressByTestIdAsync('pendingMessages.dismissDelivery:p1');
        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.dismiss', expect.anything(), expect.anything());
        expect(dismissPendingDelivery).not.toHaveBeenCalled();
        expect(modalAlert).not.toHaveBeenCalled();
        expect(screen.findByTestId('pendingMessages.row:p1')).toBeTruthy();
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

    it('ignores duplicate mark-handled presses while the Action is unresolved', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const actionDeferred = createDeferred<unknown>();
        executeDefaultAction.mockReturnValueOnce(actionDeferred.promise);
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
            serverId: 'home-a',
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

        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();

        await act(async () => {
            actionDeferred.resolve({ ok: true, result: { ok: true } });
            await actionDeferred.promise;
            await Promise.resolve();
        });

        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
    });

    it('offers only duplicate-safe send-as-new recovery for a server-delivering row', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        sendPendingDeliveryAsNew.mockResolvedValueOnce(undefined);
        modalConfirm.mockResolvedValueOnce(true);

        const pendingMessage: PendingMessage = {
            id: 'p-delivering',
            localId: 'p-delivering',
            text: 'delivering delivery',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            rawRecord: {},
            source: 'server_pending',
            pendingDeliveryStatus: 'server_delivering',
            pendingRecovery: { canSendAsNew: true },
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            serverId: 'home-a',
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
        expect(screen.findByTestId('pendingMessages.deliveringIndicator:p-delivering')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.retryDelivery:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.discardDelivery:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendAsNew:p-delivering')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.edit:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.steerNow:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p-delivering')).toBeNull();
        expect(screen.findByTestId('pendingMessages.reorder:p-delivering')).toBeNull();

        expect(deletePendingMessage).not.toHaveBeenCalled();
        expect(discardPendingMessage).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
        expect(sessionAbort).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pendingMessages.sendAsNew:p-delivering');
        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.sendAsNew',
            expect.objectContaining({ sessionId: 's1', localId: 'p-delivering' }), expect.objectContaining({ surface: 'ui' }));
        expect(sendPendingDeliveryAsNew).not.toHaveBeenCalled();
        expect(sendPendingMessageNow).not.toHaveBeenCalled();
    });

    it('keeps an external-handoff row visible without mutation actions', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        const pendingMessage = {
            id: 'p-handoff', localId: 'p-handoff', text: 'external handoff', displayText: undefined,
            createdAt: 0, updatedAt: 0, rawRecord: {}, source: 'server_pending',
            pendingDeliveryStatus: 'external_handoff',
        } as PendingMessage;
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', pendingMessages: [pendingMessage], discardedMessages: [],
        }));
        await hoverPendingMessageRow(screen, 'p-handoff');
        expect(screen.findByTestId('pendingMessages.sendAsNew:p-handoff')).toBeNull();
        expect(screen.findByTestId('pendingMessages.markDeliveryHandled:p-handoff')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p-handoff')).toBeNull();
    });

    it('renders the registry-provided Claude custody label and interrupt action', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        resolvePendingDeliveryLabelKeyForSession.mockReturnValue(
            'session.pendingMessages.deliveryStatus.queuedInClaude',
        );
        resolvePendingDeliveryTransientActionForSession.mockReturnValue({
            id: 'interrupt_and_run',
            localId: 'p-delivering',
            stateAtMs: 42,
        });
        serverFeaturesSnapshotState.current = {
            status: 'ready',
            features: {
                capabilities: {
                    session: {
                        pendingInput: { protocolVersion: 1 },
                    },
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
            serverId: 'home-b',
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
        expect(resolvePreferredServerIdForSessionId).not.toHaveBeenCalled();

        modalConfirm.mockResolvedValueOnce(true);
        await screen.pressByTestIdAsync('pendingMessages.message:server-p-delivering');
        await screen.pressByTestIdAsync('pendingMessages.interruptAndRun:server-p-delivering');

        expect(executeDefaultAction).toHaveBeenCalledWith(
            'session.pendingInput.interruptAndRun',
            { sessionId: 's1', localId: 'p-delivering', expectedStateAtMs: 42 },
            { defaultSessionId: 's1', serverId: 'home-b', surface: 'ui' },
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

        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expect(executeDefaultAction).toHaveBeenCalledWith('session.pending.withdraw',
            expect.objectContaining({ sessionId: 's1', localId: 'p-delivering', serverId: 'home-a' }), expect.anything());
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
            serverId: 'home-b',
            sessionId: 's1',
            pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.clearTerminalComposer')).toBeTruthy();
        await screen.pressByTestIdAsync('pendingMessages.clearTerminalComposer');

        expect(modalConfirm).not.toHaveBeenCalled();
        expect(executeDefaultAction).toHaveBeenCalledWith(
            'session.terminalComposer.clear',
            { sessionId: 's1', expectedStateAtMs: 42 },
            { defaultSessionId: 's1', serverId: 'home-b', surface: 'ui', placement: 'pending_messages' },
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

    it('keeps the pending row when the clear Action confirmation is canceled', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        executeDefaultAction.mockResolvedValueOnce({ ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' });
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

        expect(modalConfirm).not.toHaveBeenCalled();
        expect(executeDefaultAction).toHaveBeenCalledTimes(1);
        expect(modalAlert).not.toHaveBeenCalled();
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

    it('keeps content controls back while a queued row is still loading, and offers them once its reader opens it', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = createFreshSteerCapableSession();
        // The pending owner's own placeholder for an encrypted row whose Session reader hasn't arrived.
        const loadingRow: PendingMessage = {
            id: 'p1',
            localId: 'p1',
            createdAt: 0,
            updatedAt: 0,
            source: 'server_pending',
            pendingDeliveryStatus: 'server_queued',
            text: '',
            displayText: t('common.loading'),
            pendingDecryption: { kind: 'loading' },
            rawRecord: { pendingDecryption: { kind: 'loading' } },
        };
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [loadingRow],
            discardedMessages: [],
        }));

        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.edit:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.copy:p1')).toBeNull();
        expect(screen.findByTestId('pendingMessages.remove:p1')).toBeTruthy();

        await screen.update(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: [{
                id: 'p1', localId: 'p1', createdAt: 0, updatedAt: 0,
                source: 'server_pending', pendingDeliveryStatus: 'server_queued',
                text: 'Ship the release notes', rawRecord: {},
            } satisfies PendingMessage],
            discardedMessages: [],
        }));
        await hoverPendingMessageRow(screen, 'p1');

        expect(screen.findByTestId('pendingMessages.edit:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.sendNow:p1')).toBeTruthy();
        expect(screen.findByTestId('pendingMessages.steerNow:p1')).toBeTruthy();
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
        executeDefaultAction.mockResolvedValueOnce({ ok: false, errorCode: 'send_failed', error: 'send failed' });

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
        executeDefaultAction.mockResolvedValueOnce({ ok: true, result: { type: 'retry_scheduled' } });

        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [{ id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} }],
                discardedMessages: [],
            }));

        await hoverPendingMessageRow(screen, 'p1');
        await screen.pressByTestIdAsync('pendingMessages.sendNow:p1');

        expectSendNowAction({ localId: 'p1', deliveryIntent: 'interrupt_and_send' });
        expect(deletePendingMessage).toHaveBeenCalledTimes(0);
        expect(discardPendingMessage).toHaveBeenCalledTimes(0);
        expect(modalAlert).toHaveBeenCalledTimes(0);
    });

    describe('send crossover: one queued utterance paints like its committed bubble', () => {
        const longText = 'x'.repeat(400);
        const crossoverSettings = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
            transcriptPendingMessageCollapseThresholdChars: 160,
            transcriptPendingMessageCollapsedLines: 2,
        };

        function longPendingMessage(id: string, createdAt: number) {
            return { id, text: longText, displayText: undefined, createdAt, updatedAt: createdAt, localId: id, rawRecord: {} };
        }

        it('never truncates the head, and bounds it well above the compact backlog strip', async () => {
            settingValues = crossoverSettings;
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [longPendingMessage('p1', 0)],
                discardedMessages: [],
            }));

            const scroll = screen.findByTestId('pendingMessages.scroll');
            expect(scroll!.props.style?.maxHeight).toBe(resolvePendingQueueHeadMaxHeightPx(LINE_PX));
            expect(scroll!.props.style?.maxHeight).toBeGreaterThan(80);
            expect(screen.findByType('MarkdownView' as any)).toBeTruthy();
            expect(screen.findByTestId('pendingMessages.viewMore:p1')).toBeNull();

            // Under the head bound nothing is hidden, and the queue has no header toggle at all.
            await act(async () => {
                scroll!.props.onContentSizeChange(0, 120);
            });
            expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();
        });

        /**
         * A second message collapses the ROWS BEHIND the head, never the head itself: the head is
         * the next message to be processed, so it keeps the shape it will cross over in and its
         * bubble keeps reporting the painted height the committed row inherits.
         */
        it('collapses the backlog behind the head, and keeps the head itself intact', async () => {
            settingValues = crossoverSettings;
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [longPendingMessage('p1', 0), longPendingMessage('p2', 1)],
                discardedMessages: [],
            }));

            expect(screen.findByTestId('pendingMessages.scroll')!.props.style?.maxHeight).toBe(QUEUE_CAP_PX);
            // p1 is the head: never clamped, so it has no "View more". p2 is backlog: clamped.
            expect(screen.findByTestId('pendingMessages.viewMore:p1')).toBeNull();
            expect(screen.findByTestId('pendingMessages.viewMore:p2')!.props.role ?? screen.findByTestId('pendingMessages.viewMore:p2')!.props.accessibilityRole).toBe('button');
            expect(screen.findByTestId('pendingMessages.viewMore:p2')!.props['aria-expanded']).toBe(false);

            await screen.pressByTestIdAsync('pendingMessages.viewMore:p2');

            expect(screen.findByTestId('pendingMessages.viewMore:p2')!.props['aria-expanded']).toBe(true);
        });

        // On the web a button role renders a <button>; a toggle inside the message's press target
        // is a <button> inside a <button>, which React rejects and browsers re-parent.
        it('keeps the "View more" toggle beside the message\'s press target, never inside it', async () => {
            settingValues = crossoverSettings;
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [longPendingMessage('p1', 0), longPendingMessage('p2', 1)],
                discardedMessages: [],
            }));

            const message = screen.findHostByTestId('pendingMessages.message:p2')!;
            expect(screen.findHostByTestId('pendingMessages.viewMore:p2')).toBeTruthy();
            expect(message.findAll((node) => node.props?.testID === 'pendingMessages.viewMore:p2')).toHaveLength(0);
        });
    });

    /**
     * PRODUCER side of the crossover carry. The committed row inherits the bubble height this block
     * measures, so exactly one row may publish it: the HEAD, which is the message about to cross
     * over and the only one painted in full.
     *
     * A backlog row must NOT publish: it is line-clamped (not the height its twin will have) and,
     * once expanded, paints a "View less" Pressable INSIDE the measured bubble that the committed
     * row never has — an overshoot, and Legend accumulates overshoot into a gap under the tail.
     */
    describe('publishing the painted bubble height', () => {
        function longPending(id: string, createdAt: number) {
            return {
                id,
                text: 'x'.repeat(400),
                displayText: undefined,
                createdAt,
                updatedAt: createdAt,
                localId: `local-${id}`,
                rawRecord: {},
            };
        }

        async function measureBubbles(pendingMessages: ReturnType<typeof longPending>[]) {
            const measured: { localId: string; bubbleHeightPx: number }[] = [];
            const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
            const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock as any, {
                sessionId: 's1',
                pendingMessages,
                discardedMessages: [],
                onPaintedUtteranceBubbleMeasured: (m: { localId: string; bubbleHeightPx: number }) => {
                    measured.push(m);
                },
            }));
            const publishesLayout: string[] = [];
            for (const message of pendingMessages) {
                const bubble = screen.findByTestId(`pendingMessages.bubble:${message.id}`);
                expect(bubble).toBeTruthy();
                // The measured node is the painted prompt surface the committed row inherits: it holds
                // the message, never the row's status mark, byline or actions (their height is not the
                // committed bubble's).
                expect(bubble!.findAll((node) => node.props?.testID === `pendingMessages.message:${message.id}`).length).toBeGreaterThan(0);
                expect(bubble!.findAll((node) => node.props?.testID === `pendingMessages.pendingAffordance:${message.id}`)).toHaveLength(0);
                // A row that must not publish does not merely return early — it attaches no
                // `onLayout` at all, so there is no path from its layout to the carried height.
                if (typeof bubble?.props?.onLayout !== 'function') continue;
                publishesLayout.push(message.id);
                await act(async () => {
                    invokeTestInstanceHandler(
                        bubble,
                        'onLayout',
                        { nativeEvent: { layout: { height: 160 } } },
                        `pendingMessages.bubble:${message.id}`,
                    );
                });
            }
            return { measured, publishesLayout, screen };
        }

        it('publishes the head bubble, and only the head', async () => {
            settingValues = {
                transcriptPendingQueueMaxHeightPx: 80,
                transcriptPendingQueueExpandedMaxHeightPx: 520,
                transcriptPendingMessageCollapseThresholdChars: 160,
                transcriptPendingMessageCollapsedLines: 2,
            };
            const { measured, publishesLayout } = await measureBubbles([longPending('p1', 0), longPending('p2', 1)]);

            expect(publishesLayout).toEqual(['p1']);
            expect(measured).toEqual([{ localId: 'local-p1', bubbleHeightPx: 160 }]);
        });

        it('publishes a lone utterance, which is always the head', async () => {
            settingValues = {
                transcriptPendingQueueMaxHeightPx: 80,
                transcriptPendingQueueExpandedMaxHeightPx: 520,
                transcriptPendingMessageCollapseThresholdChars: 160,
                transcriptPendingMessageCollapsedLines: 2,
            };
            const { measured, publishesLayout } = await measureBubbles([longPending('p1', 0)]);

            expect(publishesLayout).toEqual(['p1']);
            expect(measured).toEqual([{ localId: 'local-p1', bubbleHeightPx: 160 }]);
        });
    });

    function queuedPendingMessages() {
        return [
            { id: 'p1', text: 'hello', displayText: undefined, createdAt: 0, updatedAt: 0, localId: 'p1', rawRecord: {} },
            { id: 'p2', text: 'world', displayText: undefined, createdAt: 1, updatedAt: 1, localId: 'p2', rawRecord: {} },
        ];
    }

    it('bounds a queue at the head cap plus the compact backlog strip', async () => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        const scroll = screen.findByType('ScrollView');
        expect(scroll.props.style?.maxHeight).toBe(QUEUE_CAP_PX);
        expect(scroll.props.style?.marginTop).toBe(0);
        expect(scroll.props.contentContainerStyle).toMatchObject({ paddingTop: 6, paddingBottom: 0 });
    });

    it('keeps an overflowing queue inside its compact bound, scrolling under its edge fades', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueReorderRowHeightPx: 24,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, QUEUE_CAP_PX + 40);
        });

        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(QUEUE_CAP_PX);
        expect(screen.findByType('ScrollView').props.style?.height).toBe(QUEUE_CAP_PX);
    });

    it('expands an overflowing queue from its header and collapses it back to the compact bound', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueExpandedMaxHeightPx: 520,
            transcriptPendingQueueReorderRowHeightPx: 24,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        await act(async () => {
            screen.findByTestId('pendingMessages.scroll')!.props.onContentSizeChange(0, 400);
        });
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(QUEUE_CAP_PX);

        const toggle = screen.findByTestId('pendingMessages.headerToggle');
        expect(toggle).toBeTruthy();
        await act(async () => { toggle!.props.onPress(); });
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(520);
        expect(screen.findByType('ScrollView').props.style?.height).toBe(400);

        await act(async () => { screen.findByTestId('pendingMessages.headerToggle')!.props.onPress(); });
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(QUEUE_CAP_PX);
    });

    it('does not show a header toggle when pending content fits the compact height', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 80,
            transcriptPendingQueueReorderRowHeightPx: 24,
        };
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
        expect(screen.findByType('ScrollView').props.style?.maxHeight).toBe(QUEUE_CAP_PX);
    });

    it('keeps the pending queue viewport above the row estimate when web content measurement underflows', async () => {
        settingValues = {
            transcriptPendingQueueMaxHeightPx: 120,
            transcriptPendingQueueReorderRowHeightPx: 52,
        };
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: queuedPendingMessages(),
                discardedMessages: [],
            }));

        const scroll = screen.findByTestId('pendingMessages.scroll');
        await act(async () => {
            scroll!.props.onContentSizeChange(0, 6);
        });

        expect(screen.findByType('ScrollView').props.style?.height).toBe(104);
        expect(screen.findByTestId('pendingMessages.headerToggle')).toBeNull();
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

    it('marks a waiting message "Queued" and keeps its own defer reason for assistive tech', async () => {
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

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:head')?.props.children).toBe('Queued');
        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:later')?.props.children).toBe('Queued');
        expect(screen.findByTestId('pendingMessages.pendingAffordance:head')?.props.accessibilityLabel)
            .toBe('Queued. Waiting for runtime activity to finish');
        expect(screen.findByTestId('pendingMessages.pendingAffordance:later')?.props.accessibilityLabel)
            .toBe('Queued. Waiting for an earlier message');
    });

    it.each([false, true])('keeps queue-wide blocked context for assistive tech (split transcript rows: %s)', async (splitRows) => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = { active: true, presence: 'online', runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 };
        const blocked: PendingMessage = {
            ...queuedMessage('stuck', 0),
            text: 'Continue the retry cap review',
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance',
        };
        const queue = [queuedMessage('ahead', 0), blocked, queuedMessage('held', 2)];
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1',
            pendingMessages: splitRows ? [queue[2]!] : queue,
            ...(splitRows ? { pendingQueueContexts: resolvePendingMessagesPresentationByRecipient(queue) } : {}),
            discardedMessages: [],
        }));

        expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:held')?.props.children).toBe('Behind a blocked message');
        expect(screen.findByTestId('pendingMessages.pendingAffordance:held')?.props.accessibilityLabel)
            .toBe('Behind a blocked message. Waiting for “Continue the retry cap review”');
        // A row ahead of the blocked one is not held by it.
        if (splitRows) {
            expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:ahead')).toBeNull();
            expect(screen.findByTestId('pendingMessages.reorder:held')).not.toBeNull();
        } else {
            expect(screen.findByTestId('pendingMessages.pendingAffordanceLabel:ahead')?.props.children).toBe('Queued');
        }
    });

    it.each([undefined, { kind: 'execution_run' as const, runId: 'run-1' }])('selects exact recipient context from a mixed queue (%j)', async (recipient) => {
        const PendingMessagesTranscriptBlock = await loadPendingMessagesTranscriptBlock();
        sessionValue = { active: true, presence: 'online', runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 };
        const run = { ...queuedMessage('run', 0), recipient: { kind: 'execution_run' as const, runId: 'run-1' } };
        const main = queuedMessage('main', 1);
        const queue = [run, main];
        const screen = await renderScreen(React.createElement(PendingMessagesTranscriptBlock, {
            sessionId: 's1', recipient, pendingMessages: queue,
            pendingQueueContexts: resolvePendingMessagesPresentationByRecipient(queue), discardedMessages: [],
        }));
        expect(screen.findByTestId(`pendingMessages.row:${recipient ? 'run' : 'main'}`)).not.toBeNull();
        expect(screen.findByTestId(`pendingMessages.row:${recipient ? 'main' : 'run'}`)).toBeNull();
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

        expect(writeClipboardText).toHaveBeenCalledWith('discarded visible');
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
        expect(writeClipboardText).toHaveBeenCalledWith('x'.repeat(600));
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
