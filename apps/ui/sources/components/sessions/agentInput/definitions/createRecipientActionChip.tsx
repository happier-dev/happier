import { getRecipientActionChipPlacement } from './agentInputActionChipPlacements';
import * as React from 'react';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { t } from '@/text';

import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RecipientChip, resolveRecipientMultiSelectLabel } from '../routing/RecipientChip';
import type { RecipientMultiSelectModel } from '../routing/recipientMultiSelectModel';
import { SessionTalkPicker, readSessionTalkSelector, selectorTitle, type SessionTalkIntent } from '../routing/SessionTalkPicker';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';
import {
    buildRecipientPopoverOptions,
    resolveRecipientControlLabel,
    resolveRecipientFromOptionId,
    resolveRecipientLabel,
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
    pendingLabel?: string;
    includeLead?: boolean;
}>): SelectionListStep {
    const options = buildRecipientPopoverOptions(params.targets, params.includeLead === true || Boolean(params.pendingLabel));
    return {
        id: 'recipient-root',
        title: t('session.participants.sendToTitle'),
        sections: [
            {
                kind: 'static',
                id: 'recipients',
                options: [
                    ...(params.pendingLabel ? [{ id: 'pending-scm-discussion', label: params.pendingLabel }] : []),
                    ...options.map((option) => ({
                        id: option.id,
                        label: option.label,
                        subtitle: option.subtitle,
                        onSelect: params.onSelect ? () => params.onSelect!(option.id) : undefined,
                    })),
                ],
            },
        ],
    };
}

/** The Send to step for several recipients: each row toggles through the caller-owned model. */
export function buildRecipientMultiSelectRootStep(model: RecipientMultiSelectModel<unknown>): SelectionListStep {
    return {
        id: 'recipient-root',
        title: t('session.participants.sendToTitle'),
        sections: [{
            kind: 'static',
            id: 'recipients',
            options: model.targets.map((target) => ({ id: target.id, label: target.label, onSelect: () => model.toggle(target.id) })),
        }],
    };
}

export const SESSION_RECIPIENT_CHIP_KEY = 'participants-recipient';

/**
 * The same Send to chip for a composer that addresses several recipients at once (a Discussion's
 * participants, C3 DISC-18). The selection is the caller's controlled model; overflow opens the same list.
 */
export function createRecipientMultiSelectActionChip(params: Readonly<{
    isReadOnly: boolean;
    model: RecipientMultiSelectModel<unknown>;
}>): AgentInputExtraActionChip | undefined {
    const { model } = params;
    if (params.isReadOnly || (model.targets.length === 0 && model.selectedIds.length === 0)) return undefined;
    const label = resolveRecipientMultiSelectLabel(model);
    return {
        key: SESSION_RECIPIENT_CHIP_KEY,
        controlId: 'recipient',
        placement: { ...getRecipientActionChipPlacement('discussion'), pending: model.selectedIds.length > 0 },
        stabilityKey: JSON.stringify([model.selectedIds, model.targets.map((target) => [target.id, target.label])]),
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('session.participants.sendToTitle'),
            label,
            icon: (tint) => <Icon name="navigation-arrow" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            rootStep: buildRecipientMultiSelectRootStep(model),
            selection: { kind: 'multiple', selectedIds: new Set(model.selectedIds) },
            // Rows toggle through their own onSelect (see the single-recipient chip above).
            onSelect: () => {},
            maxHeightCap: 360,
        },
        render: (ctx: AgentInputExtraActionChipRenderContext) => <RecipientChip multi={model} ctx={ctx} />,
    };
}

/** Talking to other sessions from this composer: the canonical draft intent and its writer. */
export type SessionTalkChipBinding = Readonly<{
    sessionId: string;
    serverId: string | null;
    intent: SessionTalkIntent | null;
    onIntentChange: (next: SessionTalkIntent | null) => void;
}>;

/** "To" while chatting; otherwise the whole sentence: "Ask Siblings", "Post update". */
export function resolveSessionTalkChipLabel(
    intent: SessionTalkIntent | null,
    participantLabel: string | null,
): string {
    if (intent?.kind === 'post_update') return t('session.participants.talk.chipPostUpdate');
    const selector = readSessionTalkSelector(intent);
    if (intent && selector) {
        return t(intent.kind === 'ask' ? 'session.participants.talk.chipAsk' : 'session.participants.talk.chipSend', {
            target: selectorTitle(selector),
        });
    }
    return participantLabel ? t('session.participants.cardTo', { label: participantLabel }) : t('session.participants.to');
}

export function createRecipientActionChip(params: Readonly<{
    isReadOnly: boolean;
    participantTargets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
    pendingLabel?: string;
    /** Present on a session's own composer: the To picker addresses other sessions too. */
    sessionTalk?: SessionTalkChipBinding;
}>): AgentInputExtraActionChip | undefined {
    if (params.isReadOnly) return undefined;
    if (params.sessionTalk && !params.pendingLabel) return createSessionTalkChip({ ...params, sessionTalk: params.sessionTalk });
    if (params.participantTargets.length === 0 && !params.pendingLabel && !params.recipient) return undefined;

    const label = params.pendingLabel ? t('session.participants.cardTo', { label: params.pendingLabel }) : resolveRecipientControlLabel(params.participantTargets, params.recipient)
        ?? t('session.participants.sendToTitle');
    const selectedOptionId = params.pendingLabel ? 'pending-scm-discussion' : resolveRecipientPopoverSelectedOptionId(params.participantTargets, params.recipient);
    const rootStep = buildRecipientRootStep({
        targets: params.participantTargets,
        pendingLabel: params.pendingLabel,
        includeLead: params.recipient !== null,
        onSelect: (selectedId) => {
            params.onRecipientChange(resolveRecipientFromOptionId(params.participantTargets, selectedId));
        },
    });

    return {
        key: SESSION_RECIPIENT_CHIP_KEY,
        controlId: 'recipient',
        placement: { ...getRecipientActionChipPlacement(), pending: params.recipient !== null || Boolean(params.pendingLabel) },
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('session.participants.sendToTitle'),
            label,
            icon: (tint) => <Icon name="navigation-arrow" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
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
                pendingLabel={params.pendingLabel}
                ctx={ctx}
            />
        ),
    };
}

function createSessionTalkChip(params: Readonly<{
    participantTargets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
    sessionTalk: SessionTalkChipBinding;
}>): AgentInputExtraActionChip {
    const participantLabel = params.recipient ? resolveRecipientLabel(params.participantTargets, params.recipient) : null;
    const label = resolveSessionTalkChipLabel(params.sessionTalk.intent, participantLabel);
    const participants = params.participantTargets.length > 0 || params.recipient
        ? { targets: params.participantTargets, recipient: params.recipient, onRecipientChange: params.onRecipientChange }
        : null;
    return {
        key: SESSION_RECIPIENT_CHIP_KEY,
        controlId: 'recipient',
        placement: { ...getRecipientActionChipPlacement(), pending: params.recipient !== null || params.sessionTalk.intent !== null },
        stabilityKey: JSON.stringify([params.sessionTalk.intent, params.recipient, params.participantTargets.length]),
        collapsedContentPopover: {
            title: t('session.participants.talk.title'),
            label,
            icon: (tint) => <Icon name="navigation-arrow" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            maxWidthCap: 400,
            maxHeightCap: 560,
            phonePresentation: 'sheet',
            header: { title: t('session.participants.talk.title'), placement: 'sheet' },
            renderContent: ({ requestClose, maxHeight }) => (
                <SessionTalkPicker
                    maxHeight={maxHeight}
                    sessionId={params.sessionTalk.sessionId}
                    serverId={params.sessionTalk.serverId}
                    intent={params.sessionTalk.intent}
                    onIntentChange={params.sessionTalk.onIntentChange}
                    participants={participants}
                    requestClose={requestClose}
                />
            ),
        },
        render: ({ chipStyle, iconColor, textStyle, showLabel, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="agent-input-recipient-chip"
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => {
                    hapticsLight();
                    toggleCollapsedPopover?.(SESSION_RECIPIENT_CHIP_KEY);
                }}
                hitSlop={{ top: 8, bottom: 10, left: 4, right: 4 }}
                style={(state) => chipStyle(state.pressed)}
            >
                <View style={styles.chipRow}>
                    <Icon name="navigation-arrow" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                    {showLabel ? <Text numberOfLines={1} style={textStyle}>{label}</Text> : null}
                </View>
            </Pressable>
        ),
    };
}

const styles = StyleSheet.create((theme) => ({
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
}));
