import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { AgentInputSimpleOptionsPopover } from '@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';
import {
    buildRecipientPopoverOptions,
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
    const popoverOptions = React.useMemo(() => buildRecipientPopoverOptions(props.targets), [props.targets]);
    const selectedOptionId = React.useMemo(
        () => resolveRecipientPopoverSelectedOptionId(props.targets, props.recipient),
        [props.targets, props.recipient],
    );

    if (props.targets.length === 0) return null;

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={styles.anchor}>
                <Pressable
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

            <AgentInputSimpleOptionsPopover
                open={open}
                anchorRef={props.ctx.popoverAnchorRef ?? anchorRef}
                title={t('session.participants.sendToTitle')}
                options={popoverOptions}
                selectedOptionId={selectedOptionId}
                onSelect={(selectedId) => {
                    props.onRecipientChange(resolveRecipientFromOptionId(props.targets, selectedId));
                    setOpen(false);
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={360}
            />
        </>
    );
});
