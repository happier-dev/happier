import * as React from 'react';
import type { UserTextMessage, AgentTextMessage } from '@happier-dev/session-core/messages';
import { buildMessageRouteId } from '@happier-dev/session-core/messages';
import type { PersistedSessionMessagePinV1 } from '@happier-dev/session-core/pins';
import type { IconName } from '@/components/ui/icons/Icon';
import type { ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import type { TranscriptSelectableMessageText } from '../messageSelection/_types';
import { useOptionalTranscriptSelectionActions, useOptionalTranscriptSelectionRow } from '../messageSelection/TranscriptMessageSelectionContext';
import type { TranscriptForkCommon, TranscriptMessageDisplayCommon } from '../transcriptSessionCommon';
import { canForkFromMessage } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveForkFromMessageSemantics } from '@/sync/domains/sessionFork/forkFromMessageSemantics';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { executeTranscriptRollbackAction } from '../transcriptRollbackActionRunner';
import { resolveMessagePinAvailability, buildSessionMessagePinAtPressTime } from './resolveMessagePinAvailability';
import { useForkMessageAction } from './useForkMessageAction';
import { usePluginMessageActions } from './PluginMessageActions';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';

export type CommittedMessageActionId = 'copy' | 'fork' | 'rollback' | 'select' | 'pin' | 'savePrompt' | 'plugins' | 'makeRepeatable';
export type CommittedMessageAction = Readonly<{
    id: CommittedMessageActionId;
    available: boolean;
    title: string;
    accessibilityHint?: string;
    icon: IconName;
    onPress: () => void | Promise<void>;
    menuItems?: readonly ContextMenuItem[];
}>;
export type CommittedMessageActionInput = Readonly<{
    message: UserTextMessage | AgentTextMessage;
    sessionId: string;
    serverId?: string | null;
    selectableText: TranscriptSelectableMessageText | null;
    copyText: string;
    isStructuredOnly: boolean;
    hasUnsupportedContent?: boolean;
    canFork: boolean;
    forkCommon: TranscriptForkCommon;
    isForkAllowed: () => boolean;
    settings: TranscriptMessageDisplayCommon;
    rollbackAction?: TranscriptRollbackAction | null;
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleMessagePin?: (pin: PersistedSessionMessagePinV1) => void;
    openSavePrompt: () => void;
}>;

/** Eligibility and preferences drive BOTH presentations, including recycled rows. */
export function useCommittedMessageActions(input: CommittedMessageActionInput) {
    const { message, settings } = input;
    const makeRepeatableEligible = settings.transcriptMessageMakeRepeatableActionEnabled !== false
        && message.kind === 'agent-text' && !message.isThinking && input.selectableText != null && !input.isStructuredOnly;
    const repeatableServerId = input.serverId ?? input.forkCommon.sessionForkSupportSource?.serverId;
    // Message identity controls capability lifetime; streamed text is read by the action at press time.
    const makeRepeatableSource = React.useMemo(() => makeRepeatableEligible ? {
        sessionId: input.sessionId, serverId: repeatableServerId, messageId: message.id,
    } : null, [makeRepeatableEligible, input.sessionId, repeatableServerId, message.id]);
    const [makeRepeatableCapability, setMakeRepeatableCapability] = React.useState<Readonly<{
        source: NonNullable<typeof makeRepeatableSource>;
        available: boolean;
        openRepeatable: () => void | Promise<void>;
    }> | null>(null);
    const makeRepeatable = makeRepeatableSource && makeRepeatableCapability?.source === makeRepeatableSource
        ? makeRepeatableCapability : null;
    const selectionActions = useOptionalTranscriptSelectionActions();
    const selectionRow = useOptionalTranscriptSelectionRow(message.id);
    const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : null;
    const forkSemantics = seq == null ? null : resolveForkFromMessageSemantics({ message, messageSeqInclusive: seq });
    const fork = useForkMessageAction({
        ...input, messageId: message.id, upToSeqInclusive: forkSemantics?.upToSeqInclusive ?? seq ?? 0,
        restoredDraftText: forkSemantics?.restoredDraftText ?? null,
    });
    const pinAvailability = React.useMemo(() => resolveMessagePinAvailability({
        sessionId: input.sessionId, seq,
        transcriptBlockIndex: message.transcriptBlockIndex ?? null,
        routeMessageId: buildMessageRouteId(message),
        role: message.kind === 'user-text' ? 'user' : 'assistant',
        pins: input.messagePins ?? [],
    }), [input.sessionId, seq, message, input.messagePins]);
    const pinned = pinAvailability.status === 'available' && pinAvailability.pinned;
    const pluginActions = usePluginMessageActions({
        enabled: settings.transcriptMessagePluginActionsEnabled !== false,
        messageActionReference: message.messageActionReference,
    });
    const rollbackServerId = input.serverId ?? input.forkCommon.sessionForkSupportSource?.serverId;
    const rollbackExecutor = React.useMemo(() => input.rollbackAction && settings.transcriptMessageRollbackActionEnabled !== false
        ? createDefaultActionExecutor({ resolveServerIdForSessionId: () => rollbackServerId ?? null,
            currentAgentCapabilities: input.rollbackAction.currentAgentCapabilities })
        : null, [input.rollbackAction, rollbackServerId, settings.transcriptMessageRollbackActionEnabled]);
    const [copiedText, setCopiedText] = React.useState<Readonly<{ messageId: string; text: string }> | null>(null);
    const copied = copiedText?.messageId === message.id && copiedText.text === input.copyText;
    const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, [message.id]);
    const copy = async () => {
        if (!await setClipboardStringSafe(input.copyText)) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        setCopiedText({ messageId: message.id, text: input.copyText });
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopiedText(null), 1200);
    };
    const actions: readonly CommittedMessageAction[] = [
        { id: 'rollback', available: input.rollbackAction != null && settings.transcriptMessageRollbackActionEnabled !== false,
            icon: 'arrow-arc-left', title: input.rollbackAction?.target?.type === 'before_user_message'
                ? t('session.rollback.beforeUserMessageA11y') : t('session.rollback.latestTurnA11y'),
            onPress: async () => {
                if (!input.rollbackAction || !rollbackExecutor) return;
                try {
                    await executeTranscriptRollbackAction({ executor: rollbackExecutor, sessionId: input.sessionId,
                        ...input.rollbackAction });
                } catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError')); }
            } },
        { id: 'fork', available: settings.transcriptMessageForkActionEnabled !== false && input.canFork && canForkFromMessage({
            session: input.forkCommon.sessionForkSupportSource, messageSeq: seq,
            replayEnabled: input.forkCommon.sessionReplayEnabled, agentSwitchingEnabled: input.forkCommon.agentSwitchingEnabled,
            currentAgentCapabilities: input.forkCommon.currentAgentCapabilities,
        }), icon: 'git-branch', title: t('session.forking.forkFromMessageA11y'), onPress: fork },
        { id: 'select', available: settings.transcriptMessageSelectionEnabled === true && input.selectableText != null && selectionActions != null,
            icon: 'check-circle', title: t('transcript.selection.enterA11y'), onPress: () => {
                if (selectionRow.isSelectionMode) selectionRow.toggle(); else selectionActions?.enter(message.id);
            } },
        { id: 'plugins', available: settings.transcriptMessagePluginActionsEnabled !== false,
            icon: 'dots-three', title: t('common.moreActions'), onPress: () => undefined,
            menuItems: pluginActions.menuActions.map((action) => ({ id: `plugin:${action.qualifiedActionId}`, title: action.title })) },
        { id: 'savePrompt', available: settings.transcriptMessageSavePromptActionEnabled !== false && message.kind === 'user-text'
            && !input.isStructuredOnly && !input.hasUnsupportedContent && input.selectableText != null,
            icon: 'bookmark-plus', title: t('committedMessageActions.savePrompt'), onPress: input.openSavePrompt },
        { id: 'copy', available: settings.transcriptMessageCopyActionEnabled !== false && input.copyText.trim().length > 0,
            icon: copied ? 'check' : 'copy', title: t('common.copy'), onPress: copy },
        { id: 'makeRepeatable', available: makeRepeatable?.available === true,
            icon: 'arrows-clockwise', title: t('workflows.authoring.repeatable'),
            accessibilityHint: t('workflows.authoring.repeatableDescription'), onPress: () => makeRepeatable?.openRepeatable() },
        { id: 'pin', available: input.onToggleMessagePin != null && pinAvailability.status === 'available'
            && (settings.transcriptMessagePinActionEnabled !== false || pinned),
            icon: pinned ? 'push-pin-slash' : 'push-pin', title: pinned ? t('session.transcriptNavigation.unpinMessageA11y') : t('session.transcriptNavigation.pinMessageA11y'),
            onPress: () => { if (pinAvailability.status === 'available') input.onToggleMessagePin?.(buildSessionMessagePinAtPressTime(pinAvailability.pinTarget)); } },
    ];
    return { actions, pinAvailability, pluginActions, makeRepeatableSource, setMakeRepeatableCapability };
}
