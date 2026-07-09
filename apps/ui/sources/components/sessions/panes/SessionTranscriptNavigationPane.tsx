import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    TranscriptNavigationPanel,
    type TranscriptNavigationPanelProps,
} from '@/components/sessions/transcript/navigation/TranscriptNavigationPanel';

export type SessionTranscriptNavigationPaneProps = TranscriptNavigationPanelProps;

const stylesheet = StyleSheet.create((theme) => ({
    pane: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
}));

function defaultTestIDPrefix(prefix: string | undefined): string {
    return prefix && prefix.trim().length > 0 ? prefix.trim() : 'session-transcript-navigation';
}

export const SessionTranscriptNavigationPane = React.memo((props: SessionTranscriptNavigationPaneProps) => {
    const styles = stylesheet;
    const testIDPrefix = defaultTestIDPrefix(props.testIDPrefix);

    return (
        <View testID={`${testIDPrefix}-pane`} style={styles.pane}>
            <TranscriptNavigationPanel
                {...props}
                testIDPrefix={testIDPrefix}
            />
        </View>
    );
});
