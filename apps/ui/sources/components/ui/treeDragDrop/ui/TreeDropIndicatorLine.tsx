import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierDropInsertionLine } from '@happier-dev/plugin-ui/presentation';

import type { TreeInstructionVisual } from '../treeDragDropTypes';

export type TreeDropIndicatorLineProps = Readonly<{
    visual: Extract<TreeInstructionVisual, { kind: 'line' }>;
    indentPx: number;
    /** `vertical`: the insertion mark between two items laid out in a row (a tab strip). */
    orientation?: 'horizontal' | 'vertical';
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

/** Happier core's binding of the one insertion line (plugin-ui): the theme accent and a tree's indent. */
export function TreeDropIndicatorLine(props: TreeDropIndicatorLineProps): React.ReactElement {
    const { theme } = useUnistyles();
    const vertical = props.orientation === 'vertical';
    const marginLeft = vertical ? 0 : Math.max(0, props.visual.depth * props.indentPx);
    return (
        <HappierDropInsertionLine
            testID={props.testID}
            orientation={props.orientation}
            color={theme.colors.accent.blue}
            style={[{ marginLeft }, props.style]}
        />
    );
}
