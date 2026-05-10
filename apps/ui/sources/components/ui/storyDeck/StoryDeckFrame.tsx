import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WizardStepDots } from '@/components/onboarding/ui/WizardStepDots';

export type StoryDeckFrameProps = Readonly<{
    children: React.ReactNode;
    footer: React.ReactNode;
    currentIndex: number;
    totalCount: number;
    testID?: string;
}>;

const stylesheet = StyleSheet.create({
    container: {
        flex: 1,
        flexShrink: 1,
        minHeight: 0,
    },
    dotRow: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 4,
        paddingBottom: 10,
    },
    body: {
        flex: 1,
        minHeight: 0,
    },
    footer: {
        paddingHorizontal: 28,
        paddingTop: 0,
        paddingBottom: 20,
        gap: 10,
    },
});

/**
 * Inner story-deck chrome: paged body fills the sheet, with dots and action
 * footer grouped at the bottom like Notelet.
 */
export function StoryDeckFrame(props: StoryDeckFrameProps) {
    useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.container} testID={props.testID}>
            <View style={styles.body}>
                {props.children}
            </View>
            {props.totalCount > 1 ? (
                <View style={styles.dotRow}>
                    <WizardStepDots
                        currentStepIndex={props.currentIndex}
                        stepCount={props.totalCount}
                    />
                </View>
            ) : null}
            <View style={styles.footer}>{props.footer}</View>
        </View>
    );
}
