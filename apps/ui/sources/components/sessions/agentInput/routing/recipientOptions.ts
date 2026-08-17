import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import { t } from '@/text';
import { participantRecipientsMatch } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

export const RECIPIENT_LEAD_OPTION_ID = 'lead';

export function resolveSessionParticipantTargetLabel(target: SessionParticipantTarget): string {
    const recipient = target.recipient;
    if (recipient.kind === 'execution_run') {
        return target.displayLabel ?? t('session.participants.executionRun', { runId: recipient.runId });
    }
    if (recipient.kind === 'agent_team_broadcast') {
        return t('session.participants.broadcast', { teamId: recipient.teamId });
    }
    return target.displayLabel ?? recipient.memberId;
}

export function resolveRecipientLabel(
    targets: readonly SessionParticipantTarget[],
    recipient: ParticipantRecipientV1 | null,
): string {
    if (!recipient) return t('session.participants.lead');
    const target = targets.find((candidate) => participantRecipientsMatch(candidate.recipient, recipient)) ?? null;
    if (target) return resolveSessionParticipantTargetLabel(target);
    if (recipient.kind === 'execution_run') return t('session.participants.executionRun', { runId: recipient.runId });
    if (recipient.kind === 'agent_team_broadcast') return t('session.participants.broadcast', { teamId: recipient.teamId });
    return recipient.memberId;
}

export function resolveRecipientControlLabel(
    targets: readonly SessionParticipantTarget[],
    recipient: ParticipantRecipientV1 | null,
): string {
    return t('session.participants.cardTo', {
        label: resolveRecipientLabel(targets, recipient),
    });
}

export function resolveRecipientPopoverSelectedOptionId(
    targets: readonly SessionParticipantTarget[],
    recipient: ParticipantRecipientV1 | null,
): string | null {
    if (!recipient) return RECIPIENT_LEAD_OPTION_ID;
    return targets.find((candidate) => participantRecipientsMatch(candidate.recipient, recipient))?.key ?? null;
}

export function buildRecipientPopoverOptions(
    targets: readonly SessionParticipantTarget[],
): ReadonlyArray<AgentInputChipPickerOption> {
    if (targets.length === 0) return [];
    return [
        {
            id: RECIPIENT_LEAD_OPTION_ID,
            label: t('session.participants.lead'),
        },
        ...targets.map((target) => ({
            id: target.key,
            label: resolveSessionParticipantTargetLabel(target),
        })),
    ];
}

export function resolveRecipientFromOptionId(
    targets: readonly SessionParticipantTarget[],
    selectedId: string,
): ParticipantRecipientV1 | null {
    if (selectedId === RECIPIENT_LEAD_OPTION_ID) return null;
    return targets.find((target) => target.key === selectedId)?.recipient ?? null;
}
