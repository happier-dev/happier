import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type StepProgressState = 'done' | 'current' | 'failed' | 'pending';

export type StepProgressItem = Readonly<{
    id: string;
    label: string;
    state: StepProgressState;
    testID?: string;
    /** A line under the current step's label, e.g. "Reading 12 of 40". */
    caption?: string | null;
    /** A known fraction draws the step's bar. */
    progress?: Readonly<{ fraction: number; testID?: string }> | null;
    /** Anything the owner prints under the bar (percent, bytes, a path). */
    meta?: React.ReactNode;
    /** Selected for assistive tech; defaults to the current step. A finished run keeps its last reported step selected. */
    selected?: boolean;
}>;

const MARKER = 16;

/**
 * One step-by-step progress timeline, shared by every long task that has named phases (session
 * handoff, transcript export): a check for each finished step, the live spinner on the current
 * one, a warning on the one that failed and a quiet ring on the rest. The owner of the work decides
 * each step's state; this only draws it, so the list never has its own idea of what is running.
 */
export const StepProgressList = React.memo(function StepProgressList(props: Readonly<{
    steps: readonly StepProgressItem[];
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={styles.timeline}>
            {props.steps.map((step) => {
                const current = step.state === 'current' || step.state === 'failed';
                const fraction = current && step.progress ? Math.min(1, Math.max(0, step.progress.fraction)) : null;
                return (
                    <View
                        key={step.id}
                        testID={step.testID}
                        accessibilityState={{ checked: step.state === 'done', selected: step.selected ?? current }}
                        style={styles.row}
                    >
                        <View style={styles.marker}>
                            {step.state === 'done' ? (
                                <Icon name="check" size={MARKER} color={theme.colors.accent.blue} />
                            ) : step.state === 'failed' ? (
                                <Icon name="warning" size={MARKER} color={theme.colors.state.danger.foreground} />
                            ) : step.state === 'current' ? (
                                <ActivitySpinner size={iconMatchedSpinnerSize(MARKER)} color={theme.colors.accent.blue} />
                            ) : (
                                <View style={styles.dot} />
                            )}
                        </View>
                        <View style={[styles.content, fraction !== null ? styles.contentWithProgress : null]}>
                            <Text style={[styles.label, current ? styles.labelCurrent : null]}>{step.label}</Text>
                            {current && step.caption ? <Text style={styles.caption}>{step.caption}</Text> : null}
                            {fraction !== null ? (
                                <View
                                    testID={step.progress?.testID}
                                    accessibilityRole="progressbar"
                                    accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
                                    style={styles.track}
                                >
                                    <View style={[styles.fill, { width: `${Math.max(fraction * 100, 4)}%` }]} />
                                </View>
                            ) : null}
                            {current ? step.meta : null}
                        </View>
                    </View>
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    timeline: {
        gap: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        minHeight: 34,
    },
    marker: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dot: {
        width: 14,
        height: 14,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    content: {
        flex: 1,
        gap: 8,
        paddingBottom: 6,
    },
    contentWithProgress: {
        paddingBottom: 14,
    },
    label: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
    labelCurrent: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    caption: {
        ...Typography.default(),
        ...Typography.tabular(),
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    track: {
        height: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.border.default,
        overflow: 'hidden',
    },
    fill: {
        height: '100%',
        borderRadius: 999,
        backgroundColor: theme.colors.accent.blue,
        minWidth: 6,
    },
}));
