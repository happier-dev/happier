import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type WizardStepDotsProps = Readonly<{
    currentStepIndex: number;
    stepCount: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 18,
    },
    dot: {
        width: 5,
        height: 5,
        borderRadius: 999,
        backgroundColor: theme.colors.divider,
        opacity: theme.dark ? 0.72 : 0.5,
    },
    activeDot: {
        width: 20,
        height: 6,
        backgroundColor: theme.colors.text,
        opacity: theme.dark ? 0.9 : 0.96,
    },
}));

export function WizardStepDots(props: WizardStepDotsProps) {
    useUnistyles();
    const styles = stylesheet;
    const dots = Math.max(0, props.stepCount);
    const activeIndex = Math.max(0, Math.min(props.currentStepIndex, dots - 1));

    return (
        <View style={styles.root} accessibilityRole="progressbar" accessibilityValue={{ now: activeIndex + 1, min: 1, max: dots }}>
            {Array.from({ length: dots }).map((_, index) => (
                <View key={index} style={[styles.dot, index === activeIndex ? styles.activeDot : null]} />
            ))}
        </View>
    );
}
