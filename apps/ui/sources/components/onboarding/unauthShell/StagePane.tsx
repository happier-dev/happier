import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { BrandPanel } from './BrandPanel';
import { useBrandPaneTokens } from './brandPaneTokens';

export type StagePaneProps = Readonly<{
    testID?: string;
}>;

/** Desktop right-pane host for unauthenticated onboarding: the planet/brand composition. */
export const StagePane = React.memo(function StagePane(props: StagePaneProps) {
    const styles = stylesheet;
    const tokens = useBrandPaneTokens();
    return (
        <View
            testID={props.testID ?? 'unauth-shell-stage-pane'}
            style={[styles.root, { backgroundColor: tokens.background }]}
        >
            <View testID="unauth-shell-stage-brand-host" style={styles.brandHost}>
                <BrandPanel variant="desktop" />
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
    },
    brandHost: {
        flex: 1,
        minHeight: 0,
    },
}));
