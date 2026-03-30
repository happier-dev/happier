import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { t } from '@/text';

import { RecipientChip } from '../routing/RecipientChip';
import {
    buildRecipientPopoverOptions,
    resolveRecipientControlLabel,
    resolveRecipientFromOptionId,
    resolveRecipientPopoverSelectedOptionId,
} from '../routing/recipientOptions';

export function createRecipientActionChip(params: Readonly<{
    isReadOnly: boolean;
    participantTargets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
}>): AgentInputExtraActionChip | undefined {
    if (params.isReadOnly) return undefined;
    if (params.participantTargets.length === 0) return undefined;

    const label = resolveRecipientControlLabel(params.participantTargets, params.recipient)
        ?? t('session.participants.sendToTitle');
    const options = buildRecipientPopoverOptions(params.participantTargets);
    const selectedOptionId = resolveRecipientPopoverSelectedOptionId(params.participantTargets, params.recipient);

    return {
        key: 'participants-recipient',
        controlId: 'recipient',
        collapsedOptionsPopover: {
            title: t('session.participants.sendToTitle'),
            label,
            icon: (tint) => <Ionicons name="navigate-outline" size={16} color={tint} />,
            options,
            selectedOptionId,
            onSelect: (selectedId) => {
                params.onRecipientChange(resolveRecipientFromOptionId(params.participantTargets, selectedId));
            },
            maxHeightCap: 320,
        },
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <RecipientChip
                targets={params.participantTargets}
                recipient={params.recipient}
                onRecipientChange={params.onRecipientChange}
                ctx={ctx}
            />
        ),
    };
}
