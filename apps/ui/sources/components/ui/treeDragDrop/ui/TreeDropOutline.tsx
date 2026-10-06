import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierDropTargetOutline } from '@happier-dev/plugin-ui/presentation';

import type { TreeInstructionVisual } from '../treeDragDropTypes';

export type TreeDropOutlineProps = Readonly<{
    visual: Extract<TreeInstructionVisual, { kind: 'outline' }>;
    testID?: string;
    /** The corner of the surface the outline lies over (a composer), when it is not a row. */
    radius?: number;
    style?: React.ComponentProps<typeof HappierDropTargetOutline>['style'];
}>;

export function TreeDropOutline(props: TreeDropOutlineProps): React.ReactElement {
    const { theme } = useUnistyles();
    return <HappierDropTargetOutline testID={props.testID} colors={theme.colors.state.active} radius={props.radius} style={props.style} />;
}
