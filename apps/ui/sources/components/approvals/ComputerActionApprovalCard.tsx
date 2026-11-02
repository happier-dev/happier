import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type ComputerActionApproval } from './computerApprovalModel';
export { applyComputerSelection, describeComputerActionApproval, type ComputerActionApproval } from './computerApprovalModel';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const CONSEQUENCE_KEY = {
    see: 'computerUse.approval.seeConsequence',
    use: 'computerUse.approval.useConsequence',
} as const satisfies Record<ComputerActionApproval['access'], Parameters<typeof t>[0]>;

/** The window title or display label as the owner names it (a missing title is said, not left blank). */
export function readComputerTargetLabel(target: NonNullable<ComputerActionApproval['target']>): string {
    const title = target.title.trim();
    if (title) return title;
    return target.kind === 'window' ? t('computerUse.picker.untitledWindow') : t('computerUse.approval.screen');
}

/**
 * The act, where it lands ("Sign in to Lumen on Studio laptop"), the exact text or key, the latest
 * picture of the window when the host passes it, and one consequence line. When no window is shared
 * yet, the card leads with choosing one (lab `computer` TP inside the first consent). Native ids
 * (process, window, display, capture) never reach the person. Session and Home are named by the
 * approval's own "Requested by" context.
 */
export const ComputerActionApprovalCard = React.memo(function ComputerActionApprovalCard(props: Readonly<{
    presentation: ComputerActionApproval;
    /** The latest picture of the shared window (the host renders the Session image it can read). */
    media?: React.ReactNode;
    /** Opens the target picker; offered while no window is shared, and to change an agent's choice. */
    onChooseTarget?: () => void;
    /** The agent's name, for its suggestion line. */
    agentName?: string;
    /** The host surface's insets (the chat card aligns it to its text column). */
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>) {
    const { presentation } = props;
    const testID = props.testID ?? 'approvals.computer-action';
    const agentName = props.agentName ?? t('browserPresence.agentFallbackName');
    const where = presentation.target
        ? t('computerUse.approval.targetOn', { target: readComputerTargetLabel(presentation.target), machine: presentation.machineName })
        : presentation.requiresTargetSelection
            ? t('computerUse.approval.chooseFirst')
            : t('computerUse.approval.windowOn', { machine: presentation.machineName });
    return (
        <View style={[styles.card, props.style]} testID={testID}>
            <View style={styles.what}>
                <Text style={styles.act}>{presentation.act === 'fill' ? t('approvals.confidential.title') : presentation.act === 'share' && presentation.appName
                    ? t('computerUse.picker.shareApp', { app: presentation.appName })
                    : presentation.act === 'drag' ? t('browserPresence.doing.drag')
                    : presentation.act === 'wheel' ? t('browserPresence.doing.scroll')
                    : t(`computerUse.approval.act.${presentation.act}`)}</Text>
                <Text style={styles.where}>{where}</Text>
            </View>
            {presentation.suggestion && presentation.requiresTargetSelection ? (
                <Text style={styles.where} testID={`${testID}-suggestion`}>
                    {t('computerUse.approval.suggestsWindow', { agent: agentName, target: presentation.suggestion })}
                </Text>
            ) : null}
            {props.onChooseTarget && (presentation.requiresTargetSelection || presentation.act === 'share') ? (
                <View style={styles.choose}>
                    <RoundButton
                        size="small"
                        display={presentation.requiresTargetSelection ? undefined : 'secondary'}
                        title={presentation.requiresTargetSelection ? t('computerUse.request.choose') : t('computerUse.request.change')}
                        onPress={props.onChooseTarget}
                        testID={`${testID}-choose`}
                    />
                </View>
            ) : null}
            {presentation.target && props.media ? <View accessibilityLabel={t('computerUse.approval.cropA11y', { target: readComputerTargetLabel(presentation.target) })}>{props.media}</View> : null}
            {presentation.sent ? (
                <View style={styles.sent}>
                    <Text style={styles.label}>
                        {t(presentation.sent.kind === 'text' ? 'computerUse.approval.typedLabel' : 'computerUse.approval.keyLabel')}
                    </Text>
                    <Text style={styles.sentValue} selectable>{presentation.sent.value}</Text>
                </View>
            ) : null}
            <Text style={styles.consequence}>
                {t(CONSEQUENCE_KEY[presentation.access])}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        gap: theme.space.s10,
    },
    what: {
        gap: theme.space.s2,
    },
    act: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    where: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    choose: {
        flexDirection: 'row',
    },
    sent: {
        gap: theme.space.s4,
    },
    label: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    sentValue: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    consequence: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
