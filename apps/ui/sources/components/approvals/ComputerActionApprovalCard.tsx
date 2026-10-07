import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    ComputerApprovalDisplayV1Schema,
    ComputerInputRequestV1Schema,
    ComputerTargetRequestV1Schema,
    ComputerTargetSelectRequestV1Schema,
    type ComputerApprovalDisplayV1,
} from '@happier-dev/protocol/computer/v1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * What an approval of a native computer Action asks for. The act and the exact text or key come
 * from the request's own arguments (what the machine will execute); where it lands — the machine by
 * name, the window title or display label, the latest picture — comes from the computer owner's
 * host-resolved `computerApprovalDisplay` (W7), never from what the agent wrote. Seeing and using stay
 * distinct, matching the approval floor: observation egress versus dangerous input.
 */
export type ComputerActionApproval = Readonly<{
    access: 'see' | 'use';
    act: 'see' | 'read' | 'click' | 'press' | 'type' | 'share';
    machineId: string;
    machineName: string;
    appName?: string;
    target: ComputerApprovalDisplayV1['target'] | null;
    /** No window is shared yet: the person chooses one before anything is seen or used. */
    requiresTargetSelection: boolean;
    /** The latest Session image of the shared target, when the owner has one. */
    captureMedia: NonNullable<ComputerApprovalDisplayV1['captureMedia']> | null;
    /** The exact key or text the input sends; the person approving sees it before it is sent. */
    sent: Readonly<{ kind: 'key' | 'text'; value: string }> | null;
    /**
     * An agent's proposed window for `computer.target.select` (a title or app hint it wrote): shown as
     * its suggestion; the person's pick in the picker is what is approved (W15).
     */
    suggestion?: string | null;
}>;

function readDisplay(preview: unknown): ComputerApprovalDisplayV1 | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const parsed = ComputerApprovalDisplayV1Schema.safeParse((preview as { computerApprovalDisplay?: unknown }).computerApprovalDisplay);
    return parsed.success ? parsed.data : null;
}

export function describeComputerActionApproval(input: Readonly<{ actionId: string; actionArgs: unknown; preview: unknown }>): ComputerActionApproval | null {
    if (input.actionId !== 'computer.capture' && input.actionId !== 'computer.query' && input.actionId !== 'computer.input'
        && input.actionId !== 'computer.target.select') return null;
    const display = readDisplay(input.preview);
    if (!display) return null;
    const facts = {
        machineName: display.machineDisplayName,
        ...(display.appName ? { appName: display.appName } : {}),
        target: display.requiresTargetSelection ? null : display.target ?? null,
        requiresTargetSelection: display.requiresTargetSelection,
        captureMedia: display.requiresTargetSelection ? null : display.captureMedia ?? null,
    };
    if (input.actionId === 'computer.target.select') {
        const parsed = ComputerTargetSelectRequestV1Schema.safeParse(input.actionArgs);
        if (!parsed.success) return null;
        return {
            access: parsed.data.access ?? display.access ?? 'use',
            act: 'share',
            machineId: parsed.data.machineId,
            ...facts,
            sent: null,
            suggestion: parsed.data.requestedTarget?.trim() || null,
        };
    }
    if (input.actionId === 'computer.input') {
        const parsed = ComputerInputRequestV1Schema.safeParse(input.actionArgs);
        if (!parsed.success) return null;
        const operation = parsed.data.operation;
        return {
            access: 'use',
            act: operation.kind,
            machineId: parsed.data.machineId,
            ...facts,
            sent: operation.kind === 'type'
                ? { kind: 'text', value: operation.text }
                : operation.kind === 'press'
                    ? { kind: 'key', value: operation.key }
                    : null,
        };
    }
    const parsed = ComputerTargetRequestV1Schema.safeParse(input.actionArgs);
    if (!parsed.success) return null;
    return {
        access: 'see',
        act: input.actionId === 'computer.capture' ? 'see' : 'read',
        machineId: parsed.data.machineId,
        ...facts,
        sent: null,
    };
}

/** The approval after the person chose a window from it: the owner's answer replaces "choose first". */
export function applyComputerSelection(
    presentation: ComputerActionApproval,
    display: ComputerApprovalDisplayV1 | null,
): ComputerActionApproval {
    if (!display || display.requiresTargetSelection || !display.target) return presentation;
    return {
        ...presentation,
        machineName: display.machineDisplayName,
        appName: display.appName,
        ...(presentation.act === 'share' && display.access ? { access: display.access } : {}),
        target: display.target,
        requiresTargetSelection: false,
        captureMedia: display.captureMedia ?? null,
    };
}

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
                <Text style={styles.act}>{presentation.act === 'share' && presentation.appName
                    ? t('computerUse.picker.shareApp', { app: presentation.appName })
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
        gap: 10,
    },
    what: {
        gap: 2,
    },
    act: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    where: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    choose: {
        flexDirection: 'row',
    },
    sent: {
        gap: 4,
    },
    label: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    sentValue: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    consequence: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
}));
