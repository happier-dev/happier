import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { t } from '@/text';

import { RecipientChip } from '../routing/RecipientChip';
import {
    buildRecipientPopoverOptions,
    resolveRecipientControlLabel,
    resolveRecipientFromOptionId,
    resolveRecipientPopoverSelectedOptionId,
} from '../routing/recipientOptions';

/**
 * Shared root-step builder used by BOTH the chip-definition factory (action-menu
 * route) and the inline `RecipientChip` (direct chip route). Per-option
 * `onSelect` callbacks are the canonical action source for `presentation: 'list'`
 * descriptors — `AgentInputOverlayLayer` does NOT call descriptor-level
 * `onSelect` for list-mode chips, only the per-row callbacks (see
 * `AgentInputOverlayLayer.tsx` `'list'` branch). The optional `onSelect`
 * parameter is the consumer-owned action; pass `undefined` to render a
 * read-only step.
 */
export function buildRecipientRootStep(params: Readonly<{
    targets: readonly SessionParticipantTarget[];
    onSelect?: (selectedId: string) => void;
}>): SelectionListStep {
    const options = buildRecipientPopoverOptions(params.targets);
    return {
        id: 'recipient-root',
        title: t('session.participants.sendToTitle'),
        sections: [
            {
                kind: 'static',
                id: 'recipients',
                options: options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    subtitle: option.subtitle,
                    onSelect: params.onSelect ? () => params.onSelect!(option.id) : undefined,
                })),
            },
        ],
    };
}

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
    const selectedOptionId = resolveRecipientPopoverSelectedOptionId(params.participantTargets, params.recipient);
    const rootStep = buildRecipientRootStep({
        targets: params.participantTargets,
        onSelect: (selectedId) => {
            params.onRecipientChange(resolveRecipientFromOptionId(params.participantTargets, selectedId));
        },
    });

    return {
        key: 'participants-recipient',
        controlId: 'recipient',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('session.participants.sendToTitle'),
            label,
            icon: (tint) => <Ionicons name="navigate-outline" size={16} color={tint} />,
            rootStep,
            selectedOptionId,
            onSelect: () => {
                // List-mode option mutations live on per-option SelectionListOption.onSelect
                // (set inside `buildRecipientRootStep`). The overlay route closes on
                // selection but does NOT call this descriptor-level callback for
                // `presentation: 'list'` chips. Documented no-op for parity with the
                // chip-picker contract.
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
