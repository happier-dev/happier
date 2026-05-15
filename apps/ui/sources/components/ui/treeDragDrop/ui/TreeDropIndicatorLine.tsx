import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { TreeInstructionVisual } from '../treeDragDropTypes';

export type TreeDropIndicatorLineProps = Readonly<{
    visual: Extract<TreeInstructionVisual, { kind: 'line' }>;
    indentPx: number;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create(() => ({
    line: {
        height: 2,
        borderRadius: 1,
    },
}));

export function TreeDropIndicatorLine(props: TreeDropIndicatorLineProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const marginLeft = Math.max(0, props.visual.depth * props.indentPx);

    return (
        <View
            testID={props.testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                styles.line,
                {
                    marginLeft,
                    backgroundColor: theme.colors.accent.blue,
                },
                props.style,
            ]}
        />
    );
}
