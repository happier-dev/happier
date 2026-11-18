import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { personalizeLayoutTokens } from './personalizeLayoutTokens';

export type PersonalizeSplitFrameOrientation = 'narration-left' | 'narration-right';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
        backgroundColor: theme.colors.surface.base,
    },
    narrationPane: {
        width: personalizeLayoutTokens.narration.width,
        maxWidth: personalizeLayoutTokens.narration.maxWidth,
        minWidth: personalizeLayoutTokens.narration.minWidth,
        minHeight: 0,
        justifyContent: 'flex-start',
        position: 'relative',
        backgroundColor: theme.dark ? 'rgba(5,5,8,.94)' : 'rgba(250,249,247,.96)',
    },
    narrationPaneLeft: {
        borderRightWidth: 1,
        borderRightColor: theme.dark ? personalizeLayoutTokens.narration.dividerColor.dark : personalizeLayoutTokens.narration.dividerColor.light,
    },
    narrationPaneRight: {
        borderLeftWidth: 1,
        borderLeftColor: theme.dark ? personalizeLayoutTokens.narration.dividerColor.dark : personalizeLayoutTokens.narration.dividerColor.light,
    },
    scrollFill: {
        flex: 1,
        width: '100%',
        minHeight: 0,
    },
    scrollContent: {
        flexGrow: 1,
        flexDirection: 'column',
        paddingHorizontal: 44,
        paddingTop: theme.space.s48,
        paddingBottom: 28,
        gap: 18,
    },
    stageHost: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
}));

/**
 * Personalize Happier's split frame: one narration column (a single vertical scroll holding the
 * step's words and its config slot) beside one stage holding the live workspace preview.
 */
export function PersonalizeSplitFrame(props: Readonly<{
    testID: string;
    orientation: PersonalizeSplitFrameOrientation;
    narration: React.ReactNode;
    stage: React.ReactNode;
}>): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const narrationPane = (
        <View
            key="narration"
            testID={`${props.testID}-narration-pane`}
            style={[
                styles.narrationPane,
                props.orientation === 'narration-left'
                    ? styles.narrationPaneLeft
                    : styles.narrationPaneRight,
            ]}
        >
            <ScrollView
                testID={`${props.testID}-narration-scroll`}
                style={styles.scrollFill}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                {props.narration}
            </ScrollView>
        </View>
    );
    const stagePane = (
        <View key="stage" testID={`${props.testID}-stage-host`} style={styles.stageHost}>
            {props.stage}
        </View>
    );
    return (
        <View testID={props.testID} style={styles.root}>
            {props.orientation === 'narration-left' ? narrationPane : stagePane}
            {props.orientation === 'narration-left' ? stagePane : narrationPane}
        </View>
    );
}
