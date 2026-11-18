import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildRecipientMultiSelectRootStep, buildRecipientRootStep } from '../definitions/createRecipientActionChip';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import {
    resolveRecipientFromOptionId,
    resolveRecipientLabel,
    resolveRecipientPopoverSelectedOptionId,
} from './recipientOptions';
import type { RecipientMultiSelectModel } from './recipientMultiSelectModel';

const stylesheet = StyleSheet.create((theme) => ({
    // A recipient's name is the caller's text and can be long: the chip never outgrows the rail it sits in,
    // its label ellipsizes instead of running under the trailing accessory.
    anchor: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
        minWidth: 0,
        flexShrink: 1,
    },
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
        flexShrink: 1,
    },
    label: {
        flexShrink: 1,
    },
}));

type SingleRecipientChipProps = Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
    ctx: AgentInputExtraActionChipRenderContext;
    pendingLabel?: string;
}>;

/** Several recipients at once from a caller-owned controlled model (a Discussion's participants, C3 DISC-18). */
type MultiRecipientChipProps = Readonly<{
    multi: RecipientMultiSelectModel<unknown>;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

export type RecipientChipProps = SingleRecipientChipProps | MultiRecipientChipProps;

/** "To <recipients>": the Send to chip for one recipient, or for several from a controlled model. */
export function RecipientChip(props: RecipientChipProps) {
    return 'multi' in props ? <MultiRecipientChip {...props} /> : <SingleRecipientChip {...props} />;
}

/** The chip text for several recipients: none is everyone ("To: Everyone"); two read whole; more read "Ana +2". */
export function resolveRecipientMultiSelectLabel(model: Pick<RecipientMultiSelectModel<unknown>, 'targets' | 'selectedIds' | 'summaryLabel'>): string {
    if (model.summaryLabel) return model.summaryLabel;
    const selected = new Set(model.selectedIds);
    const labels = model.targets.filter((target) => selected.has(target.id)).map((target) => target.label);
    if (labels.length === 0) return t('session.participants.cardTo', { label: t('session.participants.everyone') });
    const label = labels.length <= 2 ? labels.join(', ')
        : t('session.collaboration.discussion.controls.recipientsMore', { first: labels[0]!, count: labels.length - 1 });
    return t('session.participants.cardTo', { label });
}

const MultiRecipientChip = React.memo(function MultiRecipientChip(props: MultiRecipientChipProps) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const { theme } = useUnistyles();
    const { multi } = props;
    const label = resolveRecipientMultiSelectLabel(multi);
    const accessibilityLabel = multi.summaryDetail ? `${label} · ${multi.summaryDetail}` : label;
    const selection = React.useMemo(() => ({ kind: 'multiple' as const, selectedIds: new Set(multi.selectedIds) }), [multi.selectedIds]);
    const rootStep = React.useMemo(() => buildRecipientMultiSelectRootStep(multi), [multi]);
    if (multi.targets.length === 0 && multi.selectedIds.length === 0) return null;
    return (
        <>
            <View ref={anchorRef} collapsable={false} style={stylesheet.anchor}>
                <Pressable
                    testID="agent-input-recipient-chip"
                    onPress={() => setOpen((v) => !v)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                >
                    <View style={stylesheet.chipRow}>
                        <Icon name="navigation-arrow" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={props.ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                        {/* The header line names who the message goes to: the count reads in primary ink, the detail quiet. */}
                        {props.ctx.showLabel ? (
                            <Text numberOfLines={1} style={[props.ctx.textStyle, stylesheet.label, { color: theme.colors.text.primary }]}>
                                {label}
                                {multi.summaryDetail ? (
                                    <Text style={{ color: theme.colors.text.tertiary }}>{` · ${multi.summaryDetail}`}</Text>
                                ) : null}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>
            <AgentInputSelectionListPopover
                open={open}
                // The list grows from the chip on the header line, not from the card's edge (lab bc To list).
                anchorRef={anchorRef}
                rootStep={rootStep}
                selection={selection}
                // Rows toggle through their own onSelect; a multiple choice never closes the picker.
                onSelect={() => {}}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={360}
            />
        </>
    );
});

const SingleRecipientChip = React.memo(function SingleRecipientChip(props: SingleRecipientChipProps) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const styles = stylesheet;
    const selectedLabel = props.pendingLabel ?? resolveRecipientLabel(props.targets, props.recipient);
    const selectedOptionId = React.useMemo(
        () => props.pendingLabel ? 'pending-scm-discussion' : resolveRecipientPopoverSelectedOptionId(props.targets, props.recipient),
        [props.targets, props.recipient, props.pendingLabel],
    );
    // Reuse the shared root-step builder from the chip-definition factory so
    // the inline chip and the collapsed action-menu route declare the same
    // option set (id, label, subtitle, per-option onSelect). Per-option
    // `onSelect` carries the recipient mutation; the popover-level `onSelect`
    // below only closes the popover.
    const rootStep = React.useMemo<SelectionListStep>(
        () => buildRecipientRootStep({
            targets: props.targets,
            pendingLabel: props.pendingLabel,
            includeLead: props.recipient !== null,
            onSelect: (selectedId) => {
                props.onRecipientChange(resolveRecipientFromOptionId(props.targets, selectedId));
            },
        }),
        [props.targets, props.onRecipientChange, props.pendingLabel, props.recipient],
    );

    if (props.targets.length === 0 && !props.pendingLabel && !props.recipient) return null;

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={styles.anchor}>
                <Pressable
                    testID="agent-input-recipient-chip"
                    onPress={() => setOpen((v) => !v)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.participants.cardTo', { label: selectedLabel })}
                >
                    <View style={styles.chipRow}>
                        <Icon name="navigation-arrow" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={props.ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                        {props.ctx.showLabel ? (
                            <Text numberOfLines={1} style={[props.ctx.textStyle, styles.label]}>
                                {t('session.participants.cardTo', { label: selectedLabel })}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            <AgentInputSelectionListPopover
                open={open}
                anchorRef={props.ctx.popoverAnchorRef ?? anchorRef}
                rootStep={rootStep}
                selectedOptionId={selectedOptionId}
                onSelect={() => {
                    // FR4-W1-CHIP: documented no-op. Per-row
                    // `SelectionListOption.onSelect` inside `rootStep`
                    // dispatched the recipient mutation. The wrapper
                    // `AgentInputSelectionListPopover` owns the close path and
                    // defers `onRequestClose` on web internally — calling
                    // `setOpen(false)` here would close the popover
                    // synchronously and allow the click to fall through to
                    // the chip anchor (re-opening it).
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={360}
            />
        </>
    );
});
