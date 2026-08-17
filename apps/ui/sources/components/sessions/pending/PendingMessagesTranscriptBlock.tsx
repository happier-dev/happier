import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { useSession, useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { PopoverAnchor } from '@/components/ui/popover';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessage';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { PendingMessagesDragReorderList } from './PendingMessagesDragReorderList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    getPendingMessageVisualState,
    isPendingMessageProviderDeliveryInFlight,
    resolvePendingMessageHeightBearingChrome,
} from './pendingMessageVisualState';
import { shouldClipPendingQueueContent } from './pendingQueueContentClipping';
import { useTerminalComposerClearAction } from '@/components/sessions/terminalComposer/useTerminalComposerClearAction';
import { usePendingInputInterruptAndRunAction } from './usePendingInputInterruptAndRunAction';
import {
    resolvePendingDeliveryLabelKeyForSession,
    resolvePendingDeliveryTransientActionForSession,
} from '@/agents/registry/registryUiBehavior';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolvePendingInputServerWireMode } from '@/sync/engine/pending/pendingInputServerWireContract';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

function getPendingText(message: PendingMessage | DiscardedPendingMessage): string {
    const raw = (message.displayText ?? message.text) ?? '';
    return String(raw);
}

async function copyPendingMessageText(message: PendingMessage | DiscardedPendingMessage): Promise<boolean> {
    const text = getPendingText(message).trim();
    if (!text) return false;
    try {
        const copied = await setClipboardStringSafe(text);
        if (!copied) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return false;
        }
        return true;
    } catch {
        Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        return false;
    }
}

function getPendingMaterializingKey(message: Pick<PendingMessage, 'id' | 'localId'>): string {
    return typeof message.localId === 'string' && message.localId.length > 0 ? message.localId : message.id;
}

type PendingMessageMenuPressAnchor = Extract<PopoverAnchor, { kind: 'rect' }>;

function resolvePendingMessageMenuPressAnchor(event: unknown): PendingMessageMenuPressAnchor | null {
    if (!event || typeof event !== 'object') return null;
    const nativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (!nativeEvent || typeof nativeEvent !== 'object') return null;
    const { pageX, pageY } = nativeEvent as { pageX?: unknown; pageY?: unknown };
    if (typeof pageX !== 'number' || !Number.isFinite(pageX)) return null;
    if (typeof pageY !== 'number' || !Number.isFinite(pageY)) return null;
    return {
        kind: 'rect',
        rect: { left: pageX, top: pageY, height: 1 },
    };
}

function isAcceptedLocalPendingProjection(message: PendingMessage): boolean {
    return message.deliveryStatus === 'accepted' && message.source !== 'server_pending';
}

function canUseDirectPendingDeliveryActions(message: PendingMessage, hasDecryptFailure: boolean): boolean {
    return !isAcceptedLocalPendingProjection(message) && !hasDecryptFailure;
}

function canSteerNowForSession(
    session: ReturnType<typeof useSession>,
    runtimeWorking: boolean,
): boolean {
    const capabilities = session?.agentState?.capabilities;
    return Boolean(
        runtimeWorking
        && session?.presence === 'online'
        && (session?.agentStateVersion ?? 0) > 0
        && session?.agentState?.controlledByUser !== true
        && (capabilities?.inFlightSteerAvailable ?? capabilities?.inFlightSteer) === true
    );
}

function isSessionRuntimeWorking(
    session: ReturnType<typeof useSession>,
    pendingMessages: ReadonlyArray<PendingMessage> = [],
): boolean {
    return derivePendingMessagesRuntimePresentation(session, pendingMessages).working;
}

function derivePendingMessagesRuntimePresentation(
    session: ReturnType<typeof useSession>,
    pendingMessages: ReadonlyArray<PendingMessage> = [],
) {
    return deriveSessionRuntimePresentationState({
        active: session?.active,
        activeAt: session?.activeAt,
        presence: session?.presence,
        thinking: session?.thinking,
        thinkingAt: session?.thinkingAt,
        optimisticThinkingAt: session?.optimisticThinkingAt ?? readLatestLocalOutboundPendingUserMessageAt(pendingMessages),
        hasPendingUserMessages: (session?.pendingCount ?? pendingMessages.length) > 0,
        latestTurnStatus: session?.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session?.latestTurnStatusObservedAt ?? null,
        runtimeActivityState: session?.runtimeActivityState ?? null,
        runtimeActivityActiveCount: session?.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session?.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session?.runtimeActivityRevision ?? null,
        meaningfulActivityAt: session?.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session?.lastRuntimeIssue ?? null,
    });
}

function supportsInFlightSteerForSession(session: ReturnType<typeof useSession>): boolean {
    const capabilities = session?.agentState?.capabilities;
    return Boolean(
        session?.presence === 'online'
        && (session?.agentStateVersion ?? 0) > 0
        && session?.agentState?.controlledByUser !== true
        && (capabilities?.inFlightSteerSupported ?? capabilities?.inFlightSteer) === true
    );
}

export type PendingMessageEditRequest = Readonly<{
    id: string;
    text: string;
    displayText?: string;
    message: PendingMessage;
}>;

export function PendingMessagesTranscriptBlock(props: Readonly<{
    sessionId: string;
    pendingMessages: PendingMessage[];
    discardedMessages: DiscardedPendingMessage[];
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const terminalComposerClear = useTerminalComposerClearAction(props.sessionId);
    const pendingInputInterruptAndRun = usePendingInputInterruptAndRunAction(props.sessionId);
    const pendingInputServerId = session?.serverId ?? resolvePreferredServerIdForSessionId(props.sessionId);
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(pendingInputServerId ?? null, {
        enabled: Boolean(pendingInputServerId),
    });
    const pendingInputServerWireMode = resolvePendingInputServerWireMode(serverFeaturesSnapshot);

    const runtimePresentation = derivePendingMessagesRuntimePresentation(session, props.pendingMessages);
    const runtimeWorking = runtimePresentation.working;
    const canSteerNow = canSteerNowForSession(session, runtimeWorking);
    const supportsInFlightSteer = supportsInFlightSteerForSession(session);
    const capabilities = session?.agentState?.capabilities;
    const pendingCount = props.pendingMessages.length;
    const discardedCount = props.discardedMessages.length;
    const clipsQueueContent = shouldClipPendingQueueContent({ pendingCount, discardedCount });
    const hasProviderDeliveryInFlight = props.pendingMessages.some(isPendingMessageProviderDeliveryInFlight);
    // A terminal-composer-draft capability is meaningful only while a runtime (TUI) is live;
    // after a stop the sticky capability must not present a ghost draft for the next send.
    const hasActiveRuntime = session?.active === true;
    const steerBlockedByTerminalDraft =
        hasActiveRuntime
        && (
            capabilities?.inFlightSteerUnavailableReason === 'user_terminal_draft'
            || capabilities?.terminalComposerDraftPresent === true
        );
    const showTerminalComposerClearAction = Boolean(
        pendingCount > 0
        && steerBlockedByTerminalDraft
        && capabilities?.terminalComposerClearSupported !== false
    );
    const showNonSteerableNotice = Boolean(
        pendingCount > 0
        && (
            (
                runtimeWorking
                && supportsInFlightSteer
                && !canSteerNow
            )
            || steerBlockedByTerminalDraft
        )
    );

    const maxHeightSetting = useSetting('transcriptPendingQueueMaxHeightPx');
    const maxHeightPx =
        typeof maxHeightSetting === 'number' && Number.isFinite(maxHeightSetting)
            ? Math.max(1, Math.trunc(maxHeightSetting))
            : settingsDefaults.transcriptPendingQueueMaxHeightPx;

    const expandedMaxHeightSetting = useSetting('transcriptPendingQueueExpandedMaxHeightPx');
    const expandedMaxHeightPx =
        typeof expandedMaxHeightSetting === 'number' && Number.isFinite(expandedMaxHeightSetting)
            ? Math.max(maxHeightPx, Math.trunc(expandedMaxHeightSetting))
            : Math.max(maxHeightPx, settingsDefaults.transcriptPendingQueueExpandedMaxHeightPx);

    const collapseThresholdCharsSetting = useSetting('transcriptPendingMessageCollapseThresholdChars');
    const collapseThresholdChars =
        typeof collapseThresholdCharsSetting === 'number' && Number.isFinite(collapseThresholdCharsSetting)
            ? Math.max(0, Math.trunc(collapseThresholdCharsSetting))
            : settingsDefaults.transcriptPendingMessageCollapseThresholdChars;

    const collapsedLinesSetting = useSetting('transcriptPendingMessageCollapsedLines');
    const collapsedLines =
        typeof collapsedLinesSetting === 'number' && Number.isFinite(collapsedLinesSetting)
            ? Math.max(1, Math.trunc(collapsedLinesSetting))
            : settingsDefaults.transcriptPendingMessageCollapsedLines;

    // M1 (2026-08-10): no longer a drag-layout input — the queued rows are in normal flow and the
    // drag geometry uses their MEASURED heights. This repo keeps the setting because it has a
    // second, unrelated consumer below: the floor under the block's own viewport height when a web
    // content measurement underflows (`estimatedPendingContentHeightPx`).
    const reorderRowHeightSetting = useSetting('transcriptPendingQueueReorderRowHeightPx');
    const reorderEstimatedRowHeightPx =
        typeof reorderRowHeightSetting === 'number' && Number.isFinite(reorderRowHeightSetting)
            ? Math.max(24, Math.trunc(reorderRowHeightSetting))
            : settingsDefaults.transcriptPendingQueueReorderRowHeightPx;

    const pendingQueueDeliveryTimingSetting = useSetting('sessionPendingQueueDeliveryTiming');
    const pendingQueueDeliveryTiming =
        pendingQueueDeliveryTimingSetting === 'after_runtime_idle'
        || pendingQueueDeliveryTimingSetting === 'after_foreground_ready'
            ? pendingQueueDeliveryTimingSetting
            : settingsDefaults.sessionPendingQueueDeliveryTiming;
    const pendingQueueRuntimeReachable = session?.active === true && session?.presence === 'online';
    const sendNowActionLabel = canSteerNow
        ? t('session.pendingMessages.actions.sendNowInterrupt')
        : runtimePresentation.backgroundActive
            ? t('session.pendingMessages.actions.sendToAgentNow')
            : t('session.pendingMessages.actions.sendNow');
    const sendNowConfirmationTitle = canSteerNow
        ? t('session.pendingMessages.sendConfirm.interruptTitle')
        : runtimePresentation.backgroundActive
            ? t('session.pendingMessages.sendConfirm.backgroundTitle')
            : t('session.pendingMessages.sendConfirm.title');
    const sendNowConfirmationBody = !pendingQueueRuntimeReachable
        ? t('session.pendingMessages.sendConfirm.resumeBody')
        : runtimePresentation.backgroundActive
            ? t('session.pendingMessages.sendConfirm.backgroundBody')
            : t('session.pendingMessages.sendConfirm.body');
    const pendingQueueForegroundState = runtimeWorking
        ? (canSteerNow ? 'active_steerable' : 'active_unsteerable')
        : 'ready';
    const pendingQueueRuntimeActivity =
        session?.runtimeActivityState === 'active'
        || session?.runtimeActivityState === 'idle'
        || session?.runtimeActivityState === 'unknown'
            ? session.runtimeActivityState
            : 'unknown';

    const [expandedMessageIds, setExpandedMessageIds] = React.useState<Record<string, true>>({});
    const [isPendingQueueExpanded, setIsPendingQueueExpanded] = React.useState(false);
    const [openMenuKey, setOpenMenuKey] = React.useState<string | null>(null);
    const [menuPressAnchor, setMenuPressAnchor] = React.useState<Readonly<{
        menuKey: string;
        anchor: PendingMessageMenuPressAnchor;
    }> | null>(null);
    const [scrollContentHeightPx, setScrollContentHeightPx] = React.useState<number | null>(null);
    const isWeb = Platform.OS === 'web';
    const [hoveredMessageId, setHoveredMessageId] = React.useState<string | null>(null);
    const [scrollViewportHeightPx, setScrollViewportHeightPx] = React.useState<number | null>(null);
    const [scrollOffsetY, setScrollOffsetY] = React.useState<number | null>(null);
    const [materializingLocalIdMap, setMaterializingLocalIdMap] = React.useState<Record<string, true>>({});
    const deliveryActionInFlightRef = React.useRef<Record<string, true>>({});
    const scrollRef = React.useRef<ScrollView | null>(null);
    const materializingLocalIds = React.useMemo(
        () => new Set(Object.keys(materializingLocalIdMap)),
        [materializingLocalIdMap],
    );

    React.useEffect(() => {
        if (props.pendingMessages.length <= 0) {
            setIsPendingQueueExpanded(false);
        }
    }, [props.pendingMessages.length]);

    const toggleMessageExpanded = React.useCallback((id: string) => {
        setExpandedMessageIds((prev) => {
            const next = { ...prev };
            if (next[id]) {
                delete next[id];
            } else {
                next[id] = true;
            }
            return next;
        });
    }, []);

    const togglePendingQueueExpanded = React.useCallback(() => {
        setIsPendingQueueExpanded((value) => !value);
    }, []);

    const handleEdit = React.useCallback(async (message: PendingMessage) => {
        await props.onEditPendingMessage?.({
            id: message.id,
            text: message.text,
            displayText: message.displayText,
            message,
        });
    }, [props.onEditPendingMessage]);

    const handleReorderIds = React.useCallback(async (ids: string[]) => {
        if (ids.length <= 1) return;
        const current = props.pendingMessages.map((m) => m.id);
        if (ids.length === current.length && ids.every((id, idx) => id === current[idx])) {
            return;
        }
        try {
            await sync.reorderPendingMessages(props.sessionId, ids);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.reorderFailed'));
        }
    }, [props.pendingMessages, props.sessionId]);

    const handleRemove = React.useCallback(async (pendingId: string) => {
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.removeConfirm.title'),
            t('session.pendingMessages.removeConfirm.body'),
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;
        try {
            await sync.deletePendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.deleteFailed'));
        }
    }, [props.sessionId]);

    const deleteOrDiscardAfterSend = React.useCallback(async (pendingId: string) => {
        try {
            await sync.deletePendingMessage(props.sessionId, pendingId);
        } catch (deleteError) {
            try {
                await sync.discardPendingMessage(props.sessionId, pendingId);
            } catch {
                throw deleteError;
            }
        }
    }, [props.sessionId]);

    const shouldRemoveDurableRowAfterSend = React.useCallback((result: Awaited<ReturnType<typeof sync.sendPendingMessageNow>>) => (
        result.type === 'committed'
        && result.persistence === 'provider_direct'
        && result.providerAcceptancePending !== true
    ), []);

    const setPendingMaterializing = React.useCallback((message: PendingMessage, isMaterializing: boolean) => {
        const key = getPendingMaterializingKey(message);
        setMaterializingLocalIdMap((prev) => {
            if (isMaterializing) {
                if (prev[key]) return prev;
                return { ...prev, [key]: true };
            }
            if (!prev[key]) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }, []);

    const runPendingDeliveryAction = React.useCallback(async (
        message: PendingMessage,
        action: () => Promise<void>,
    ) => {
        const key = getPendingMaterializingKey(message);
        if (deliveryActionInFlightRef.current[key]) return;
        deliveryActionInFlightRef.current = { ...deliveryActionInFlightRef.current, [key]: true };
        setPendingMaterializing(message, true);
        try {
            await action();
        } finally {
            const next = { ...deliveryActionInFlightRef.current };
            delete next[key];
            deliveryActionInFlightRef.current = next;
            setPendingMaterializing(message, false);
        }
    }, [setPendingMaterializing]);

    const handleDismissDelivery = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await sync.dismissPendingDelivery(props.sessionId, message.id);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.discardFailed'));
            }
        });
    }, [props.sessionId, runPendingDeliveryAction]);

    const handleSendAsNew = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await sync.sendPendingDeliveryAsNew(props.sessionId, message.id);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
            }
        });
    }, [props.sessionId, runPendingDeliveryAction]);

    const handleRetrySend = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await sync.retryPendingMessageSend(props.sessionId, message.localId ?? message.id);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
            }
        });
    }, [props.sessionId, runPendingDeliveryAction]);

    const handleRemoveDelivery = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, () => handleRemove(message.id));
    }, [handleRemove, runPendingDeliveryAction]);

    const handleMarkDeliveryHandled = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            const confirmed = await Modal.confirm(
                t('session.pendingMessages.markHandledConfirm.title'),
                t('session.pendingMessages.markHandledConfirm.body'),
                { confirmText: t('session.pendingMessages.actions.markHandled') },
            );
            if (!confirmed) return;

            try {
                await sync.markPendingDeliveryHandled(props.sessionId, message.id);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.markHandledFailed'));
            }
        });
    }, [props.sessionId, runPendingDeliveryAction]);

    const handleInterruptAndRun = React.useCallback(async (
        message: PendingMessage,
        action: Readonly<{ localId: string; stateAtMs?: number }>,
    ) => {
        await runPendingDeliveryAction(message, async () => {
            await pendingInputInterruptAndRun.interruptAndRun({
                localId: action.localId,
                ...(typeof action.stateAtMs === 'number'
                    ? { expectedStateAtMs: action.stateAtMs }
                    : {}),
            });
        });
    }, [pendingInputInterruptAndRun, runPendingDeliveryAction]);

    const handleSteerNow = React.useCallback(async (message: PendingMessage) => {
        const localId = message.localId ?? message.id;
        try {
            setPendingMaterializing(message, true);
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId,
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
                deliveryIntent: 'steer_now',
            });
            if (shouldRemoveDurableRowAfterSend(result)) {
                await deleteOrDiscardAfterSend(message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
        } finally {
            setPendingMaterializing(message, false);
        }
    }, [deleteOrDiscardAfterSend, props.sessionId, setPendingMaterializing, shouldRemoveDurableRowAfterSend]);

    const handleSendNow = React.useCallback(async (message: PendingMessage) => {
        const localId = message.localId ?? message.id;
        const confirmed = await Modal.confirm(
            sendNowConfirmationTitle,
            sendNowConfirmationBody,
            { confirmText: sendNowActionLabel },
        );
        if (!confirmed) return;

        try {
            setPendingMaterializing(message, true);
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId,
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
                deliveryIntent: 'interrupt_and_send',
            });
            if (shouldRemoveDurableRowAfterSend(result)) {
                await deleteOrDiscardAfterSend(message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
        } finally {
            setPendingMaterializing(message, false);
        }
    }, [deleteOrDiscardAfterSend, props.sessionId, sendNowActionLabel, sendNowConfirmationBody, sendNowConfirmationTitle, setPendingMaterializing, shouldRemoveDurableRowAfterSend]);

    const handleRequeueDiscarded = React.useCallback(async (pendingId: string) => {
        try {
            await sync.restoreDiscardedPendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.restoreFailed'));
        }
    }, [props.sessionId]);

    const handleRemoveDiscarded = React.useCallback(async (pendingId: string) => {
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.discarded.removeConfirm.title'),
            t('session.pendingMessages.discarded.removeConfirm.body'),
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;
        try {
            await sync.deleteDiscardedPendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.deleteDiscardedFailed'));
        }
    }, [props.sessionId]);

    const handleSteerDiscardedNow = React.useCallback(async (message: DiscardedPendingMessage) => {
        try {
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId: getPendingMaterializingKey(message),
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
                deliveryIntent: 'steer_now',
            });
            if (shouldRemoveDurableRowAfterSend(result)) {
                await sync.deleteDiscardedPendingMessage(props.sessionId, message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendDiscardedFailed'));
        }
    }, [props.sessionId, shouldRemoveDurableRowAfterSend]);

    const handleSendDiscardedNow = React.useCallback(async (message: DiscardedPendingMessage) => {
        const confirmed = await Modal.confirm(
            sendNowConfirmationTitle,
            sendNowConfirmationBody,
            { confirmText: sendNowActionLabel },
        );
        if (!confirmed) return;

        try {
            const result = await sync.sendPendingMessageNow(props.sessionId, {
                localId: getPendingMaterializingKey(message),
                createdAt: message.createdAt,
                rawRecord: message.rawRecord,
                text: message.text,
                displayText: message.displayText,
                deliveryIntent: 'interrupt_and_send',
            });
            if (shouldRemoveDurableRowAfterSend(result)) {
                await sync.deleteDiscardedPendingMessage(props.sessionId, message.id);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendDiscardedFailed'));
        }
    }, [props.sessionId, sendNowActionLabel, sendNowConfirmationBody, sendNowConfirmationTitle, shouldRemoveDurableRowAfterSend]);

    const renderMessage = React.useCallback((args: {
        message: PendingMessage;
        index: number;
        renderDragHandle: (args: Readonly<{ children: React.ReactNode; testID?: string; accessibilityLabel?: string }>) => React.ReactNode;
    }) => {
        const { message, index, renderDragHandle } = args;
        const text = getPendingText(message).trim();
        const isCollapsible = clipsQueueContent && collapseThresholdChars > 0 && text.length >= collapseThresholdChars;
	        const isExpanded = expandedMessageIds[message.id] === true || !isCollapsible;

	        const menuKey = `active:${message.id}`;
	        const menuOpen = openMenuKey === menuKey;
	        const menuAnchor = menuPressAnchor?.menuKey === menuKey ? menuPressAnchor.anchor : undefined;
	        const hasDecryptFailure = message.pendingDecryptFailure?.kind === 'decrypt_failed';
        const visualState = getPendingMessageVisualState(message, {
            materializingLocalIds,
            hasEarlierRow: props.pendingMessages.slice(0, index).some((candidate) =>
                candidate.source !== 'local_outbound' || candidate.deliveryStatus === 'accepted',
            ),
            hasProviderDeliveryInFlight,
            runtimeReachable: pendingQueueRuntimeReachable,
            foregroundState: pendingQueueForegroundState,
            deliveryTiming: pendingQueueDeliveryTiming,
            runtimeActivity: pendingQueueRuntimeActivity,
        });
        const deliveryActionBusy = materializingLocalIds.has(getPendingMaterializingKey(message));
        const hasEffectPossibleDelivery = visualState.deliveryMutationPolicy === 'effect_possible';
        const isUncertainDelivery = hasEffectPossibleDelivery && visualState.kind === 'blocked';
        const isServerDeliveryInProgress = isPendingMessageProviderDeliveryInFlight(message)
            && visualState.kind === 'delivering';
        const usesDeliveryResolutionActions =
            !hasEffectPossibleDelivery
            && (visualState.kind === 'blocked' || visualState.kind === 'delivering');
        const isCancellationState = visualState.kind === 'cancelling' || visualState.kind === 'cancel_failed';
        const hasDurableOutboxOperation = message.pendingOutboxOperation === 'enqueue' || message.pendingOutboxOperation === 'cancel';
        const canUsePendingQueueActions =
            !hasEffectPossibleDelivery
            && !hasDurableOutboxOperation
            && !isAcceptedLocalPendingProjection(message);
        const deliveryBlockedPresentation = visualState.deliveryBlockedPresentation ?? null;
        // F-P2: the ONE in-flow notice this row paints. Selected from the visual-state owner's own
        // descriptor rather than inline, because `transcriptRowShellSignature` keys the row's Legend
        // size version on exactly this answer — a notice the key cannot see is a stale reservation,
        // and a key move with no notice is a discarded measurement.
        const heightBearingChrome = resolvePendingMessageHeightBearingChrome(visualState);
        const providerDeliveryLabelKey = session && visualState.kind === 'delivering'
            ? resolvePendingDeliveryLabelKeyForSession({
                session,
                localId: message.localId ?? null,
                detail: message.pendingDeliveryDetail,
            })
            : null;
        const transientAction =
            session
            && visualState.kind === 'delivering'
            && typeof message.localId === 'string'
            && message.localId.length > 0
                ? resolvePendingDeliveryTransientActionForSession({
                    session,
                    localId: message.localId,
                    wireMode: pendingInputServerWireMode,
                })
                : null;
        const deliveryStateLabel =
            visualState.kind === 'delivering'
                ? t(providerDeliveryLabelKey ?? 'session.pendingMessages.deliveryStatus.delivering')
                : visualState.kind === 'blocked'
                    ? t('session.pendingMessages.deliveryStatus.blocked')
                    : visualState.kind === 'send_failed'
                        ? t('session.pendingMessages.errors.sendFailed')
                    : visualState.kind === 'cancelling'
                        ? t('common.remove')
                    : visualState.kind === 'cancel_failed'
                        ? t('common.error')
                    : visualState.queuedReason === 'waiting_for_foreground_turn'
                        ? t('session.pendingMessages.queuedReasons.waitingForForegroundTurn')
                    : visualState.queuedReason === 'waiting_for_runtime_activity'
                        ? t('session.pendingMessages.queuedReasons.waitingForRuntimeActivity')
                    : visualState.queuedReason === 'runtime_activity_unknown'
                        ? t('session.pendingMessages.queuedReasons.runtimeActivityUnknown')
                    : visualState.queuedReason === 'waiting_for_predecessor'
                        ? t('session.pendingMessages.queuedReasons.waitingForPredecessor')
                    : visualState.queuedReason === 'waiting_for_runtime'
                        ? t('session.pendingMessages.queuedReasons.waitingForRuntime')
                    : visualState.queuedReason === 'unsupported_action'
                        ? t('session.pendingMessages.queuedReasons.unsupportedAction')
                    : visualState.queuedRequestedAction === 'steer_now'
                        ? t('session.pendingMessages.actions.steerNow')
                    : visualState.queuedRequestedAction === 'send_now'
                        ? t('session.pendingMessages.actions.sendNow')
                    : t('session.pendingMessages.badgeLabel', { count: 0 });
        const blockedDeliveryLabel = deliveryBlockedPresentation
            ? t(deliveryBlockedPresentation.labelKey)
            : null;
        const canUseDirectDeliveryActions = !hasDurableOutboxOperation
            && !isCancellationState
            && !hasEffectPossibleDelivery
            && canUseDirectPendingDeliveryActions(message, hasDecryptFailure);

	        const menuItems = (() => {
	            const items: DropdownMenuItem[] = [];
                if (text) {
                    items.push({
                        id: 'copy',
                        testID: `pendingMessages.menu.copy:${message.id}`,
                        title: t('common.copy'),
                        icon: <Icon name="copy" size={16} color={theme.colors.text.secondary} />,
                    });
                }
                if (transientAction?.id === 'interrupt_and_run') {
                    items.push({
                        id: 'interruptAndRun',
                        testID: `pendingMessages.interruptAndRun:${message.id}`,
                        title: t('session.pendingMessages.actions.interruptAndRunNow'),
                        icon: <Icon name="stop-circle" size={16} color={theme.colors.text.secondary} />,
                        disabled: deliveryActionBusy || pendingInputInterruptAndRun.busy,
                    });
                }
	            if (isCancellationState) {
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (visualState.kind === 'send_failed') {
	                items.push({ id: 'retrySend', title: t('session.pendingMessages.actions.retryDelivery'), icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (hasDurableOutboxOperation) {
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (isServerDeliveryInProgress) {
	                items.push({ id: 'sendAsNew', testID: `pendingMessages.sendAsNew:${message.id}`, title: t('session.pendingMessages.actions.sendAsNew'), icon: <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (isUncertainDelivery) {
	                items.push({ id: 'continueWaiting', testID: `pendingMessages.continueWaiting:${message.id}`, title: t('session.pendingMessages.actions.continueWaiting'), icon: <Icon name="clock" size={16} color={theme.colors.text.secondary} /> });
	                items.push({ id: 'markDeliveryHandled', testID: `pendingMessages.markDeliveryHandled:${message.id}`, title: t('session.pendingMessages.actions.markHandled'), icon: <Icon name="checks" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'dismissDelivery', testID: `pendingMessages.dismissDelivery:${message.id}`, title: t('session.pendingMessages.actions.dismiss'), icon: <Icon name="archive" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'sendAsNew', testID: `pendingMessages.sendAsNew:${message.id}`, title: t('session.pendingMessages.actions.sendAsNew'), icon: <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (usesDeliveryResolutionActions) {
	                items.push({ id: 'markDeliveryHandled', title: t('session.pendingMessages.actions.markHandled'), icon: <Icon name="checks" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
                } else if (canUsePendingQueueActions) {
		                items.push({ id: 'edit', title: t('session.pendingMessages.actions.edit'), icon: <Icon name="pencil" size={16} color={theme.colors.text.secondary} /> });
		                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} /> });
                }
	            if (canSteerNow && canUseDirectDeliveryActions) {
	                items.push({ id: 'steerNow', title: t('session.pendingMessages.actions.steerNow'), icon: <Icon name="navigation-arrow" size={16} color={theme.colors.text.secondary} /> });
	            }
	            if (canUseDirectDeliveryActions) {
	                items.push({
	                    id: 'sendNow',
	                    title: sendNowActionLabel,
	                    icon: <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />,
	                });
	            }
	            return items;
	        })();

        return (
            <DropdownMenu
                key={message.id}
                open={menuOpen}
                onOpenChange={(next) => {
                    setOpenMenuKey(next ? menuKey : null);
                    if (!next) {
                        setMenuPressAnchor((current) => current?.menuKey === menuKey ? null : current);
                    }
                }}
                items={menuItems}
                onSelect={async (itemId) => {
                    setOpenMenuKey(null);
                    if (itemId === 'copy') await copyPendingMessageText(message);
                    if (itemId === 'edit') await handleEdit(message);
                    if (itemId === 'remove') {
                        if (usesDeliveryResolutionActions) {
                            await handleRemoveDelivery(message);
                        } else {
                            await handleRemove(message.id);
                        }
                    }
                    if (itemId === 'dismissDelivery') await handleDismissDelivery(message);
                    if (itemId === 'sendAsNew') await handleSendAsNew(message);
                    if (itemId === 'retrySend') await handleRetrySend(message);
                    if (itemId === 'markDeliveryHandled') await handleMarkDeliveryHandled(message);
                    if (itemId === 'interruptAndRun' && transientAction?.id === 'interrupt_and_run') {
                        await handleInterruptAndRun(message, transientAction);
                    }
                    if (itemId === 'steerNow') await handleSteerNow(message);
                    if (itemId === 'sendNow') await handleSendNow(message);
                }}
                popoverAnchor={menuAnchor}
                placement="auto-vertical"
                gap={6}
                matchTriggerWidth={menuAnchor ? false : undefined}
                trigger={({ openMenu, closeMenu }) => (
                    <View
                        testID={`pendingMessages.row:${message.id}`}
                        style={[
                            styles.userMessageWrapper,
                            isWeb && (hoveredMessageId === message.id || menuOpen) ? styles.userMessageWrapperHovered : null,
                        ]}
                        {...(!isWeb ? { pointerEvents: 'box-none' as const } : null)}
                        {...(isWeb
                            ? {
                                onPointerEnter: () => setHoveredMessageId(message.id),
                                onPointerLeave: () => setHoveredMessageId((prev) => (prev === message.id ? null : prev)),
                            }
                            : null)}
                    >
                        <Pressable
                            onPress={(event) => {
                                if (menuOpen) {
                                    closeMenu();
                                    return;
                                }
                                const anchor = resolvePendingMessageMenuPressAnchor(event);
                                setMenuPressAnchor(anchor ? { menuKey, anchor } : null);
                                openMenu();
                            }}
                            testID={`pendingMessages.message:${message.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={text || t('session.pendingMessages.title')}
                            style={({ pressed }) => ([
                                styles.userMessageBubble,
                                { backgroundColor: theme.colors.message.user.background, opacity: pressed ? 0.82 : 0.9 },
                            ])}
                        >
                            {isExpanded ? (
                                <MarkdownView markdown={text} textStyle={styles.transcriptMarkdownText} />
                            ) : (
                                <Text
                                    numberOfLines={collapsedLines}
                                    style={[styles.collapsedPlainText, { color: theme.colors.text.primary }]}
                                >
                                    {text}
                                </Text>
                            )}
                            {isCollapsible ? (
                                <Pressable
                                    onPress={(e: any) => {
                                        e?.stopPropagation?.();
                                        toggleMessageExpanded(message.id);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityState={{ expanded: isExpanded }}
                                    hitSlop={10}
                                    testID={`pendingMessages.viewMore:${message.id}`}
                                    style={({ pressed }) => ({
                                        alignSelf: 'flex-start',
                                        marginTop: 6,
                                        opacity: pressed ? 0.8 : 1,
                                    })}
                                >
                                    <Text style={{ color: theme.colors.text.link, fontSize: 12, ...Typography.default('semiBold') }}>
                                        {isExpanded ? t('session.pendingMessages.actions.viewLess') : t('session.pendingMessages.actions.viewMore')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </Pressable>

                        <View
                            testID={`pendingMessages.pendingAffordance:${message.id}`}
                            accessible
                            accessibilityLabel={deliveryStateLabel}
                            {...(!isWeb ? { pointerEvents: 'none' as const } : null)}
                            style={[
                                styles.pendingAffordanceChip,
                                { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.default },
                                isWeb ? { pointerEvents: 'none' as const } : null,
                            ]}
                        >
                            {visualState.showSpinner ? (
                                <ActivitySpinner
                                    testID={`pendingMessages.${visualState.kind}Indicator:${message.id}`}
                                    size="small"
                                    color={theme.colors.text.secondary}
                                />
                            ) : (
                                <Icon name={visualState.iconName} size={8} color={theme.colors.text.secondary} />
                            )}
                            <Text
                                testID={`pendingMessages.pendingAffordanceLabel:${message.id}`}
                                style={[styles.pendingAffordanceText, { color: theme.colors.text.secondary }]}
                            >
                                {deliveryStateLabel}
                            </Text>
                        </View>

                        {heightBearingChrome === 'blocked-notice' && blockedDeliveryLabel ? (
	                            <View
	                                testID={`pendingMessages.blockedDeliveryNotice:${message.id}`}
                                style={[
                                    styles.blockedDeliveryNotice,
                                    {
                                        backgroundColor: theme.colors.surface.base,
                                        borderColor: theme.colors.border.default,
                                    },
                                ]}
                            >
                                <Icon name="warning-circle" size={14} color={theme.colors.text.secondary} />
	                                <Text
	                                    testID={deliveryBlockedPresentation?.isUnknown ? `pendingMessages.unknownDeliveryStatus:${message.id}` : `pendingMessages.blockedDeliveryReason:${message.id}`}
	                                    style={[styles.blockedDeliveryNoticeText, { color: theme.colors.text.secondary }]}
	                                >
	                                    {blockedDeliveryLabel}
	                                </Text>
	                            </View>
	                        ) : null}

                        {isWeb ? (
                            <View
                                testID={`pendingMessages.actionsOverlay:${message.id}`}
                                pointerEvents="auto"
                                style={styles.messageActionContainer}
                            >
                                {text ? (
                                    <PendingMessageCopyAction
                                        testID={`pendingMessages.copy:${message.id}`}
                                        message={message}
                                    />
                                ) : null}
                                {props.pendingMessages.length > 1 && !hasEffectPossibleDelivery ? (
                                    renderDragHandle({
                                        children: (
                                            <ReorderDragHandleAffordance
                                                testID={`pendingMessages.reorder:${message.id}`}
                                                accessibilityLabel={t('common.reorder')}
                                            />
                                        ),
                                        accessibilityLabel: t('common.reorder'),
                                    })
                                ) : null}
                                {visualState.kind === 'send_failed' ? (
                                    <IconAction
                                        testID={`pendingMessages.retrySend:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.retryDelivery')}
                                        icon="arrow-clockwise"
                                        onPress={() => handleRetrySend(message)}
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {usesDeliveryResolutionActions ? (
                                    <IconAction
                                        testID={`pendingMessages.markDeliveryHandled:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.markHandled')}
                                        icon="checks"
                                        onPress={() => handleMarkDeliveryHandled(message)}
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {isUncertainDelivery ? (
                                    <IconAction
                                        testID={`pendingMessages.markDeliveryHandled:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.markHandled')}
                                        icon="checks"
                                        onPress={() => handleMarkDeliveryHandled(message)}
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {isServerDeliveryInProgress ? (
                                    <IconAction
                                        testID={`pendingMessages.sendAsNew:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.sendAsNew')}
                                        icon="paper-plane"
                                        onPress={() => handleSendAsNew(message)}
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {isUncertainDelivery ? (
                                    <IconAction
                                        testID={`pendingMessages.dismissDelivery:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.dismiss')}
                                        icon="archive"
                                        onPress={() => handleDismissDelivery(message)}
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {isUncertainDelivery ? (
                                    <IconAction
                                        testID={`pendingMessages.sendAsNew:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.sendAsNew')}
                                        icon="paper-plane"
                                        onPress={() => handleSendAsNew(message)}
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {usesDeliveryResolutionActions ? (
                                    <IconAction
                                        testID={`pendingMessages.remove:${message.id}`}
                                        accessibilityLabel={t('common.remove')}
                                        icon="trash"
                                        onPress={() => handleRemoveDelivery(message)}
                                        tone="destructive"
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {hasDurableOutboxOperation && !usesDeliveryResolutionActions ? (
                                    <IconAction
                                        testID={`pendingMessages.remove:${message.id}`}
                                        accessibilityLabel={t('common.remove')}
                                        icon="trash"
                                        onPress={() => handleRemove(message.id)}
                                        tone="destructive"
                                        disabled={deliveryActionBusy}
                                    />
                                ) : null}
                                {canUsePendingQueueActions && !usesDeliveryResolutionActions ? (
	                                    <IconAction
	                                        testID={`pendingMessages.edit:${message.id}`}
                                        accessibilityLabel={t('session.pendingMessages.actions.edit')}
                                        icon="pencil"
                                        onPress={() => handleEdit(message)}
                                    />
                                ) : null}
                                {canUsePendingQueueActions && !usesDeliveryResolutionActions ? (
	                                    <IconAction
	                                        testID={`pendingMessages.remove:${message.id}`}
                                        accessibilityLabel={t('common.remove')}
                                        icon="trash"
                                        onPress={() => handleRemove(message.id)}
                                        tone="destructive"
                                    />
                                ) : null}
	                                {canSteerNow && canUseDirectDeliveryActions ? (
	                                    <IconAction
	                                        testID={`pendingMessages.steerNow:${message.id}`}
	                                        accessibilityLabel={t('session.pendingMessages.actions.steerNow')}
	                                        icon="navigation-arrow"
	                                        onPress={() => handleSteerNow(message)}
	                                    />
	                                ) : null}
	                                {canUseDirectDeliveryActions ? (
	                                    <IconAction
	                                        testID={`pendingMessages.sendNow:${message.id}`}
	                                        accessibilityLabel={sendNowActionLabel}
	                                        icon="paper-plane"
	                                        onPress={() => handleSendNow(message)}
	                                    />
	                                ) : null}
	                            </View>
                        ) : props.pendingMessages.length > 1 && !hasEffectPossibleDelivery ? (
                            <View style={styles.messageActionContainer}>
                                {renderDragHandle({
                                    children: (
                                        <ReorderDragHandleAffordance
                                            testID={`pendingMessages.reorder:${message.id}`}
                                            accessibilityLabel={t('common.reorder')}
                                        />
                                    ),
                                    accessibilityLabel: t('common.reorder'),
                                })}
                            </View>
                        ) : null}
                    </View>
                )}
            />
        );
    }, [
        canSteerNow,
        clipsQueueContent,
        hoveredMessageId,
        collapseThresholdChars,
        collapsedLines,
        expandedMessageIds,
        handleEdit,
        handleInterruptAndRun,
        handleMarkDeliveryHandled,
        handleRemove,
        handleRemoveDelivery,
        handleDismissDelivery,
        handleSendAsNew,
        handleSendNow,
        handleSteerNow,
        hasProviderDeliveryInFlight,
        isWeb,
        materializingLocalIds,
        menuPressAnchor,
        openMenuKey,
        pendingQueueDeliveryTiming,
        pendingQueueForegroundState,
        pendingQueueRuntimeActivity,
        pendingQueueRuntimeReachable,
        pendingInputInterruptAndRun.busy,
        pendingInputServerWireMode,
        props.pendingMessages.length,
        sendNowActionLabel,
        session,
        theme.colors.border.default,
        theme.colors.surface.base,
        theme.colors.text.link,
        theme.colors.text.secondary,
        theme.colors.message.user.background,
        theme.colors.message.user.foreground,
        toggleMessageExpanded,
    ]);

    const renderDiscardedMessage = React.useCallback((message: DiscardedPendingMessage) => {
        const text = getPendingText(message).trim();
        const menuKey = `discarded:${message.id}`;
        const menuOpen = openMenuKey === menuKey;
        const menuAnchor = menuPressAnchor?.menuKey === menuKey ? menuPressAnchor.anchor : undefined;
        const isArchivedUncertainty = message.discardedReason === 'dismissed_uncertain'
            || message.discardedReason === 'resent_as_new';

        const menuItems: DropdownMenuItem[] = [
            ...(text ? [{
                id: 'copy',
                testID: `pendingMessages.discarded.menu.copy:${message.id}`,
                title: t('common.copy'),
                icon: <Icon name="copy" size={16} color={theme.colors.text.secondary} />,
            } as const] : []),
            ...(!isArchivedUncertainty ? [
                { id: 'requeue', title: t('session.pendingMessages.actions.requeue'), icon: <Icon name="arrow-elbow-up-left" size={16} color={theme.colors.text.secondary} /> },
                { id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} /> },
                ...(canSteerNow ? [{ id: 'steerNow', title: t('session.pendingMessages.actions.steerNow'), icon: <Icon name="navigation-arrow" size={16} color={theme.colors.text.secondary} /> } as const] : []),
                { id: 'sendNow', title: sendNowActionLabel, icon: <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} /> },
            ] : []),
        ];

        return (
            <DropdownMenu
                key={`discarded-${message.id}`}
                open={menuOpen}
                onOpenChange={(next) => {
                    setOpenMenuKey(next ? menuKey : null);
                    if (!next) {
                        setMenuPressAnchor((current) => current?.menuKey === menuKey ? null : current);
                    }
                }}
                items={menuItems}
                onSelect={async (itemId) => {
                    setOpenMenuKey(null);
                    if (itemId === 'copy') await copyPendingMessageText(message);
                    if (itemId === 'requeue') await handleRequeueDiscarded(message.id);
                    if (itemId === 'remove') await handleRemoveDiscarded(message.id);
                    if (itemId === 'steerNow') await handleSteerDiscardedNow(message);
                    if (itemId === 'sendNow') await handleSendDiscardedNow(message);
                }}
                popoverAnchor={menuAnchor}
                placement="auto-vertical"
                gap={6}
                matchTriggerWidth={menuAnchor ? false : undefined}
                trigger={({ openMenu, closeMenu }) => (
                    <View
                        testID={`pendingMessages.discarded.row:${message.id}`}
                        style={[styles.userMessageWrapper, { opacity: 0.85 }]}
                        {...(!isWeb ? { pointerEvents: 'box-none' as const } : null)}
                        {...(isWeb
                            ? {
                                onPointerEnter: () => setHoveredMessageId(message.id),
                                onPointerLeave: () => setHoveredMessageId((prev) => (prev === message.id ? null : prev)),
                            }
                            : null)}
                    >
                        <Pressable
                            onPress={(event) => {
                                if (menuOpen) {
                                    closeMenu();
                                    return;
                                }
                                const anchor = resolvePendingMessageMenuPressAnchor(event);
                                setMenuPressAnchor(anchor ? { menuKey, anchor } : null);
                                openMenu();
                            }}
                            testID={`pendingMessages.discarded.message:${message.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={text || t('session.pendingMessages.discarded.label')}
                            style={({ pressed }) => ([
                                styles.userMessageBubble,
                                { backgroundColor: theme.colors.input.background, opacity: pressed ? 0.75 : 0.82 },
                            ])}
                        >
                            <Text numberOfLines={collapsedLines} style={{ color: theme.colors.text.primary, ...Typography.default() }}>
                                {text}
                            </Text>
                            <Text style={{ marginTop: 6, color: theme.colors.text.secondary, fontSize: 12, ...Typography.default('semiBold') }}>
                                {t('session.pendingMessages.discarded.label')}
                            </Text>
                        </Pressable>

                        {isWeb && (!isArchivedUncertainty || Boolean(text)) ? (
                            <View
                                testID={`pendingMessages.discarded.actionsOverlay:${message.id}`}
                                pointerEvents="auto"
                                style={styles.messageActionContainer}
                            >
                                {text ? (
                                    <PendingMessageCopyAction
                                        testID={`pendingMessages.discarded.copy:${message.id}`}
                                        message={message}
                                    />
                                ) : null}
                                {!isArchivedUncertainty ? (
                                    <>
                                        <IconAction
                                            testID={`pendingMessages.discarded.requeue:${message.id}`}
                                            accessibilityLabel={t('session.pendingMessages.actions.requeue')}
                                            icon="arrow-elbow-up-left"
                                            onPress={() => handleRequeueDiscarded(message.id)}
                                        />
                                        <IconAction
                                            testID={`pendingMessages.discarded.remove:${message.id}`}
                                            accessibilityLabel={t('common.remove')}
                                            icon="trash"
                                            onPress={() => handleRemoveDiscarded(message.id)}
                                            tone="destructive"
                                        />
                                        {canSteerNow ? (
                                            <IconAction
                                                testID={`pendingMessages.discarded.steerNow:${message.id}`}
                                                accessibilityLabel={t('session.pendingMessages.actions.steerNow')}
                                                icon="navigation-arrow"
                                                onPress={() => handleSteerDiscardedNow(message)}
                                            />
                                        ) : null}
                                        <IconAction
                                            testID={`pendingMessages.discarded.sendNow:${message.id}`}
                                            accessibilityLabel={sendNowActionLabel}
                                            icon="paper-plane"
                                            onPress={() => handleSendDiscardedNow(message)}
                                        />
                                    </>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                )}
            />
        );
    }, [
        canSteerNow,
        collapsedLines,
        hoveredMessageId,
        handleRequeueDiscarded,
        handleRemoveDiscarded,
        handleSendDiscardedNow,
        handleSteerDiscardedNow,
        isWeb,
        menuPressAnchor,
        openMenuKey,
        sendNowActionLabel,
        theme.colors.input.background,
        theme.colors.text.primary,
        theme.colors.text.secondary,
    ]);

    const displayedDiscarded = React.useMemo(() => {
        return props.discardedMessages.slice().sort((a, b) => a.discardedAt - b.discardedAt);
    }, [props.discardedMessages]);

    const scrollEdge = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });

    // Read at render time: the module-scope stylesheet below evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const messageContentStyle = React.useMemo(
        () => [styles.messageContent, contentMaxWidthStyle],
        [contentMaxWidthStyle],
    );
    const constrainedRowStyle = React.useMemo(
        () => [styles.constrainedRow, contentMaxWidthStyle],
        [contentMaxWidthStyle],
    );

    if (pendingCount <= 0 && discardedCount <= 0) return null;

    const measuredScrollContentHeightPx =
        typeof scrollContentHeightPx === 'number' && Number.isFinite(scrollContentHeightPx) && scrollContentHeightPx > 0
            ? Math.trunc(scrollContentHeightPx)
            : 0;
    const estimatedPendingContentHeightPx =
        pendingCount > 0
            ? pendingCount * reorderEstimatedRowHeightPx
            : 0;
    const effectiveScrollContentHeightPx = Math.max(
        measuredScrollContentHeightPx,
        estimatedPendingContentHeightPx,
    );
    const canExpandPendingQueue =
        clipsQueueContent
        && pendingCount > 0
        && effectiveScrollContentHeightPx > maxHeightPx;
    const isQueueExpanded = canExpandPendingQueue && isPendingQueueExpanded;
    const maxHeight = clipsQueueContent
        ? (isQueueExpanded ? expandedMaxHeightPx : maxHeightPx)
        : undefined;
    const headerLabel =
        pendingCount > 0
            ? `${t('session.pendingMessages.title')} (${pendingCount})`
            : t('session.pendingMessages.discarded.title');
    const clampedViewportHeightPx =
        maxHeight !== undefined && effectiveScrollContentHeightPx > 0
            ? Math.max(1, Math.min(effectiveScrollContentHeightPx, maxHeight))
            : undefined;

    return (
        <View testID="pendingMessages.block" style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
            <View style={messageContentStyle}>
                <View style={styles.userMessageContainer}>
                    <View style={constrainedRowStyle}>
                        <View style={styles.sectionHeader}>
                            <TranscriptSeparatorRow
                                iconName="clock"
                                title={headerLabel}
                                titleTestID="pendingMessages.headerLabel"
                                chipTestID={canExpandPendingQueue ? 'pendingMessages.headerToggle' : undefined}
                                onPress={canExpandPendingQueue ? togglePendingQueueExpanded : undefined}
                                accessibilityLabel={isQueueExpanded ? t('session.pendingMessages.actions.viewLess') : t('session.pendingMessages.actions.viewMore')}
                                subtitle={discardedCount > 0 && pendingCount > 0 ? `${t('session.pendingMessages.discarded.label')} (${discardedCount})` : null}
                                rightAccessory={canExpandPendingQueue ? (
                                    <Icon
                                        name={isQueueExpanded ? 'caret-down' : 'caret-up'}
                                        size={14}
                                        color={theme.colors.text.secondary}
                                    />
                                ) : null}
                                padding="none"
                                chipChrome="minimal"
                            />
                        </View>

                        {showNonSteerableNotice ? (
                            <View
                                testID="pendingMessages.nonSteerableNotice"
                                style={[
                                    styles.nonSteerableNotice,
                                    {
                                        backgroundColor: theme.colors.surface.base,
                                        borderColor: theme.colors.border.default,
                                    },
                                ]}
                            >
                                <Icon name="pause-circle" size={14} color={theme.colors.text.secondary} />
                                <Text
                                    testID={steerBlockedByTerminalDraft ? 'pendingMessages.steerBlockedTerminalDraftNotice' : undefined}
                                    style={[styles.nonSteerableNoticeText, { color: theme.colors.text.secondary }]}
                                >
                                    {steerBlockedByTerminalDraft
                                        ? t('session.pendingMessages.steerBlockedTerminalDraftNotice')
                                        : t('session.pendingMessages.nonSteerableNotice')}
                                </Text>
                                {showTerminalComposerClearAction ? (
                                    <Pressable
                                        testID="pendingMessages.clearTerminalComposer"
                                        accessibilityRole="button"
                                        accessibilityLabel={t('session.pendingMessages.clearComposer.action')}
                                        disabled={terminalComposerClear.busy}
                                        onPress={() => {
                                            void terminalComposerClear.clearTerminalComposer({
                                                expectedStateAtMs: capabilities?.inFlightSteerStateAt,
                                            });
                                        }}
                                        style={({ pressed }) => ([
                                            styles.clearComposerButton,
                                            {
                                                backgroundColor: pressed ? theme.colors.surface.pressedOverlay : theme.colors.surface.base,
                                                borderColor: theme.colors.border.default,
                                                opacity: terminalComposerClear.busy ? 0.6 : 1,
                                            },
                                        ])}
                                    >
                                        {terminalComposerClear.busy ? (
                                            <ActivitySpinner
                                                testID="pendingMessages.clearTerminalComposer.busy"
                                                size="small"
                                                color={theme.colors.text.secondary}
                                            />
                                        ) : (
                                            <Icon name="x-circle" size={14} color={theme.colors.state.danger.foreground} />
                                        )}
                                        <Text style={[styles.clearComposerButtonText, { color: theme.colors.state.danger.foreground }]}>
                                            {terminalComposerClear.busy
                                                ? t('session.pendingMessages.clearComposer.clearing')
                                                : t('session.pendingMessages.clearComposer.action')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        ) : null}

                        <View style={{ position: 'relative' }}>
                            <ScrollView
                                testID="pendingMessages.scroll"
                                style={{ height: clampedViewportHeightPx, maxHeight: maxHeight, marginTop: 0 }}
                                contentContainerStyle={{ paddingTop: 6, paddingBottom: 0 }}
                                ref={scrollRef}
                                nestedScrollEnabled={true}
                                scrollEventThrottle={16}
                                onLayout={(e) => {
                                    setScrollViewportHeightPx(e.nativeEvent.layout.height);
                                    scrollEdge.onViewportLayout(e);
                                }}
                                onContentSizeChange={(w, h) => {
                                    setScrollContentHeightPx(h);
                                    scrollEdge.onContentSizeChange(w, h);
                                }}
                                onScroll={(e) => {
                                    const y = e.nativeEvent.contentOffset.y;
                                    setScrollOffsetY(typeof y === 'number' && Number.isFinite(y) ? Math.max(0, Math.trunc(y)) : null);
                                    scrollEdge.onScroll(e);
                                }}
                            >
                                <PendingMessagesDragReorderList
                                    messages={props.pendingMessages}
                                    longPressMs={200}
                                    scrollRef={scrollRef}
                                    viewportHeightPx={scrollViewportHeightPx}
                                    scrollOffsetY={scrollOffsetY}
                                    onReorderIds={handleReorderIds}
                                    renderItem={({ message, index, renderDragHandle }) => renderMessage({ message, index, renderDragHandle })}
                                />
                                {displayedDiscarded.length > 0 ? (
                                    <View style={{ marginTop: 4 }}>
                                        <Text style={[styles.discardedTitle, { color: theme.colors.text.secondary }]}>
                                            {t('session.pendingMessages.discarded.title')}
                                        </Text>
                                        <Text style={[styles.discardedSubtitle, { color: theme.colors.text.secondary }]}>
                                            {t('session.pendingMessages.discarded.subtitle')}
                                        </Text>
                                        <View style={{ marginTop: 10 }}>
                                            {displayedDiscarded.map(renderDiscardedMessage)}
                                        </View>
                                    </View>
                                ) : null}
                            </ScrollView>

                            <ScrollEdgeFades
                                color={theme.colors.surface.base}
                                edges={{ top: scrollEdge.visibility.top, bottom: scrollEdge.visibility.bottom }}
                            />
                            <ScrollEdgeIndicators
                                color={theme.colors.text.secondary}
                                edges={{ top: scrollEdge.visibility.top, bottom: scrollEdge.visibility.bottom }}
                            />
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}

const PendingMessageCopyAction = React.memo(function PendingMessageCopyAction(props: {
    message: PendingMessage | DiscardedPendingMessage;
    testID: string;
}) {
    const { markCopied, isCopied } = useTemporaryCopyFeedback();
    const copied = isCopied();
    const handlePress = React.useCallback(async () => {
        if (await copyPendingMessageText(props.message)) {
            markCopied();
        }
    }, [markCopied, props.message]);

    return (
        <IconAction
            testID={props.testID}
            accessibilityLabel={t('common.copy')}
            icon={copied ? 'check' : 'copy'}
            onPress={handlePress}
            tone={copied ? 'success' : 'default'}
        />
    );
});

function IconAction(props: {
    icon: IconName;
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
    tone?: 'default' | 'destructive' | 'success';
    disabled?: boolean;
}) {
    const { theme } = useUnistyles();
    const isDestructive = props.tone === 'destructive';
    const tint = isDestructive
        ? theme.colors.state.danger.foreground
        : props.tone === 'success'
            ? theme.colors.state.success.foreground
            : theme.colors.text.secondary;
    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            disabled={props.disabled === true}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={props.disabled === true ? { disabled: true } : undefined}
            style={({ pressed }) => ({
                padding: 2,
                borderRadius: 6,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed && props.disabled !== true ? theme.colors.surface.pressedOverlay : 'transparent',
                opacity: props.disabled === true ? 0.35 : pressed ? 1 : 0.65,
                ...(Platform.OS === 'web'
                    ? {
                        cursor: 'pointer' as const,
                        pointerEvents: 'auto' as const,
                    }
                    : null),
            })}
        >
            <Icon name={props.icon} size={14} color={tint} />
        </Pressable>
    );
}

function ReorderDragHandleAffordance(props: {
    accessibilityLabel: string;
    testID?: string;
}) {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            {...(!isWeb ? { pointerEvents: 'none' as const } : null)}
            style={[
                {
                    padding: 2,
                    borderRadius: 6,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.65,
                },
                isWeb ? ({ pointerEvents: 'none' } as const) : null,
            ]}
        >
            <Icon name="list" size={14} color={theme.colors.text.secondary} />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    messageContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    messageContent: {
        flexDirection: 'column',
        flexGrow: 1,
        flexBasis: 0,
    },
    constrainedRow: {
        width: '100%',
    },
    userMessageContainer: {
        maxWidth: '100%',
        flexDirection: 'column',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
    },
    sectionHeader: {
        marginTop: 0,
    },
    pendingAffordanceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    pendingAffordanceText: {
        fontSize: 8,
        ...Typography.default(),
    },
    pendingAffordanceChip: {
        position: 'absolute',
        top: -5,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        borderRadius: 999,
        borderWidth: 0,
        zIndex: 20,
    },
    blockedDeliveryNotice: {
        marginTop: 8,
        alignSelf: 'flex-end',
        maxWidth: '82%',
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 5,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    blockedDeliveryNoticeText: {
        fontSize: 11,
        lineHeight: 14,
        ...Typography.default('semiBold'),
    },
    nonSteerableNotice: {
        marginTop: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    nonSteerableNoticeText: {
        flexShrink: 1,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
    clearComposerButton: {
        marginLeft: 'auto',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    clearComposerButtonText: {
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default('semiBold'),
    },
    userMessageWrapper: {
        maxWidth: '100%',
        alignSelf: 'flex-end',
        position: 'relative',
        paddingBottom: 8,
    },
    userMessageWrapperHovered: {
        zIndex: 60,
    },
    userMessageBubble: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        maxWidth: '100%',
        textAlign: 'left',
    },
    transcriptMarkdownText: {
        ...transcriptMarkdownTextStyle,
    },
    collapsedPlainText: {
        ...Typography.default(),
        fontSize: transcriptMarkdownTextStyle.fontSize,
        lineHeight: transcriptMarkdownTextStyle.lineHeight,
        marginTop: 0,
        marginBottom: 0,
    },
    messageActionContainer: {
        flexDirection: 'row',
        alignSelf: 'flex-end',
        justifyContent: 'flex-end',
        marginTop: 2,
        gap: 3,
    },
    discardedTitle: {
        marginTop: 6,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    discardedSubtitle: {
        marginTop: 4,
        fontSize: 12,
        ...Typography.default(),
    },
}));
