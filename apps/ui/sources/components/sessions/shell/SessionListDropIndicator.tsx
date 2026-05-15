import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    TreeDropIndicatorLine,
    TreeDropOutline,
    type TreeInstructionVisual,
} from '@/components/ui/treeDragDrop';

const SESSION_LIST_FOLDER_INDENT_PX = 6;

const stylesheet = StyleSheet.create(() => ({
    lineLayer: {
        position: 'absolute' as const,
        left: 16,
        right: 16,
        zIndex: 10,
    },
    outlineLayer: {
        position: 'absolute' as const,
        left: 8,
        right: 8,
        top: 2,
        bottom: 2,
        zIndex: 9,
    },
}));

export const SessionListDropIndicator = React.memo(function SessionListDropIndicator(props: Readonly<{
    targetId: string;
    visual: TreeInstructionVisual;
}>) {
    const styles = stylesheet;
    if (props.visual.kind === 'outline' && props.visual.targetId === props.targetId) {
        return (
            <TreeDropOutline
                visual={props.visual}
                style={styles.outlineLayer}
            />
        );
    }
    if (props.visual.kind !== 'line' || props.visual.targetId !== props.targetId) return null;

    return (
        <View
            style={[
                styles.lineLayer,
                props.visual.edge === 'bottom' ? { bottom: 0 } : { top: 0 },
            ]}
            pointerEvents="none"
        >
            <TreeDropIndicatorLine
                visual={props.visual}
                indentPx={SESSION_LIST_FOLDER_INDENT_PX}
            />
        </View>
    );
});
