import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';
import { buildRecipientRootStep } from '../definitions/createRecipientActionChip';
import {
    resolveRecipientFromOptionId,
    resolveRecipientLabel,
    resolveRecipientPopoverSelectedOptionId,
} from './recipientOptions';

const stylesheet = StyleSheet.create((theme) => ({
    anchor: {
        alignSelf: 'flex-start',
    },
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));

export type RecipientChipProps = Readonly<{
    targets: readonly SessionParticipantTarget[];
    recipient: ParticipantRecipientV1 | null;
    onRecipientChange: (next: ParticipantRecipientV1 | null) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

export const RecipientChip = React.memo(function RecipientChip(props: RecipientChipProps) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const styles = stylesheet;
    const selectedLabel = resolveRecipientLabel(props.targets, props.recipient);
    const selectedOptionId = React.useMemo(
        () => resolveRecipientPopoverSelectedOptionId(props.targets, props.recipient),
        [props.targets, props.recipient],
    );
    // Reuse the shared root-step builder from the chip-definition factory so
    // the inline chip and the collapsed action-menu route declare the same
    // option set (id, label, subtitle, per-option onSelect). Per-option
    // `onSelect` carries the recipient mutation; the popover-level `onSelect`
    // below only closes the popover.
    const rootStep = React.useMemo<SelectionListStep>(
        () => buildRecipientRootStep({
            targets: props.targets,
            onSelect: (selectedId) => {
                props.onRecipientChange(resolveRecipientFromOptionId(props.targets, selectedId));
            },
        }),
        [props.targets, props.onRecipientChange],
    );

    if (props.targets.length === 0) return null;

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={styles.anchor}>
                <Pressable
                    testID="agent-input-recipient-chip"
                    onPress={() => setOpen((v) => !v)}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.participants.sendToTitle')}
                >
                    <View style={styles.chipRow}>
                        <Ionicons name="navigate-outline" size={16} color={props.ctx.iconColor} />
                        {props.ctx.showLabel ? (
                            <Text numberOfLines={1} style={props.ctx.textStyle}>
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
