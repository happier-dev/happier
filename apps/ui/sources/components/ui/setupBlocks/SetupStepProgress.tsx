import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HappierStepMarkerView } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type SetupStepProgressStep = Readonly<{ key: string; label: string }>;

/**
 * The step cue of a multi-step settings flow (add the email, confirm it, choose the password; set the
 * account's settings, then sign in): one numbered marker and label per step along a rule, the current
 * step leading and finished steps ticked, with an optional hint for the current step. It names which
 * step the person is on and that more follow; the flow's own forms stay the steps' content. Ordered
 * progress that reports each step's state (a system task, an import) is `PlanChecklistCard`.
 */
export function SetupStepProgress(props: Readonly<{
    steps: readonly SetupStepProgressStep[];
    /** Index into `steps`. */
    current: number;
    testID: string;
    /** Names the current step for assistive technology; the value announces its place among the steps. */
    accessibilityLabel: string;
    hint?: string;
    /** Surfaces that already inset their body drop the step block's own inset. */
    inset?: boolean;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    return (
        <View style={[styles.setup, props.inset === false ? styles.flush : null]}>
            <View
                testID={props.testID}
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={props.accessibilityLabel}
                accessibilityValue={{ min: 1, max: props.steps.length, now: props.current + 1 }}
                style={styles.steps}
            >
                {props.steps.map((step, index) => {
                    const done = index < props.current;
                    const active = index === props.current;
                    const color = active ? theme.colors.text.primary : theme.colors.text.secondary;
                    return (
                        <React.Fragment key={step.key}>
                            {index > 0 ? <View style={styles.stepRule} /> : null}
                            <View style={styles.step}>
                                <HappierStepMarkerView marker={{ kind: 'number', value: index + 1 }}
                                    numberState={done ? 'done' : active ? 'current' : 'upcoming'} theme={presentationTheme}
                                    stateGlyph={<Icon name="check" size={12} color={theme.colors.state.success.foreground} />} />
                                <Text style={[active ? styles.stepLabelActive : styles.stepLabel, { color }]}>
                                    {step.label}
                                </Text>
                            </View>
                        </React.Fragment>
                    );
                })}
            </View>
            {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    setup: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s4, paddingBottom: theme.space.s10, gap: theme.space.s8, maxWidth: 560 },
    flush: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
    steps: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', rowGap: theme.space.s6 },
    step: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    stepLabel: { ...Typography.variant('body') },
    stepLabelActive: { ...Typography.variant('body', 'medium') },
    stepRule: { width: 16, height: 1, marginHorizontal: theme.space.s8, backgroundColor: theme.colors.border.default },
    hint: { flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary },
}));
