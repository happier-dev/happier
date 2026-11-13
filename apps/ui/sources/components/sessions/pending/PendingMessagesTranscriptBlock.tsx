import { isSessionRuntimeRunning } from '@/sync/domains/session/attention/runtimePresentation';
import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { isPendingMessageForRecipient } from '@/sync/domains/pending/pendingMessageRecipient';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { useIsMachineListSettled, useServerScopedMachine, useSession, useSetting } from '@/sync/domains/state/storage';
import { isSessionMachineAccessRemoved } from '@/components/sessions/access/sessionMachineAccessRemoved';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { sync } from '@/sync/sync';
import { canSteerUserMessageNow, supportsInFlightSteerUserMessage } from '@/sync/domains/session/control/submitMode';
import { derivePendingMessagesRuntimePresentation, getPendingMaterializingKey, getPendingMessageSendPresentation, sendPendingMessageWithIntent } from './pendingMessageSendActions';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
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
import { fireAndForget } from '@/utils/system/fireAndForget';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { PendingMessagesDragReorderList } from './PendingMessagesDragReorderList';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import {
    getPendingMessageVisualState,
    isAcceptedLocalPendingProjection,
    isLaunchOwnedPendingMessage,
    canUseDirectPendingDeliveryActions,
    isNextTurnHostInput,
    isPendingMessageProviderDeliveryInFlight,
    paintsPendingMessageActionRow,
    resolvePendingMessagesPresentation,
    resolvePendingMessageContentPresentation,
    type PendingMessagesPresentationByRecipient,
} from './pendingMessageVisualState';
import {
    clampsPendingMessageLines,
    PENDING_QUEUE_TOP_INSET_PX,
    PENDING_QUEUE_SCROLL_PADDING_TOP_PX,
    estimatePendingFollowNoticeHeightPx,
    resolvePendingFollowNoticePullUpPx,
    resolvePendingMessageGapPx,
    resolvePendingQueueMessagePresentation,
    resolvePendingQueueScrollMaxHeightPx,
} from './pendingQueueContentClipping';
import { useTerminalComposerClearAction } from '@/components/sessions/terminalComposer/useTerminalComposerClearAction';
import { usePendingInputInterruptAndRunAction } from './usePendingInputInterruptAndRunAction';
import {
    resolvePendingDeliveryLabelKeyForSession,
    resolvePendingDeliveryTransientActionForSession,
} from '@/agents/registry/registryUiBehavior';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolvePendingInputServerWireMode } from '@/sync/engine/pending/pendingInputServerWireContract';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { SessionMessageAccountByline } from '@/components/sessions/transcript/SessionMessageAccountByline';
import { EVENT_ICON_CONTAINER_SIZE, TranscriptEventRow, TranscriptFollowSourceAction, TranscriptFollowSourceNotice } from '@/components/sessions/transcript/events/TranscriptEventRow';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useSessionMessageAuthorshipScope } from '@/components/sessions/transcript/useSessionMessageAuthorshipScope';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { UserMessageBubble, userMessageBubbleAlignerStyle, userMessageBubbleContentPadding } from '@/components/sessions/transcript/UserMessageBubble';
import type { PendingMessageWithdrawRecoveryResult } from '@/components/sessions/composer/pendingMessageComposerDocumentOwner';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionPendingWithdrawResultV1Schema } from '@happier-dev/protocol/sessions/control/pendingWithdrawV1';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

const PENDING_AFFORDANCE_ICON_SIZE_PX = 12;
const QUEUE_GUTTER_PX = 16;
/**
 * A queued row's action band: its actions sit this far apart, this far under the bubble, over the row's bottom inset.
 * With the half-gap reach below, each drawn 18 px action gets a 24 px target on both axes (the WCAG 2.5.8 floor)
 * without growing the glyph, and the band paints at the committed row's 22 px.
 */
const MESSAGE_ACTION_SIZE_PX = 18;
const MESSAGE_ACTION_GLYPH_PX = 14;
const MESSAGE_ACTION_GAP_PX = 6;
const MESSAGE_ACTION_ROW_MARGIN_TOP_PX = 4;
const MESSAGE_ROW_PADDING_BOTTOM_PX = 8;
/**
 * Each action's hit area takes half of every real gap: to its neighbours, to the bubble's own press target
 * above, and to the next row below. A tap on one action never lands on the one beside it (Remove included).
 */
const MESSAGE_ACTION_HIT_REACH = Object.freeze({
    left: MESSAGE_ACTION_GAP_PX / 2,
    right: MESSAGE_ACTION_GAP_PX / 2,
    top: MESSAGE_ACTION_ROW_MARGIN_TOP_PX / 2,
    bottom: MESSAGE_ROW_PADDING_BOTTOM_PX / 2,
});

function getPendingText(message: PendingMessage | DiscardedPendingMessage): string {
    const raw = (message.displayText ?? message.text) ?? '';
    return readableMessageText(String(raw), message.rawRecord?.meta);
}

/** The opening words of a pending message, enough to name it (one line, cut at a word). */
function excerptPendingText(message: PendingMessage): string {
    const text = getPendingText(message).replace(/\s+/g, ' ').trim();
    if (text.length <= 48) return text;
    const cut = text.slice(0, 48);
    const atWord = cut.lastIndexOf(' ');
    return `${(atWord > 24 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

async function copyPendingMessageText(message: PendingMessage | DiscardedPendingMessage, writeClipboard: (text: string) => Promise<boolean>): Promise<boolean> {
    const text = getPendingText(message).trim();
    if (!text) return false;
    try {
        const copied = await writeClipboard(text);
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

function isSessionRuntimeWorking(
    session: ReturnType<typeof useSession>,
    pendingMessages: ReadonlyArray<PendingMessage> = [],
): boolean {
    return derivePendingMessagesRuntimePresentation(session, pendingMessages).working;
}

export type PendingMessageEditRequest = Readonly<{
    id: string;
    text: string;
    displayText?: string;
    message: PendingMessage;
    /** Ordinary editing retains queue custody; withdrawal requires confirmed owner removal. */
    mode?: 'edit' | 'withdraw';
    /** Host-only receipt from the direct UI confirmation, never an Action input. */
    withdrawalConfirmed?: true;
}>;

export type PendingMessageEditHandler = (request: PendingMessageEditRequest) => void | Promise<void | PendingMessageWithdrawRecoveryResult>;

export function PendingMessagesTranscriptBlock(props: Readonly<{
    sessionId: string;
    /**
     * The exact Home this queue belongs to, carried by the mounted transcript
     * host. Raw Session IDs repeat across Homes, so authorship bylines and the
     * pending wire-mode decision must be resolved against this Home rather than
     * whichever one happens to be active. Omitted only by a host that has no
     * qualified target yet, which keeps the historical active-Home behavior.
     */
    serverId?: string | null;
    recipient?: PendingMessage['recipient'];
    pendingMessages: readonly PendingMessage[];
    /** Complete queue context when this block paints only one committed transcript slot. */
    pendingQueueContexts?: PendingMessagesPresentationByRecipient;
    discardedMessages: readonly DiscardedPendingMessage[];
    onEditPendingMessage?: PendingMessageEditHandler;
    /**
     * The painted height of one queued utterance's message bubble, reported on every layout of the
     * HEAD's bubble. The transcript carries it to the committed row that replaces this one so the
     * crossover frame is placed from a measurement instead of a wrap heuristic — see
     * `TranscriptMeasurementReconciler.recordPaintedUtteranceBubbleHeight`.
     */
    onPaintedUtteranceBubbleMeasured?: (measurement: Readonly<{ localId: string; bubbleHeightPx: number }>) => void;
}>) {
    // One exact-Home authorship owner, shared with the committed transcript rows,
    // so a queued utterance and the committed message it becomes cannot disagree
    // about who authored it or whether this Session has another named collaborator.
    const authorship = useSessionMessageAuthorshipScope(props.sessionId, props.serverId);
    const accountActorViewerScope = authorship.viewerScope;
    const writeClipboard = useClipboardWrite(accountActorViewerScope);
    const pendingRecoveryExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const queueContext = React.useMemo(() => props.pendingQueueContexts?.get(props.recipient?.runId) ?? resolvePendingMessagesPresentation(
        props.pendingMessages.filter((message) => isPendingMessageForRecipient(message, props.recipient)),
    ), [props.pendingQueueContexts, props.pendingMessages, props.recipient]);
    const pendingMessages = queueContext.messages;
    const visiblePendingMessageIds = React.useMemo(() => new Set(props.pendingMessages.map((message) => message.id)), [props.pendingMessages]);
    const discardedMessages = React.useMemo(() => props.discardedMessages.filter((message) =>
        isPendingMessageForRecipient(message, props.recipient)
    ), [props.discardedMessages, props.recipient]);
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const exactSessionAddress = React.useMemo(
        () => normalizeSessionAddress(props.serverId, props.sessionId),
        [props.serverId, props.sessionId],
    );
    const exactPendingQueueOwner = React.useMemo(
        () => exactSessionAddress ? { serverId: exactSessionAddress.serverId } : undefined,
        [exactSessionAddress],
    );
    const terminalComposerClear = useTerminalComposerClearAction(props.sessionId, exactSessionAddress?.serverId);
    const pendingInputInterruptAndRun = usePendingInputInterruptAndRunAction(props.sessionId, exactSessionAddress?.serverId);
    const pendingInputServerId = props.serverId?.trim()
        || session?.serverId
        || resolvePreferredServerIdForSessionId(props.sessionId);
    const reachableMachineTarget = useSessionReachableMachineTarget(props.sessionId, pendingInputServerId);
    const machineId = reachableMachineTarget?.machineId ?? (session ? readSessionOwnerMetadataView(session)?.machineId : undefined);
    const machinePresent = useServerScopedMachine(pendingInputServerId, machineId, Boolean);
    const machineInventorySettled = useIsMachineListSettled(pendingInputServerId);
    const machineAccessRemoved = isSessionMachineAccessRemoved({ session, machineId,
        machinePresent, inventorySettled: machineInventorySettled });
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(pendingInputServerId ?? null, {
        enabled: Boolean(pendingInputServerId),
    });
    const pendingInputServerWireMode = resolvePendingInputServerWireMode(serverFeaturesSnapshot);

    const runtimePresentation = derivePendingMessagesRuntimePresentation(session, pendingMessages, queueContext);
    const runtimeWorking = runtimePresentation.working;
    const canSteerNow = canSteerUserMessageNow({ session });
    const supportsInFlightSteer = supportsInFlightSteerUserMessage({ session });
    const capabilities = session?.agentState?.capabilities;
    const pendingCount = pendingMessages.length;
    const discardedCount = discardedMessages.length;
    const hasProviderDeliveryInFlight = queueContext.hasProviderDeliveryInFlight;
    // A terminal-composer-draft capability is meaningful only while a runtime (TUI) is live;
    // after a stop the sticky capability must not present a ghost draft for the next send.
    const hasActiveRuntime = session?.active === true;
    const steerBlockedByTerminalDraft =
        hasActiveRuntime
        && (
            capabilities?.inFlightSteerUnavailableReason === 'user_terminal_draft'
            || capabilities?.terminalComposerDraftPresent === true
        );
    const ownsQueueNotice = visiblePendingMessageIds.has(pendingMessages[0]?.id ?? '');
    const showTerminalComposerClearAction = Boolean(
        ownsQueueNotice
        && steerBlockedByTerminalDraft
        && capabilities?.terminalComposerClearSupported !== false
    );
    const showNonSteerableNotice = Boolean(
        ownsQueueNotice
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
    const pendingQueueRuntimeReachable = session ? isSessionRuntimeRunning(session) : false;
    const { sendNowActionLabel } = getPendingMessageSendPresentation(session);
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
    React.useEffect(() => {
        // An emptied queue starts compact again when the next message arrives.
        if (pendingCount <= 0) setIsPendingQueueExpanded(false);
    }, [pendingCount]);
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
    // The first row the queue is stuck on, read from that row's own state: rows after it say they
    // wait behind it and name it, instead of a bare "Queued" (C3 U2 held Discussion carriers).
    // Several queued updates from one source read as one notice. Presentation only: every row stays in the
    // queue, in order, with its own delivery; a folded row just paints nothing of its own.
    const pendingActivationActiveAt = session?.activeAt;
    const pendingActivationAuthorization = session?.pendingActivationAuthorization;
    const pendingActivationFailureDetails = session?.pendingActivationFailureDetails;
    const pendingPresentation = React.useMemo(() => resolvePendingMessagesPresentation(pendingMessages, { materializingLocalIds, machineAccessRemoved, visibleMessageIds: visiblePendingMessageIds, queueContext,
        session: pendingActivationActiveAt === undefined ? null : { activeAt: pendingActivationActiveAt,
            pendingActivationAuthorization, pendingActivationFailureDetails } }),
        [materializingLocalIds, pendingMessages, pendingActivationActiveAt, pendingActivationAuthorization, pendingActivationFailureDetails, machineAccessRemoved, visiblePendingMessageIds, queueContext]);
    const blockedPendingExcerpt = pendingPresentation.blockedMessage ? excerptPendingText(pendingPresentation.blockedMessage) : '';
    const lastShownPendingIndex = pendingPresentation.shownRows.at(-1)?.index ?? -1;
    const notifyLayoutMutation = useTranscriptRowLayoutMutation();
    // Local materialization can unfold notices without a new queue item/signature. Reuse the row
    // shell's content-change owner to release its reservation before the new natural layout lands.
    const localFoldKey = pendingPresentation.foldKey;
    const previousLocalFoldKey = React.useRef(localFoldKey);
    React.useLayoutEffect(() => {
        if (previousLocalFoldKey.current === localFoldKey) return;
        previousLocalFoldKey.current = localFoldKey;
        notifyLayoutMutation({ reason: 'content-change', sourceId: 'pending-queue' });
    }, [localFoldKey, notifyLayoutMutation]);

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

    const handleEdit = React.useCallback(async (message: PendingMessage) => {
        await props.onEditPendingMessage?.({
            id: message.id,
            text: message.text,
            displayText: message.displayText,
            message,
        });
    }, [props.onEditPendingMessage]);

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

    const executePendingRecovery = React.useCallback(async (
        actionId: 'session.pending.markHandled' | 'session.pending.dismiss' | 'session.pending.sendAsNew' | 'session.pending.withdraw' | 'session.pending.requeue',
        message: Pick<PendingMessage, 'id' | 'localId' | 'recipient'>,
    ) => {
        if (!accountActorViewerScope) throw new Error('action_account_scope_changed');
        const { serverId, accountId } = accountActorViewerScope;
        const result = await pendingRecoveryExecutor.execute(actionId, {
            sessionId: props.sessionId, localId: message.localId ?? message.id, serverId,
            ...(message.recipient ? { targetExecutionRunId: message.recipient.runId } : {}),
        }, { surface: 'ui', authority: 'present_user', defaultSessionId: props.sessionId, serverId, expectedAccountId: accountId });
        if (!result.ok && !isActionApprovalDeclinedErrorCode(result.errorCode)) throw new Error(result.error);
        return result.ok ? result.result : null;
    }, [accountActorViewerScope, pendingRecoveryExecutor, props.sessionId]);

    const handleRemove = React.useCallback(async (message: Pick<PendingMessage, 'id' | 'localId' | 'recipient'>) => {
        if (!await Modal.confirm(t('session.pendingMessages.removeConfirm.title'),
            t('session.pendingMessages.removeConfirm.body'), { confirmText: t('common.remove'), destructive: true })) return;
        try {
            const result = await executePendingRecovery('session.pending.withdraw', message);
            const settled = SessionPendingWithdrawResultV1Schema.safeParse(result);
            if (settled.success && settled.data.outcome !== 'removed') {
                Modal.alert(t('common.error'), t('session.pendingMessages.errors.deleteFailed'));
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.deleteFailed'));
        }
    }, [executePendingRecovery]);

    // The same public Action agents use (`session.draft.open`): the saved draft keeps the text and attachments.
    const handleOpenLaunchDraft = React.useCallback((draftId: string) => {
        if (!accountActorViewerScope) return;
        const { serverId, accountId } = accountActorViewerScope;
        fireAndForget(pendingRecoveryExecutor.execute('session.draft.open', { draftId },
            { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: accountId }), { tag: 'PendingMessages.openLaunchDraft' });
    }, [accountActorViewerScope, pendingRecoveryExecutor]);

    const handleDismissDelivery = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await executePendingRecovery('session.pending.dismiss', message);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.discardFailed'));
            }
        });
    }, [executePendingRecovery, runPendingDeliveryAction]);

    const handleSendAsNew = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await executePendingRecovery('session.pending.sendAsNew', message);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
            }
        });
    }, [executePendingRecovery, runPendingDeliveryAction]);

    const handleRetrySend = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await sync.retryPendingMessageSend(
                    props.sessionId,
                    message.localId ?? message.id,
                    ...(exactPendingQueueOwner ? [exactPendingQueueOwner] as const : [] as const),
                );
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.sendFailed'));
            }
        });
    }, [exactPendingQueueOwner, props.sessionId, runPendingDeliveryAction]);

    const handleRemoveDelivery = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, () => handleRemove(message));
    }, [handleRemove, runPendingDeliveryAction]);

    const handleMarkDeliveryHandled = React.useCallback(async (message: PendingMessage) => {
        await runPendingDeliveryAction(message, async () => {
            try {
                await executePendingRecovery('session.pending.markHandled', message);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.markHandledFailed'));
            }
        });
    }, [executePendingRecovery, runPendingDeliveryAction]);

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

    const handlePendingSend = React.useCallback(async (message: PendingMessage, deliveryIntent: 'steer_now' | 'interrupt_and_send') => {
        if (!accountActorViewerScope) return;
        await runPendingDeliveryAction(message, () => sendPendingMessageWithIntent({
            sessionId: props.sessionId, serverId: exactPendingQueueOwner?.serverId, session, message, deliveryIntent,
            executor: pendingRecoveryExecutor, expectedAccountId: accountActorViewerScope.accountId,
        }));
    }, [props.sessionId, exactPendingQueueOwner, session, runPendingDeliveryAction, pendingRecoveryExecutor, accountActorViewerScope]);
    const handleSteerNow = React.useCallback((message: PendingMessage) => handlePendingSend(message, 'steer_now'), [handlePendingSend]);
    const handleSendNow = React.useCallback((message: PendingMessage) => handlePendingSend(message, 'interrupt_and_send'), [handlePendingSend]);

    const handleRequeueDiscarded = React.useCallback(async (pendingId: string) => {
        try {
            const message = discardedMessages.find(row => row.id === pendingId);
            if (message) await executePendingRecovery('session.pending.requeue', message);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.restoreFailed'));
        }
    }, [discardedMessages, executePendingRecovery]);

    const handleRemoveDiscarded = React.useCallback(async (pendingId: string) => {
        const message = discardedMessages.find(row => row.id === pendingId);
        if (message) await handleRemove(message);
    }, [discardedMessages, handleRemove]);

    const handleSteerDiscardedNow = React.useCallback(async (message: DiscardedPendingMessage) => {
        if (!accountActorViewerScope) return;
        await sendPendingMessageWithIntent({
        sessionId: props.sessionId, serverId: exactPendingQueueOwner?.serverId, session, message, deliveryIntent: 'steer_now',
        executor: pendingRecoveryExecutor, expectedAccountId: accountActorViewerScope.accountId,
        });
    }, [props.sessionId, exactPendingQueueOwner, session, pendingRecoveryExecutor, accountActorViewerScope]);
    const handleSendDiscardedNow = React.useCallback(async (message: DiscardedPendingMessage) => {
        if (!accountActorViewerScope) return;
        await sendPendingMessageWithIntent({
        sessionId: props.sessionId, serverId: exactPendingQueueOwner?.serverId, session, message, deliveryIntent: 'interrupt_and_send',
        executor: pendingRecoveryExecutor, expectedAccountId: accountActorViewerScope.accountId,
        });
    }, [props.sessionId, exactPendingQueueOwner, session, pendingRecoveryExecutor, accountActorViewerScope]);

    const renderMessage = React.useCallback((args: {
        message: PendingMessage;
        index: number;
        renderDragHandle: (args: Readonly<{ children: React.ReactNode; testID?: string; accessibilityLabel?: string }>) => React.ReactNode;
    }) => {
        const { message, index, renderDragHandle } = args;
        if (!visiblePendingMessageIds.has(message.id)) return null;
        const presentation = pendingPresentation.rowsById.get(message.id)!;
        if (presentation.folded) return null;
        const text = getPendingText(message).trim();
        // The head is the next message to be processed: it keeps the shape it will cross over in.
        const messagePresentation = resolvePendingQueueMessagePresentation(index);
        const isCollapsible = !presentation.isHostInput && clampsPendingMessageLines(messagePresentation)
            && collapseThresholdChars > 0
            && text.length >= collapseThresholdChars;
        // No trailing gap under the last row in the scroll content: that 8px is separation from the
        // row BELOW, and carrying it made the crossover a DOWNWARD step (see the owner module).
        const messageGapPx = resolvePendingMessageGapPx({
            isLastInScrollContent: index === lastShownPendingIndex && discardedCount === 0,
        });
	        const isExpanded = expandedMessageIds[message.id] === true || !isCollapsible;

	        const menuKey = `active:${message.id}`;
	        const menuOpen = openMenuKey === menuKey;
	        const menuAnchor = menuPressAnchor?.menuKey === menuKey ? menuPressAnchor.anchor : undefined;
        // Its Session reader hasn't opened it yet: the bubble holds a placeholder, not the message, so
        // nothing that reads or delivers the content is offered until the real text arrives.
        const isContentLoading = message.pendingDecryption?.kind === 'loading';
        const isHostFollowInput = presentation.isHostInput;
        // A new Bot's first-run seed is the host's line: the person never copies, edits or resends it as their words,
        // and a delivery that cannot run is the Session's failure, said once by its delivery presenter.
        const isHostOnboarding = presentation.hostOnboarding;
        const followInput = presentation.followInput;
        const visualState = getPendingMessageVisualState(message, {
            session,
            machineAccessRemoved,
            materializingLocalIds,
            hasEarlierRow: presentation.hasEarlierRow,
            hasBlockedEarlierRow: presentation.hasBlockedEarlierRow,
            hasProviderDeliveryInFlight,
            runtimeReachable: pendingQueueRuntimeReachable,
            foregroundState: pendingQueueForegroundState,
            deliveryTiming: pendingQueueDeliveryTiming,
            runtimeActivity: pendingQueueRuntimeActivity,
        });
        const deliveryActionBusy = materializingLocalIds.has(getPendingMaterializingKey(message));
        const hasEffectPossibleDelivery = visualState.deliveryMutationPolicy === 'effect_possible';
        // Height-bearing, so the size estimate reads this same predicate rather than restating it.
        const paintsMessageActionRow = paintsPendingMessageActionRow({
            platformIsWeb: isWeb,
            canReorderPendingMessages: pendingMessages.length > 1 && presentation.canReorder,
        });
        const isUncertainDelivery = hasEffectPossibleDelivery && visualState.kind === 'blocked';
        const isServerDeliveryInProgress = isPendingMessageProviderDeliveryInFlight(message)
            && visualState.kind === 'delivering';
        const usesDeliveryResolutionActions =
            !hasEffectPossibleDelivery
            && (visualState.kind === 'blocked' || visualState.kind === 'delivering');
        const isCancellationState = visualState.kind === 'cancelling' || visualState.kind === 'cancel_failed';
        const hasDurableOutboxOperation = message.pendingOutboxOperation === 'enqueue' || message.pendingOutboxOperation === 'cancel';
        // The launch of a new Session owns its first message until it settles: no second writer.
        const launchFailedDraftId = message.pendingLaunch?.state === 'failed' ? message.pendingLaunch.draftId : null;
        const canUsePendingQueueActions =
            !hasEffectPossibleDelivery
            && !hasDurableOutboxOperation
            && !isLaunchOwnedPendingMessage(message)
            && !isAcceptedLocalPendingProjection(message);
        const deliveryBlockedPresentation = visualState.deliveryBlockedPresentation ?? null;
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
            visualState.kind === 'starting'
                ? t('newSession.startingSession')
            : visualState.kind === 'launch_failed'
                ? t('session.pendingMessages.deliveryStatus.notStarted')
            : visualState.kind === 'launch_unresolved'
                ? t('session.pendingMessages.deliveryBlockedReasons.deliveryOutcomeUncertain')
            : visualState.kind === 'delivering' && followInput
                && (!providerDeliveryLabelKey || providerDeliveryLabelKey === 'session.pendingMessages.deliveryStatus.nextTurn')
                ? t('session.pendingMessages.badgeLabel', { count: 0 })
                : visualState.kind === 'delivering'
                ? t(providerDeliveryLabelKey ?? (isNextTurnHostInput(message)
                    ? 'session.pendingMessages.deliveryStatus.nextTurn' : 'session.pendingMessages.deliveryStatus.delivering'))
                : visualState.kind === 'blocked'
                    ? t('session.pendingMessages.deliveryStatus.blocked')
                    : visualState.kind === 'send_failed'
                        ? t('session.pendingMessages.errors.sendFailed')
                    : visualState.kind === 'cancelling'
                        ? t('common.remove')
                    : visualState.kind === 'cancel_failed'
                        ? t('common.error')
                    // A delivery action that needs review is this message's own problem and says so.
                    : visualState.queuedReason === 'unsupported_action'
                        ? t('session.pendingMessages.queuedReasons.unsupportedAction')
                    // Held behind a blocked row is this queue's own fact, not the Session's: say it here.
                    : visualState.queuedReason === 'waiting_for_blocked_predecessor'
                        ? t('session.pendingMessages.queuedReasons.waitingForBlockedPredecessor')
                    // A message waiting its turn wears one quiet "Queued" mark; why the queue waits
                    // is the Session's cause, said once on the composer's status line.
                    : visualState.queuedReason
                        ? t('session.pendingMessages.badgeLabel', { count: 0 })
                    : visualState.queuedRequestedAction === 'steer_now'
                        ? t('session.pendingMessages.actions.steerNow')
                    : visualState.queuedRequestedAction === 'send_now'
                        ? t('session.pendingMessages.actions.sendNow')
                    : t('session.pendingMessages.badgeLabel', { count: 0 });
        // Assistive tech still hears the row's own reason, which the line may not name (an earlier
        // message, the current turn).
        const queuedReasonLabel = visualState.queuedReason === 'waiting_for_foreground_turn'
            ? t('session.pendingMessages.queuedReasons.waitingForForegroundTurn')
            : visualState.queuedReason === 'waiting_for_runtime_activity'
                ? t('session.pendingMessages.queuedReasons.waitingForRuntimeActivity')
                : visualState.queuedReason === 'runtime_activity_unknown'
                    ? t('session.pendingMessages.queuedReasons.runtimeActivityUnknown')
                    : visualState.queuedReason === 'waiting_for_predecessor'
                        ? t('session.pendingMessages.queuedReasons.waitingForPredecessor')
                    : visualState.queuedReason === 'waiting_for_blocked_predecessor'
                        ? t('session.pendingMessages.queuedReasons.waitingForNamedMessage', {
                            excerpt: blockedPendingExcerpt,
                        })
                        : visualState.queuedReason === 'waiting_for_runtime'
                            ? t('session.pendingMessages.queuedReasons.waitingForRuntime')
                            : null;
        // The row's own blocked reason reads on its status line, after the state (the owner decides whether
        // the row states one); assistive tech hears it in full even where the line truncates.
        const blockedDeliveryLabel = presentation.statesBlockedReason && deliveryBlockedPresentation
            ? deliveryBlockedPresentation.message ?? t(deliveryBlockedPresentation.labelKey)
            : null;
        const deliveryStateAccessibilityLabel = [deliveryStateLabel, blockedDeliveryLabel, queuedReasonLabel]
            .filter((part): part is string => Boolean(part)).join('. ');
        const canUseDirectDeliveryActions = canUseDirectPendingDeliveryActions(message, visualState, session);
        const canSendAsNew = message.pendingRecovery?.canSendAsNew === true;

	        const menuItems = (() => {
	            const items: DropdownMenuItem[] = [];
                if (!presentation.canMutate) return items;
                if (text && !isContentLoading && !isHostOnboarding) {
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
	            if (launchFailedDraftId) {
	                items.push({ id: 'openDraft', testID: `pendingMessages.menu.openDraft:${message.id}`, title: t('session.pendingMessages.actions.openDraft'), icon: <Icon name="pencil" size={16} color={theme.colors.text.secondary} /> });
	            } else if (isCancellationState) {
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (visualState.kind === 'send_failed') {
	                items.push({ id: 'retrySend', title: t('session.pendingMessages.actions.retryDelivery'), icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (hasDurableOutboxOperation) {
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (isServerDeliveryInProgress) {
	                if (canSendAsNew && !isHostOnboarding) items.push({ id: 'sendAsNew', testID: `pendingMessages.sendAsNew:${message.id}`, title: t('session.pendingMessages.actions.sendAsNew'), icon: <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (isUncertainDelivery) {
	                items.push({ id: 'continueWaiting', testID: `pendingMessages.continueWaiting:${message.id}`, title: t('session.pendingMessages.actions.continueWaiting'), icon: <Icon name="clock" size={16} color={theme.colors.text.secondary} /> });
	                items.push({ id: 'markDeliveryHandled', testID: `pendingMessages.markDeliveryHandled:${message.id}`, title: t('session.pendingMessages.actions.markHandled'), icon: <Icon name="checks" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'dismissDelivery', testID: `pendingMessages.dismissDelivery:${message.id}`, title: t('session.pendingMessages.actions.dismiss'), icon: <Icon name="archive" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                if (canSendAsNew && !isHostOnboarding) items.push({ id: 'sendAsNew', testID: `pendingMessages.sendAsNew:${message.id}`, title: t('session.pendingMessages.actions.sendAsNew'), icon: <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	            } else if (usesDeliveryResolutionActions) {
	                items.push({ id: 'markDeliveryHandled', title: t('session.pendingMessages.actions.markHandled'), icon: <Icon name="checks" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
	                items.push({ id: 'remove', title: t('common.remove'), icon: <Icon name="trash" size={16} color={theme.colors.text.secondary} />, disabled: deliveryActionBusy });
                } else if (canUsePendingQueueActions) {
		                if (!isContentLoading && !isHostOnboarding) items.push({ id: 'edit', title: t('session.pendingMessages.actions.edit'), icon: <Icon name="pencil" size={16} color={theme.colors.text.secondary} /> });
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
                    if (!presentation.canMutate) return;
                    setOpenMenuKey(null);
                    if (itemId === 'copy') await copyPendingMessageText(message, writeClipboard);
                    if (itemId === 'openDraft' && launchFailedDraftId) handleOpenLaunchDraft(launchFailedDraftId);
                    if (itemId === 'edit') await handleEdit(message);
                    if (itemId === 'remove') {
                        if (usesDeliveryResolutionActions) {
                            await handleRemoveDelivery(message);
                        } else {
                            await handleRemove(message);
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
                            isHostFollowInput ? styles.hostInputContainer : null,
                            { paddingBottom: messageGapPx },
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
                        {(!isHostFollowInput || isHostOnboarding) && <SessionMessageAccountByline
                            messageId={message.id}
                            actor={message.accountActor}
                            viewerScope={accountActorViewerScope}
                            hasOtherNamedCollaborator={authorship.hasOtherNamedCollaborator}
                        />}
                        {/* The bubble is the committed prompt's own surface (`UserMessageBubble`), not a
                            button: its message opens the menu and its "View more" toggles the clamp, side by
                            side, so the web never nests one <button> inside another. Full opacity, like the
                            committed bubble it becomes: a queued utterance that paints dimmer BRIGHTENS one
                            step at the crossover. The delivery state is carried by the status mark, not the ink. */}
                        <PendingUtteranceSurface
                            testID={`pendingMessages.bubble:${message.id}`}
                            isHostFollowInput={isHostFollowInput}
                            onLayout={messagePresentation === 'head' ? (event) => {
                                // The painted height of THIS utterance's bubble surface (padding included),
                                // carried to the committed row that replaces it
                                // (`recordPaintedUtteranceBubbleHeight`). HEAD only, and the head is never
                                // clamped: a backlog row is line-clamped (not the height its twin will have)
                                // and paints a "View more" toggle the committed row never has.
                                const bubbleHeightPx = event?.nativeEvent?.layout?.height;
                                const localId = typeof message.localId === 'string' ? message.localId : null;
                                if (localId === null || typeof bubbleHeightPx !== 'number' || !Number.isFinite(bubbleHeightPx)) return;
                                props.onPaintedUtteranceBubbleMeasured?.({ localId, bubbleHeightPx });
                            } : undefined}
                        >
                            <Pressable
                                disabled={!presentation.canMutate}
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
                                accessibilityRole={presentation.canMutate ? 'button' : undefined}
                                accessibilityLabel={followInput ? t('session.pendingMessages.title') : text || t('session.pendingMessages.title')}
                                style={({ pressed }) => ([
                                    !isHostFollowInput ? styles.userMessageBubbleBody : null,
                                    isCollapsible ? styles.userMessageBubbleBodyAboveToggle : null,
                                    { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
                                ])}
                            >
                                {followInput ? (
                                    <TranscriptFollowSourceNotice followInput={followInput}
                                        count={presentation.aggregate ? presentation.count : undefined}
                                        messageId={message.id} sessionId={props.sessionId} serverId={props.serverId} createdAt={message.createdAt} />
                                ) : isHostFollowInput ? (
                                    <TranscriptEventRow event={{ type: 'message', message: text }}
                                        messageId={message.id} sessionId={props.sessionId} serverId={props.serverId} createdAt={message.createdAt} />
                                ) : isExpanded ? (
                                    <MarkdownView markdown={text} textStyle={styles.transcriptMarkdownText} />
                                ) : (
                                    <Text
                                        numberOfLines={collapsedLines}
                                        style={[styles.collapsedPlainText, { color: theme.colors.text.primary }]}
                                    >
                                        {text}
                                    </Text>
                                )}
                            </Pressable>
                            {isCollapsible ? (
                                <HappierPressable
                                    onPress={() => {
                                        toggleMessageExpanded(message.id);
                                    }}
                                    accessibilityRole="button"
                                    expanded={isExpanded}
                                    testID={`pendingMessages.viewMore:${message.id}`}
                                    style={({ pressed }) => ([
                                        styles.userMessageBubbleToggle,
                                        { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
                                    ])}
                                >
                                    <Text style={{ color: theme.colors.text.link, ...Typography.variant('meta', 'semiBold'),  }}>
                                        {isExpanded ? t('session.pendingMessages.actions.viewLess') : t('session.pendingMessages.actions.viewMore')}
                                    </Text>
                                </HappierPressable>
                            ) : null}
                        </PendingUtteranceSurface>

                        <View style={[styles.pendingStatusRow, isHostFollowInput ? styles.hostStatusRow : null]}>
                            {followInput ? <TranscriptFollowSourceAction followInput={followInput} serverId={props.serverId}
                                testID={`pendingMessages.followSourceOpen:${message.id}`} style={styles.hostSourceAction} /> : null}
                            {isHostOnboarding ? null : <View
                                testID={`pendingMessages.pendingAffordance:${message.id}`}
                                accessible
                                accessibilityLabel={deliveryStateAccessibilityLabel}
                                {...(!isWeb ? { pointerEvents: 'none' as const } : null)}
                                style={[
                                    styles.pendingAffordanceChip,
                                    isWeb ? { pointerEvents: 'none' as const } : null,
                                ]}
                            >
                                {visualState.showSpinner ? (
                                    <ActivitySpinner
                                        testID={`pendingMessages.${visualState.kind}Indicator:${message.id}`}
                                        // The spinner takes the status icon's place at the icon's size, so a
                                        // working state keeps the label's height instead of growing over the bubble.
                                        size={iconMatchedSpinnerSize(PENDING_AFFORDANCE_ICON_SIZE_PX)}
                                        color={theme.colors.text.secondary}
                                    />
                                ) : (
                                    <Icon name={visualState.iconName} size={PENDING_AFFORDANCE_ICON_SIZE_PX} color={theme.colors.text.secondary} />
                                )}
                                <Text
                                    testID={`pendingMessages.pendingAffordanceLabel:${message.id}`}
                                    style={[styles.pendingAffordanceText, { color: theme.colors.text.secondary }]}
                                >
                                    {deliveryStateLabel}
                                </Text>
                                {blockedDeliveryLabel ? <>
                                    <Text style={[styles.pendingAffordanceText, { color: theme.colors.text.secondary }]}>·</Text>
                                    <Text
                                        testID={deliveryBlockedPresentation?.isUnknown ? `pendingMessages.unknownDeliveryStatus:${message.id}` : `pendingMessages.blockedDeliveryReason:${message.id}`}
                                        numberOfLines={1}
                                        style={[styles.pendingAffordanceReasonText, { color: theme.colors.text.secondary }]}
                                    >
                                        {blockedDeliveryLabel}
                                    </Text>
                                </> : null}
                            </View>}

                            {isWeb && presentation.canMutate ? (
                                // The committed message's reveal owner: a queued row's actions keep their
                                // band and fade in on hover or focus, like every transcript row; a delivery
                                // that needs the person keeps its recovery in view.
                                <RowActionRevealSlot
                                    testID={`pendingMessages.actionsOverlay:${message.id}`}
                                    revealed={hoveredMessageId === message.id || menuOpen || (!isHostOnboarding && (visualState.kind === 'send_failed' || launchFailedDraftId !== null || usesDeliveryResolutionActions || isUncertainDelivery))}
                                    style={styles.messageActionContainer}
                                >
                                    {text && !isContentLoading && !isHostOnboarding ? (
                                        <PendingMessageCopyAction
                                            writeClipboard={writeClipboard}
                                            testID={`pendingMessages.copy:${message.id}`}
                                            message={message}
                                        />
                                    ) : null}
                                    {launchFailedDraftId ? (
                                        <IconAction
                                            testID={`pendingMessages.openDraft:${message.id}`}
                                            accessibilityLabel={t('session.pendingMessages.actions.openDraft')}
                                            icon="pencil"
                                            onPress={() => handleOpenLaunchDraft(launchFailedDraftId)}
                                        />
                                    ) : null}
                                    {paintsMessageActionRow && pendingMessages.length > 1 && !hasEffectPossibleDelivery && !isLaunchOwnedPendingMessage(message) ? (
                                        renderDragHandle({
                                            children: null,
                                            testID: `pendingMessages.reorder:${message.id}`,
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
                                    {isServerDeliveryInProgress && canSendAsNew && !isHostOnboarding ? (
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
                                    {isUncertainDelivery && canSendAsNew && !isHostOnboarding ? (
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
                                            onPress={() => handleRemove(message)}
                                            tone="destructive"
                                            disabled={deliveryActionBusy}
                                        />
                                    ) : null}
                                    {canUsePendingQueueActions && !usesDeliveryResolutionActions && !isContentLoading && !isHostOnboarding ? (
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
                                            onPress={() => handleRemove(message)}
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
    	                            </RowActionRevealSlot>
                            ) : !isWeb && paintsMessageActionRow && presentation.canReorder ? (
                                <View style={styles.messageActionContainer}>
                                    {renderDragHandle({
                                        children: null,
                                        testID: `pendingMessages.reorder:${message.id}`,
                                        accessibilityLabel: t('common.reorder'),
                                    })}
                                </View>
                            ) : null}
                        </View>
                    </View>
                )}
            />
        );
    }, [
        accountActorViewerScope,
        writeClipboard,
        authorship.hasOtherNamedCollaborator,
        canSteerNow,
        discardedCount,
        pendingPresentation,
        lastShownPendingIndex,
        props.onPaintedUtteranceBubbleMeasured,
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
        blockedPendingExcerpt,
        isWeb,
        materializingLocalIds,
        machineAccessRemoved,
        menuPressAnchor,
        openMenuKey,
        pendingQueueDeliveryTiming,
        pendingQueueForegroundState,
        pendingQueueRuntimeActivity,
        pendingQueueRuntimeReachable,
        pendingInputInterruptAndRun.busy,
        pendingInputServerWireMode,
        pendingMessages.length,
        visiblePendingMessageIds,
        sendNowActionLabel,
        session,
        theme.colors.border.default,
        theme.colors.surface.base,
        theme.colors.text.link,
        theme.colors.text.secondary,
        theme.colors.message.user.foreground,
        toggleMessageExpanded,
    ]);

    const renderDiscardedMessage = React.useCallback((message: DiscardedPendingMessage, index: number, all: readonly DiscardedPendingMessage[]) => {
        const isLastDiscarded = index === all.length - 1;
        const text = getPendingText(message).trim();
        const { isHostInput: isHostFollowInput, followInput } = resolvePendingMessageContentPresentation(message);
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
                    if (itemId === 'copy') await copyPendingMessageText(message, writeClipboard);
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
                        style={[
                            styles.userMessageWrapper,
                            isHostFollowInput ? styles.hostInputContainer : null,
                            // Same rule the estimate models: no trailing gap under the last row.
                            { paddingBottom: resolvePendingMessageGapPx({ isLastInScrollContent: isLastDiscarded }) },
                            // A discarded prompt dims through its bubble (`UserMessageBubble discarded`); a notice has no bubble.
                            isHostFollowInput ? { opacity: 0.85 } : null,
                        ]}
                        {...(!isWeb ? { pointerEvents: 'box-none' as const } : null)}
                        {...(isWeb
                            ? {
                                onPointerEnter: () => setHoveredMessageId(message.id),
                                onPointerLeave: () => setHoveredMessageId((prev) => (prev === message.id ? null : prev)),
                            }
                            : null)}
                    >
                        {!isHostFollowInput && <SessionMessageAccountByline
                            messageId={message.id}
                            actor={message.accountActor}
                            viewerScope={accountActorViewerScope}
                            hasOtherNamedCollaborator={authorship.hasOtherNamedCollaborator}
                        />}
                        <PendingUtteranceSurface isHostFollowInput={isHostFollowInput} discarded>
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
                            accessibilityLabel={followInput ? t('session.pendingMessages.discarded.label') : text || t('session.pendingMessages.discarded.label')}
                            style={({ pressed }) => ([
                                !isHostFollowInput ? styles.userMessageBubbleBody : null,
                                { opacity: pressed ? motionTokens.press.opacity : 1 },
                            ])}
                        >
                            {followInput ? <TranscriptFollowSourceNotice followInput={followInput}
                                messageId={message.id} sessionId={props.sessionId} serverId={props.serverId} createdAt={message.createdAt} />
                                : isHostFollowInput ? <TranscriptEventRow event={{ type: 'message', message: text }}
                                messageId={message.id} sessionId={props.sessionId} serverId={props.serverId} createdAt={message.createdAt} /> : <Text numberOfLines={collapsedLines} style={{ color: theme.colors.text.primary, ...Typography.default() }}>
                                {text}
                            </Text>}
                            <Text style={[
                                { marginTop: theme.space.s6, color: theme.colors.text.secondary, ...Typography.variant('meta', 'semiBold') },
                                isHostFollowInput ? styles.hostDiscardedLabel : null,
                            ]}>
                                {t('session.pendingMessages.discarded.label')}
                            </Text>
                        </Pressable>
                        </PendingUtteranceSurface>

                        {isWeb && (!isArchivedUncertainty || Boolean(text)) ? (
                            <View
                                testID={`pendingMessages.discarded.actionsOverlay:${message.id}`}
                                pointerEvents="auto"
                                style={styles.messageActionContainer}
                            >
                                {text ? (
                                    <PendingMessageCopyAction
                                        writeClipboard={writeClipboard}
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
        accountActorViewerScope,
        writeClipboard,
        authorship.hasOtherNamedCollaborator,
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
        return discardedMessages.slice().sort((a, b) => a.discardedAt - b.discardedAt);
    }, [discardedMessages]);

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
    const estimatedPendingContentHeightPx = pendingPresentation.shownRows.some(row => row.followInput)
        ? PENDING_QUEUE_SCROLL_PADDING_TOP_PX + pendingPresentation.shownRows.reduce((height, row) => height
            + (row.followInput ? estimatePendingFollowNoticeHeightPx(row, isWeb, pendingCount > 1)
                + resolvePendingMessageGapPx({ isLastInScrollContent: row.index === lastShownPendingIndex && discardedCount === 0 })
                : reorderEstimatedRowHeightPx), 0)
        : pendingPresentation.shownRows.length * reorderEstimatedRowHeightPx;
    const effectiveScrollContentHeightPx = Math.max(
        measuredScrollContentHeightPx,
        estimatedPendingContentHeightPx,
    );
    // The block's painted bound for this presentation. One owner, shared with the size estimate.
    // The queue scrolls inside its compact bound under the edge fades; its titled header (0.2's
    // separation, owner 11-10) expands a queue that overflows that bound and collapses it back.
    const collapsedMaxHeight = resolvePendingQueueScrollMaxHeightPx({
        pendingCount: pendingPresentation.shownRows.length,
        discardedCount,
        queueMaxHeightPx: maxHeightPx,
        lineHeightPx: transcriptMarkdownTextStyle.lineHeight,
    });
    const canExpandPendingQueue = pendingCount > 0 && effectiveScrollContentHeightPx > collapsedMaxHeight;
    const isQueueExpanded = canExpandPendingQueue && isPendingQueueExpanded;
    const maxHeight = isQueueExpanded ? Math.max(expandedMaxHeightPx, collapsedMaxHeight) : collapsedMaxHeight;
    // The section counts what it holds: the queue may continue in another section further down.
    const headerLabel = visiblePendingMessageIds.size > 0
        ? `${t('session.pendingMessages.title')} (${visiblePendingMessageIds.size})`
        : t('session.pendingMessages.discarded.title');
    const clampedViewportHeightPx = effectiveScrollContentHeightPx > 0
        ? Math.max(1, Math.min(effectiveScrollContentHeightPx, maxHeight))
        : undefined;

    return (
        <View testID="pendingMessages.block" style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
            <View style={messageContentStyle}>
                <View style={styles.userMessageContainer}>
                    <View style={constrainedRowStyle}>
                        {/* The header sits in the queue's top inset, so the send crossover keeps its geometry. */}
                        <View style={styles.queueTopInset}>
                            <TranscriptSeparatorRow
                                iconName="clock"
                                title={headerLabel}
                                titleTestID="pendingMessages.headerLabel"
                                chipTestID={canExpandPendingQueue ? 'pendingMessages.headerToggle' : undefined}
                                onPress={canExpandPendingQueue ? () => setIsPendingQueueExpanded(value => !value) : undefined}
                                accessibilityLabel={canExpandPendingQueue
                                    ? `${headerLabel}, ${isQueueExpanded ? t('session.pendingMessages.actions.viewLess') : t('session.pendingMessages.actions.viewMore')}`
                                    : headerLabel}
                                rightAccessory={canExpandPendingQueue ? (
                                    <Icon name={isQueueExpanded ? 'caret-down' : 'caret-up'} size={14} color={theme.colors.text.secondary} />
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
                                contentContainerStyle={{ paddingTop: theme.space.s6, paddingBottom: 0 }}
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
                                    scope={accountActorViewerScope}
                                    sessionId={props.sessionId}
                                    recipient={props.recipient ?? null}
                                    messages={pendingMessages}
                                    presentation={pendingPresentation}
                                    scrollRef={scrollRef}
                                    viewportHeightPx={scrollViewportHeightPx}
                                    contentHeightPx={scrollContentHeightPx}
                                    scrollOffsetY={scrollOffsetY}
                                    renderItem={({ message, index, renderDragHandle }) => renderMessage({ message, index, renderDragHandle })}
                                />
                                {displayedDiscarded.length > 0 ? (
                                    <View style={{ marginTop: theme.space.s4 }}>
                                        <Text style={[styles.discardedTitle, { color: theme.colors.text.secondary }]}>
                                            {t('session.pendingMessages.discarded.title')}
                                        </Text>
                                        <Text style={[styles.discardedSubtitle, { color: theme.colors.text.secondary }]}>
                                            {t('session.pendingMessages.discarded.subtitle')}
                                        </Text>
                                        <View style={{ marginTop: theme.space.s10 }}>
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
    writeClipboard: (text: string) => Promise<boolean>;
    testID: string;
}) {
    const { markCopied, isCopied } = useHappierCopyFeedback();
    const copied = isCopied();
    const handlePress = React.useCallback(async () => {
        if (await copyPendingMessageText(props.message, props.writeClipboard)) {
            markCopied();
        }
    }, [markCopied, props.message, props.writeClipboard]);

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

/**
 * A queued row's icon action: the shared icon-only button at the band's drawn 18 px, quiet like the committed
 * row's actions. Its hit area takes half of each real gap (MESSAGE_ACTION_HIT_REACH), which with the band's
 * gap and margin reaches the 24 px pointer floor on both axes, and further under a finger only into free space.
 */
function IconAction(props: {
    icon: IconName;
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
    tone?: 'default' | 'destructive' | 'success';
    disabled?: boolean;
}) {
    const { theme } = useUnistyles();
    const tint = props.tone === 'destructive' ? theme.colors.state.danger.foreground : theme.colors.text.secondary;
    return (
        <IconButton
            testID={props.testID}
            onPress={props.onPress}
            disabled={props.disabled === true}
            accessibilityLabel={props.accessibilityLabel}
            tooltip={props.accessibilityLabel}
            variant="plain"
            size={MESSAGE_ACTION_SIZE_PX}
            iconSize={MESSAGE_ACTION_GLYPH_PX}
            tone={props.tone === 'destructive' ? 'danger' : 'default'}
            interactiveTargetEdgesPx={{
                leading: MESSAGE_ACTION_HIT_REACH.left,
                trailing: MESSAGE_ACTION_HIT_REACH.right,
                top: MESSAGE_ACTION_HIT_REACH.top,
                bottom: MESSAGE_ACTION_HIT_REACH.bottom,
            }}
            icon={<Icon name={props.icon} size={MESSAGE_ACTION_GLYPH_PX} color={tint} />}
        />
    );
}

/**
 * A queued or discarded prompt's surface: the committed prompt's own bubble (paint, padding, radius, rim and
 * discarded state), so queue→commit changes nothing but the status. Its parts own the padding so the message's
 * press target fills the bubble. A host notice has no bubble and stays a plain event row.
 */
function PendingUtteranceSurface(props: Readonly<{
    isHostFollowInput: boolean;
    discarded?: boolean;
    onLayout?: React.ComponentProps<typeof UserMessageBubble>['onLayout'];
    testID?: string;
    children: React.ReactNode;
}>) {
    if (props.isHostFollowInput) return <View onLayout={props.onLayout} testID={props.testID}>{props.children}</View>;
    // The bubble hugs its own words: a status line under it that runs longer (a blocked reason) widens the
    // row's aligner, not the bubble.
    return (
        <View style={styles.pendingBubbleHug}>
            <UserMessageBubble padding="parts" discarded={props.discarded} onLayout={props.onLayout} testID={props.testID}>
                {props.children}
            </UserMessageBubble>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    pendingBubbleHug: {
        alignSelf: 'flex-end',
        maxWidth: '100%',
    },
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
        paddingHorizontal: QUEUE_GUTTER_PX,
    },
    queueTopInset: {
        height: PENDING_QUEUE_TOP_INSET_PX,
        justifyContent: 'center',
    },
    pendingAffordanceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    // The state and its separator keep their words; only the reason after them gives way.
    pendingAffordanceText: {
        ...Typography.variant('meta'),
        flexShrink: 0,
    },
    // The delivery status reads under the bubble, on the band the committed row keeps for its actions (lab
    // B1): the status first, the revealed actions after it. It is always painted at one line, so a state
    // swap (icon, spinner, label) never moves the row.
    pendingStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-end',
        maxWidth: '100%',
        gap: theme.space.s8,
    },
    // A notice carries the transcript's row rhythm as space below it; its delivery mark reads as that row's
    // own caption, not as the heading of the next one.
    // ...and sits under the notice's own words (past its glyph column), not at the far edge of the queue.
    hostStatusRow: {
        marginTop: -resolvePendingFollowNoticePullUpPx(theme.space),
        alignSelf: 'flex-start',
        marginLeft: EVENT_ICON_CONTAINER_SIZE + theme.space.s10,
    },
    // The action is a text button: its label, not its box, reads on the edge the status label below it uses
    // (the mark and its gap), so it takes the button's own inset back.
    hostSourceAction: {
        marginLeft: PENDING_AFFORDANCE_ICON_SIZE_PX + theme.space.s4 - theme.space.s10,
    },
    // One line whatever the state: a blocked reason truncates rather than wraps, so it never moves the row.
    pendingAffordanceChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        flexShrink: 1,
        minWidth: 0,
    },
    pendingAffordanceReasonText: {
        ...Typography.variant('meta'),
        flexShrink: 1,
        minWidth: 0,
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
        ...Typography.variant('meta'),
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
        ...Typography.variant('meta', 'semiBold'),
    },
    // The queued prompt's aligner: the committed row's silhouette (`userMessageBubbleAlignerStyle`), resolved
    // against the same reading column, so the crossover keeps its width. A notice stretches (hostInputContainer).
    userMessageWrapper: {
        ...userMessageBubbleAlignerStyle,
        position: 'relative',
        paddingBottom: MESSAGE_ROW_PADDING_BOTTOM_PX,
    },
    userMessageWrapperHovered: {
        zIndex: 60,
    },
    // A host notice reads on the transcript column's own edge, like the committed notice it becomes; only
    // the person's bubbles sit inside the queue's gutter.
    hostInputContainer: {
        alignSelf: 'stretch',
        maxWidth: '100%',
        marginLeft: -QUEUE_GUTTER_PX,
    },
    // The notice row reaches back over the queue's gutter (it carries the column's own margin), so its
    // plain label would start at the clip edge of the scrolling queue; it takes the gutter back.
    hostDiscardedLabel: {
        marginLeft: QUEUE_GUTTER_PX,
    },
    // The message is a web <button> that fills the bubble: it carries the bubble's content padding, and its
    // text reads from the bubble's leading edge, like the committed prompt.
    userMessageBubbleBody: {
        ...userMessageBubbleContentPadding(theme),
        textAlign: 'left',
    },
    userMessageBubbleBodyAboveToggle: {
        paddingBottom: 0,
    },
    userMessageBubbleToggle: {
        alignSelf: 'flex-start',
        paddingHorizontal: userMessageBubbleContentPadding(theme).paddingHorizontal,
        paddingTop: theme.space.s6,
        paddingBottom: userMessageBubbleContentPadding(theme).paddingVertical,
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
        marginTop: MESSAGE_ACTION_ROW_MARGIN_TOP_PX,
        gap: MESSAGE_ACTION_GAP_PX,
    },
    discardedTitle: {
        marginTop: 6,
        ...Typography.variant('meta', 'semiBold'),
    },
    discardedSubtitle: {
        marginTop: 4,
        ...Typography.variant('meta'),
    },
}));
