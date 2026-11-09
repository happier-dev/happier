import * as React from 'react';

import type { ParticipantRecipientV1} from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { PendingRequestedActionV1} from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { ScmDiffSummaryDiscussInput } from '@happier-dev/protocol/scm/diffSummaryResult';
import { t } from '@/text';

import type { AgentInputAttachmentsRowItem, AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { readWalkthroughStopContext } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { createRecipientActionChip, type SessionTalkChipBinding } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import {
    resolveParticipantRoutingDescriptor,
    type ParticipantRoutingDescriptor,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';

import { createExecutionRunRequestedActionChip } from './createExecutionRunRequestedActionChip';
import { selectScmDiffSummaryDiscussionResult, selectScmDiffSummaryDiscussionSavedResult, selectScmDiffSummaryResultByRunId } from '@/sync/domains/scm/diffSummary/discussion';
import { selectScmDiffSummaryProducerModel } from '@/sync/domains/scm/diffSummary/state';
import type { RunAnsweringEngine } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { useRunAnsweringEngine } from '@/components/sessions/runs/useRunAnsweringEngine';
import { getScmDiffSummaryState, subscribeScmDiffSummaryState } from '@/sync/ops/scmDiffSummary/generate';

const NO_ATTACHMENT_ROW_ITEMS: ReadonlyArray<AgentInputAttachmentsRowItem> = [];

type SessionRecipientStateLike = Readonly<{
    recipient: ParticipantRecipientV1 | null;
    setManualRecipient: (next: ParticipantRecipientV1 | null) => void;
    executionRunRequestedAction: PendingRequestedActionV1;
    setExecutionRunRequestedAction: (next: PendingRequestedActionV1) => void;
    scmDiffSummaryDiscussion?: Omit<ScmDiffSummaryDiscussInput, 'message'> | null;
    clearScmDiffSummaryStops?: () => void;
}>;

export type SessionAgentInputRoutingControls = Readonly<{
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    /** The context a question carries (the walkthrough stop it is about), shown above the text. */
    attachmentRowItems: ReadonlyArray<AgentInputAttachmentsRowItem>;
    participantRoutingDescriptor: ParticipantRoutingDescriptor | null;
    /**
     * A question to a walkthrough goes to the Run that wrote it: the composer names that Run's model as a fixed
     * engine (`null` while its saved result is not loaded here) and offers none of the Session's engine controls.
     * `undefined` when the recipient is not a walkthrough.
     */
    walkthroughEngine?: RunAnsweringEngine | null;
}>;

export function useSessionAgentInputRoutingControls(params: Readonly<{
    isReadOnly: boolean;
    participantTargets: readonly SessionParticipantTarget[];
    recipientState: SessionRecipientStateLike;
    /** A session's own composer also talks to other sessions (Send · Ask · Post update). */
    sessionTalk?: SessionTalkChipBinding;
    /**
     * The Run recipient is a walkthrough's conversation on a surface whose targets do not name the Run's intent.
     * Targets that carry `runIntent` decide this themselves.
     */
    walkthroughConversation?: boolean;
    sessionId?: string | null;
    serverId?: string | null;
}>): SessionAgentInputRoutingControls {
    // A question about one stop goes "To Walkthrough"; the stop it is about rides above the text as context
    // (lab WT3-D1 "Stop 3 · SettingsSheet.tsx L9–14 ×"), read from the saved revision it addresses.
    const scmDiscussion = params.recipientState.scmDiffSummaryDiscussion ?? null;
    const readSaved = React.useCallback(() => selectScmDiffSummaryDiscussionSavedResult(getScmDiffSummaryState(), scmDiscussion), [scmDiscussion]);
    const scmSaved = React.useSyncExternalStore(subscribeScmDiffSummaryState, readSaved, readSaved);
    const scmStopId = scmDiscussion?.stopIds?.[0] ?? null;
    const scmStop = React.useMemo(() => (scmSaved && scmStopId ? readWalkthroughStopContext(scmSaved, scmStopId) : null), [scmSaved, scmStopId]);
    const scmPendingLabel = scmDiscussion ? t('walkthrough.eyebrow') : null;
    // A walkthrough is the recipient whenever the Run addressed is a walkthrough generator, however it was chosen:
    // a stop's Ask (the saved result's discussion), or the recipient menu, whose target names the Run's intent.
    const recipient = params.recipientState.recipient;
    const walkthroughRunId = recipient?.kind === 'execution_run' && params.participantTargets.some((target) => (
        target.runIntent === 'scm_diff_summary' && target.recipient.kind === 'execution_run' && target.recipient.runId === recipient.runId
    )) ? recipient.runId : null;
    const walkthroughRecipient = Boolean(scmDiscussion || walkthroughRunId);
    const readResult = React.useCallback(() => (scmDiscussion
        ? selectScmDiffSummaryDiscussionResult(getScmDiffSummaryState(), scmDiscussion)
        : selectScmDiffSummaryResultByRunId(getScmDiffSummaryState(), walkthroughRunId)), [scmDiscussion, walkthroughRunId]);
    const scmResult = React.useSyncExternalStore(subscribeScmDiffSummaryState, readResult, readResult);
    const producer = React.useMemo(
        () => (walkthroughRecipient ? selectScmDiffSummaryProducerModel({ producer: scmResult?.output.success ? scmResult.output.producer : null, latestRun: null, savedResult: scmResult }) : null),
        [scmResult, walkthroughRecipient],
    );
    const { engine } = useRunAnsweringEngine({ ...producer, backendTarget: producer?.backendTarget,
        modelId: producer?.modelId, sessionId: params.sessionId, serverId: params.serverId });
    const walkthroughEngine = walkthroughRecipient ? engine : undefined;
    const clearScmStops = params.recipientState.clearScmDiffSummaryStops;
    const attachmentRowItems = React.useMemo<ReadonlyArray<AgentInputAttachmentsRowItem>>(() => {
        if (!scmStop || !scmStopId) return NO_ATTACHMENT_ROW_ITEMS;
        const detail = [scmStop.fileName, scmStop.rangeLabel].filter(Boolean).join(' ');
        return [{
            kind: 'badge',
            key: `scm-stop:${scmStopId}`,
            label: t('walkthrough.stopNumber', { number: scmStop.number }),
            ...(detail ? { detail } : {}),
            icon: (tint: string) => <Icon name="path" size={ICON_SIZE.xs} color={tint} />,
            ...(clearScmStops && !params.isReadOnly ? { onRemove: clearScmStops, removeTestID: 'agent-input-scm-stop-remove' } : {}),
        }];
    }, [clearScmStops, params.isReadOnly, scmStop, scmStopId]);
    const recipientChip = React.useMemo<AgentInputExtraActionChip | undefined>(() => {
        return createRecipientActionChip({
            isReadOnly: params.isReadOnly,
            participantTargets: params.participantTargets,
            recipient: params.recipientState.recipient,
            onRecipientChange: params.recipientState.setManualRecipient,
            ...(scmPendingLabel ? { pendingLabel: scmPendingLabel } : {}),
            ...(params.sessionTalk ? { sessionTalk: params.sessionTalk } : {}),
        });
    }, [
        params.sessionTalk,
        params.isReadOnly,
        params.participantTargets,
        params.recipientState.recipient,
        params.recipientState.setManualRecipient,
        scmPendingLabel,
    ]);

    const participantRoutingDescriptor = React.useMemo(() => {
        return resolveParticipantRoutingDescriptor({
            targets: params.participantTargets,
            recipient: params.recipientState.recipient,
        });
    }, [params.participantTargets, params.recipientState.recipient]);

    const deliveryChip = React.useMemo<AgentInputExtraActionChip | undefined>(() => {
        if (params.isReadOnly) return undefined;
        // A walkthrough's discussion admits the message itself and takes no delivery mode.
        if (walkthroughRecipient || params.walkthroughConversation) return undefined;
        // Targeted Run input now travels through the canonical Session Pending
        // message descriptor. The recipient—not a retired direct-send transport
        // discriminator—decides whether delivery-mode controls are applicable.
        if (params.recipientState.recipient?.kind !== 'execution_run') return undefined;
        return createExecutionRunRequestedActionChip({
            recipient: params.recipientState.recipient,
            requestedAction: params.recipientState.executionRunRequestedAction,
            onRequestedActionChange: params.recipientState.setExecutionRunRequestedAction,
        });
    }, [
        params.isReadOnly,
        params.walkthroughConversation,
        walkthroughRecipient,
        participantRoutingDescriptor,
        params.recipientState.executionRunRequestedAction,
        params.recipientState.recipient,
        params.recipientState.setExecutionRunRequestedAction,
    ]);

    const extraActionChips = React.useMemo<ReadonlyArray<AgentInputExtraActionChip> | undefined>(() => {
        const chips = [recipientChip, deliveryChip].filter(Boolean) as AgentInputExtraActionChip[];
        return chips.length > 0 ? chips : undefined;
    }, [deliveryChip, recipientChip]);

    return {
        extraActionChips,
        attachmentRowItems,
        participantRoutingDescriptor,
        ...(walkthroughEngine !== undefined ? { walkthroughEngine } : {}),
    };
}
