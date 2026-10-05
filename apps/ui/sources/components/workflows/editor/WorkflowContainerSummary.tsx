import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';

import { workflowEditorStyles, workflowPressFeedbackStyle } from './workflowEditorStyles';

/**
 * A container read as a sentence on the rail ("Side by side · 2 lanes · Stop
 * this group on failure", "For each item in ← Plan result · 3 at a time"),
 * 04 §4.3. Pressing it opens the container's options in the Step options
 * popover, anchored here; a read-only document shows the sentence alone.
 */
export function WorkflowContainerSummary(props: Readonly<{
    sentence: string;
    sentenceContent?: React.ReactNode;
    /** Opens the container's options; absent in a read-only document. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    optionsLabel: string;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const { onOpenOptions } = props;
    if (onOpenOptions === undefined) {
        return <Text testID={props.testID} style={workflowEditorStyles.groupSummary}>{props.sentenceContent ?? props.sentence}</Text>;
    }
    return (
        <View ref={anchorRef} collapsable={false} style={workflowEditorStyles.containerSummaryAnchor}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${props.optionsLabel}: ${props.sentence}`}
                hasPopup="dialog"
                onPress={() => onOpenOptions(anchorRef)}
                style={(state) => [
                    workflowEditorStyles.actionTarget,
                    workflowPressFeedbackStyle(state, theme.colors.border.focus),
                ]}
            >
                <Text style={workflowEditorStyles.metaAction}>{props.sentenceContent ?? props.sentence}</Text>
            </HappierPressable>
        </View>
    );
}
