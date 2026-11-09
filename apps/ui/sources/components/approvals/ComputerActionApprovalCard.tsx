import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type ComputerActionApproval } from './computerApprovalModel';
export { applyComputerSelection, describeComputerActionApproval, type ComputerActionApproval } from './computerApprovalModel';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';

const CONSEQUENCE_KEY = {
    see: 'computerUse.approval.seeConsequence',
    use: 'computerUse.approval.useConsequence',
} as const satisfies Record<ComputerActionApproval['access'], Parameters<typeof t>[0]>;

/** The window title as the owner names it (a missing title is said); a display reads as the screen, never its display id. */
export function readComputerTargetLabel(target: NonNullable<ComputerActionApproval['target']>): string {
    if (target.kind === 'display') return t('computerUse.approval.screen');
    return target.title.trim() || t('computerUse.picker.untitledWindow');
}

/** The same target inside a sentence: a window keeps its own title; the whole screen drops its leading capital. */
export function readComputerTargetPhrase(target: NonNullable<ComputerActionApproval['target']>): string {
    return target.kind === 'display' ? t('computerUse.approval.screenInSentence') : readComputerTargetLabel(target);
}

/** Acts that land somewhere in the shared target, so their one line says where ("Click in Safari?"). */
const ACTS_IN_TARGET: ReadonlySet<ComputerActionApproval['act']> = new Set(['click', 'type', 'press', 'move', 'drag', 'wheel']);

/** The one act line a Computer ask is asked by: the approval page's title and the inline card's heading. */
export function readComputerActLine(presentation: ComputerActionApproval): string {
    const act = readComputerActLabel(presentation);
    if (!presentation.target || !ACTS_IN_TARGET.has(presentation.act)) return act;
    return presentation.target.kind === 'display'
        ? t('computerUse.approval.actOnScreen', { act })
        : t('computerUse.approval.actIn', { act, target: readComputerTargetLabel(presentation.target) });
}

/** What the person is asked to let happen ("Click", "Share Safari"); the approval page titles itself with it. */
export function readComputerActLabel(presentation: ComputerActionApproval): string {
    if (presentation.act === 'fill') return t('approvals.confidential.title');
    if (presentation.act === 'share' && presentation.appName) return t('computerUse.picker.shareApp', { app: presentation.appName });
    if (presentation.act === 'drag') return t('browserPresence.doing.drag');
    if (presentation.act === 'wheel') return t('browserPresence.doing.scroll');
    return t(`computerUse.approval.act.${presentation.act}`);
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
    /** The latest picture of the shared window (`ComputerApprovalCapture`); shown only while the owner has one. */
    media?: React.ReactNode;
    /** Opens the target picker; offered while no window is shared, and to change an agent's choice. */
    onChooseTarget?: () => void;
    /** The agent's name, for its suggestion line. */
    agentName?: string;
    /** The Home the Machine belongs to, so the Machine reads by its name owner's label. */
    serverId?: string | null;
    /** The host already asks the act line as its own title (the approval page); the card starts at where. */
    titled?: boolean;
    /** The host surface's insets (the chat card aligns it to its text column). */
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>) {
    const { presentation } = props;
    const testID = props.testID ?? 'approvals.computer-action';
    const agentName = props.agentName ?? t('browserPresence.agentFallbackName');
    const machine = useServerScopedMachineLabel(props.serverId, presentation.machineId) ?? presentation.machineName;
    const where = presentation.target?.kind === 'display'
        ? t('computerUse.approval.screenOf', { machine })
        : presentation.target
            ? t('computerUse.approval.targetOn', { target: readComputerTargetLabel(presentation.target), machine })
            : presentation.requiresTargetSelection
                ? t('computerUse.approval.chooseFirst')
                : t('computerUse.approval.windowOn', { machine });
    return (
        <View style={[styles.card, props.style]} testID={testID}>
            <View style={styles.what}>
                {props.titled ? null : <Text style={styles.act}>{readComputerActLine(presentation)}</Text>}
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
            {presentation.target && presentation.captureMedia && props.media ? <View accessibilityLabel={t('computerUse.approval.cropA11y', { target: readComputerTargetPhrase(presentation.target) })}>{props.media}</View> : null}
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
