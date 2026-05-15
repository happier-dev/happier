import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { TreeInstructionVisual } from '../treeDragDropTypes';

export type TreeDropOutlineProps = Readonly<{
    visual: Extract<TreeInstructionVisual, { kind: 'outline' }>;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create(() => ({
    outline: {
        borderWidth: 1,
        borderRadius: 6,
    },
}));

export function TreeDropOutline(props: TreeDropOutlineProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View
            testID={props.testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                styles.outline,
                {
                    borderColor: theme.colors.state.active.border,
                    backgroundColor: theme.colors.state.active.background,
                },
                props.style,
            ]}
        />
    );
}
