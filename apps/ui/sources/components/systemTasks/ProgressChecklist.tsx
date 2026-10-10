import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { Item } from '@/components/ui/lists/Item';
import { Icon, ICON_SIZE, type IconName, type IconWeight } from '@/components/ui/icons/Icon';

export type ProgressChecklistStepStatus =
    | 'pending'
    | 'active'
    | 'waiting'
    | 'done'
    | 'failed'
    | 'canceled';

export type ProgressChecklistStep<StepId extends string = string> = Readonly<{
    stepId: StepId;
    title: string;
    message?: string | null;
    status: ProgressChecklistStepStatus;
    /** A short fact at the row's end (how long the step took). */
    detail?: string | null;
}>;

export function encodeProgressChecklistStepIdForTestId(stepId: string): string {
    return String(stepId ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

export const ProgressChecklist = React.memo(function ProgressChecklist(props: Readonly<{
    steps: readonly ProgressChecklistStep[];
    testIDPrefix: string;
    showStepMessages?: boolean;
    /**
     * `compact`: one quiet line per step for a popover or a card's corner, where the steps sit beside
     * other content. The marks stay ink (a thin check, a spinner, a ring) so the current step reads by
     * weight; only a failed step takes colour. `regular` (default) is a sheet of full rows.
     */
    density?: 'regular' | 'compact';
}>) {
    const { theme } = useUnistyles();
    const showStepMessages = props.showStepMessages ?? true;

    if (props.density === 'compact') {
        return (
            <View style={styles.compactList}>
                {props.steps.map((step) => {
                    const current = step.status === 'active' || step.status === 'waiting';
                    const failed = step.status === 'failed';
                    const message = showStepMessages && typeof step.message === 'string' && step.message.trim() ? step.message.trim() : null;
                    return (
                        <View
                            key={step.stepId}
                            testID={`${props.testIDPrefix}-${step.status}-${encodeProgressChecklistStepIdForTestId(step.stepId)}`}
                            accessible
                            accessibilityLabel={message ? `${step.title}. ${message}` : step.title}
                            accessibilityState={{ busy: step.status === 'active' }}
                            style={styles.compactRow}
                        >
                            <View style={styles.compactMark}>
                                {step.status === 'active' ? (
                                    <ActivitySpinner size="small" accessibilityElementsHidden importantForAccessibility="no" />
                                ) : (
                                    <Icon
                                        name={step.status === 'done' ? 'check' : failed ? 'x' : step.status === 'canceled' ? 'minus-circle' : step.status === 'waiting' ? 'question' : 'circle'}
                                        size={ICON_SIZE.xs}
                                        color={failed ? theme.colors.state.danger.foreground : current ? theme.colors.text.primary : theme.colors.text.tertiary}
                                    />
                                )}
                            </View>
                            <Text style={[styles.compactTitle, current ? styles.compactTitleCurrent : null, step.status === 'pending' || step.status === 'canceled' ? styles.compactTitlePending : null, failed ? styles.compactTitleFailed : null]}>
                                {message ? `${step.title} · ${message}` : step.title}
                            </Text>
                            {step.detail ? <Text style={styles.compactDetail}>{step.detail}</Text> : null}
                        </View>
                    );
                })}
            </View>
        );
    }

    return props.steps.map((step) => {
        const testId = `${props.testIDPrefix}-${step.status}-${encodeProgressChecklistStepIdForTestId(step.stepId)}`;
        const iconName: IconName = step.status === 'done'
            ? 'check-circle'
            : step.status === 'failed'
                ? 'x-circle'
                : step.status === 'canceled'
                    ? 'minus-circle'
                    : step.status === 'waiting'
                        ? 'question'
                        : 'circle';
        // 'active' and 'pending' both render the same 'circle' glyph; Phosphor expresses the old
        // filled-vs-outline Ionicons pair ('ellipse' vs 'ellipse-outline') as a weight, not a name.
        const iconWeight: IconWeight | undefined = step.status === 'active' ? 'fill' : undefined;
        const iconColor = step.status === 'done'
            ? theme.colors.state.success.foreground
            : step.status === 'failed'
                ? theme.colors.state.danger.foreground
                : step.status === 'active' || step.status === 'waiting'
                    ? theme.colors.accent.blue
                    : theme.colors.text.tertiary;
        const subtitle = showStepMessages && (typeof step.message === 'string' && step.message.trim())
            ? step.message.trim()
            : null;

        return (
            <Item
                key={step.stepId}
                testID={testId}
                title={step.title}
                subtitle={subtitle}
                icon={<Icon name={iconName} size={16} color={iconColor} weight={iconWeight} />}
                loading={step.status === 'active'}
                detail={step.detail ?? undefined}
                showChevron={false}
                mode="info"
                accessibilityLabel={subtitle ? `${step.title}. ${subtitle}` : step.title}
            />
        );
    });
});

const styles = StyleSheet.create((theme) => ({
    compactList: {
        gap: 6,
    },
    compactRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    compactMark: {
        width: ICON_SIZE.sm,
        height: ICON_SIZE.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    compactTitle: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 0,
    },
    compactTitleCurrent: {
        ...Typography.default('medium'),
        color: theme.colors.text.primary,
    },
    compactTitlePending: {
        color: theme.colors.text.tertiary,
    },
    compactTitleFailed: {
        color: theme.colors.state.danger.foreground,
    },
    compactDetail: {
        ...Typography.default(),
        ...Typography.tabular(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
}));
