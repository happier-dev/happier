import * as React from 'react';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
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
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { resolveCommittedMessageRef } from './resolveCommittedMessageRef';
import type { DiscussionSecondOpinionSourceV1 } from '@happier-dev/protocol/discussions/secondOpinion';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { useSessionSelector } from '@/sync/store/hooks';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { VoiceSayActionResultSchema } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { ReadAloudReadiness } from './ReadAloudReadinessSubscription';
import { resolveVoiceProviderReadinessPresentation, translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import { resolveVoiceSettingsRecoveryTarget } from '@/voice/settings/voiceSettingsRouteFocus';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useOptionalSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';

const executeSpeechAction = createFrontDoorUiActionExecutor();

export type CommittedMessageActionId = 'copy' | 'fork' | 'rollback' | 'select' | 'pin' | 'savePrompt' | 'plugins' | 'makeRepeatable' | 'secondOpinion' | 'discuss' | 'saveDecision' | 'readAloud';
export type CommittedMessageAction = Readonly<{
    id: CommittedMessageActionId;
    available: boolean;
    title: string;
    accessibilityHint?: string;
    disabled?: boolean;
    disabledReason?: string;
    disabledRecovery?: Readonly<{ title: string; onPress: () => void }>;
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
    /** Opens the Save as decision sheet for this exact committed message (C6). */
    openSaveDecision?: (source: SessionMessageRefV1) => void;
    /** The L7 presentation owner opens a prepared draft; entry never grants or asks. */
    openDiscussionSource?: (source: DiscussionSecondOpinionSourceV1, intent: 'second_opinion' | 'discuss') => void;
}>;

/** Eligibility and preferences drive BOTH presentations, including recycled rows. */
export function useCommittedMessageActions(input: CommittedMessageActionInput, presentation: Readonly<{
    rowVisible: boolean;
    menuVisible: boolean;
}> = { rowVisible: true, menuVisible: false }) {
    const { message, settings } = input;
    const router = useRouter();
    const transcriptSource = useOptionalSessionTranscriptSource();
    const readableAssistantMessage = message.kind === 'agent-text' && !message.isThinking && input.selectableText != null
        && !input.isStructuredOnly && !input.hasUnsupportedContent;
    const readAloudEligible = readableAssistantMessage && input.copyText.trim().length > 0;
    const [readAloudReadiness, setReadAloudReadiness] = React.useState<ReadAloudReadiness | null>(null);
    const readAloudRecoveryTarget = readAloudReadiness ? resolveVoiceSettingsRecoveryTarget(readAloudReadiness) : null;
    const readAloudPresentation = readAloudReadiness
        ? resolveVoiceProviderReadinessPresentation(readAloudReadiness, translateVoiceReadiness) : null;
    const readAloudRecovery = readAloudRecoveryTarget && readAloudPresentation?.action
        ? { title: readAloudPresentation.action, onPress: () => router.push(readAloudRecoveryTarget) } : undefined;
    const observeReadAloudReadiness = readAloudEligible && (presentation.rowVisible || presentation.menuVisible);
    const makeRepeatableEligible = settings.transcriptMessageMakeRepeatableActionEnabled !== false
        && message.kind === 'agent-text' && !message.isThinking && input.selectableText != null && !input.isStructuredOnly;
    const repeatableServerId = input.serverId ?? input.forkCommon.sessionForkSupportSource?.serverId;
    const writeClipboard = useClipboardWrite(repeatableServerId, { enabled: presentation.rowVisible || presentation.menuVisible });
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
        pinActionEnabled: settings.transcriptMessagePinActionEnabled,
    }), [input.sessionId, seq, message, input.messagePins, settings.transcriptMessagePinActionEnabled]);
    const pinned = pinAvailability.status === 'available' && pinAvailability.pinned;
    const pluginActions = usePluginMessageActions({
        enabled: settings.transcriptMessagePluginActionsEnabled !== false,
        messageActionReference: message.messageActionReference,
        rowVisible: presentation.rowVisible,
        menuVisible: presentation.menuVisible,
    });
    const rollbackServerId = input.serverId ?? input.forkCommon.sessionForkSupportSource?.serverId;
    const rollbackExecutor = React.useMemo(() => input.rollbackAction && settings.transcriptMessageRollbackActionEnabled !== false
        ? createDefaultActionExecutor({ resolveServerIdForSessionId: () => rollbackServerId ?? null,
            currentAgentCapabilities: input.rollbackAction.currentAgentCapabilities })
        : null, [input.rollbackAction, rollbackServerId, settings.transcriptMessageRollbackActionEnabled]);
    const { copy: copyWithFeedback, isCopied } = useHappierCopyFeedback();
    const copyKey = React.useMemo(() => JSON.stringify([message.id, input.copyText]), [message.id, input.copyText]);
    const copied = isCopied(copyKey);
    // The exact committed agent answer, when this row has one; Discuss, Second opinion and Save as decision share it.
    const committedMessage = readableAssistantMessage ? resolveCommittedMessageRef(input) : null;
    const committedSource = input.openDiscussionSource ? committedMessage : null;
    // Save as decision writes to this Session's memory; with memory off there is nothing it could save to.
    const memoryEnabled = useSessionSelector(input.sessionId, input.serverId,
        (session) => session !== null && readSessionMemoryEnabledV1(readSessionOwnerMetadataView(session)));
    const copy = async () => {
        if (!await copyWithFeedback(() => writeClipboard(input.copyText), copyKey)) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        }
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
        { id: 'readAloud', available: readAloudEligible, disabled: readAloudReadiness?.status !== 'ready',
            disabledReason: readAloudReadiness?.status === 'ready' ? undefined
                : [translateVoiceReadiness(readAloudReadiness?.reasonKey ?? 'voice.readiness.runtime_unknown'),
                    readAloudRecovery?.title].filter(Boolean).join(' · '),
            disabledRecovery: readAloudRecovery,
            icon: 'speaker-high', title: t('committedMessageActions.readAloud'), onPress: async () => {
                try {
                    const sessionAddress = normalizeSessionAddress(input.serverId
                        ?? (transcriptSource?.sessionId === input.sessionId ? transcriptSource.serverId : null), input.sessionId);
                    const result = VoiceSayActionResultSchema.parse(await executeSpeechAction('ui.voice_global.say.start', { text: input.copyText },
                        sessionAddress ? { voiceSpeechSource: { sessionAddress, routeMessageId: buildMessageRouteId(message) } } : undefined));
                    if (result.status !== 'unavailable') return;
                } catch { /* The Action owns typed refusal; presentation never exposes transport or provider prose. */ }
                Modal.alert(t('common.error'), t('settingsVoice.local.machineErrors.tts_failed'));
            } },
        { id: 'makeRepeatable', available: makeRepeatable?.available === true,
            icon: 'arrows-clockwise', title: t('workflows.authoring.repeatable'),
            accessibilityHint: t('workflows.authoring.repeatableDescription'), onPress: () => makeRepeatable?.openRepeatable() },
        { id: 'secondOpinion', available: committedSource !== null,
            icon: 'scales', title: t('workflows.page.fields.secondOpinion'),
            onPress: () => { if (committedSource) input.openDiscussionSource?.({ kind: 'session', message: committedSource }, 'second_opinion'); } },
        { id: 'discuss', available: committedSource !== null,
            icon: 'chats-circle', title: t('workflows.review.discuss'),
            onPress: () => { if (committedSource) input.openDiscussionSource?.({ kind: 'session', message: committedSource }, 'discuss'); } },
        { id: 'saveDecision', available: committedMessage !== null && memoryEnabled && input.openSaveDecision != null,
            icon: 'check-circle', title: t('memoryContext.memory.saveAsDecision'),
            onPress: () => { if (committedMessage) input.openSaveDecision?.(committedMessage); } },
        { id: 'pin', available: input.onToggleMessagePin != null && pinAvailability.status === 'available',
            icon: pinned ? 'push-pin-slash' : 'push-pin', title: pinned ? t('session.transcriptNavigation.unpinMessageA11y') : t('session.transcriptNavigation.pinMessageA11y'),
            onPress: () => { if (pinAvailability.status === 'available') input.onToggleMessagePin?.(buildSessionMessagePinAtPressTime(pinAvailability.pinTarget)); } },
    ];
    return { actions, pinAvailability, pluginActions, makeRepeatableSource, setMakeRepeatableCapability, committedMessage,
        observeReadAloudReadiness, setReadAloudReadiness };
}
