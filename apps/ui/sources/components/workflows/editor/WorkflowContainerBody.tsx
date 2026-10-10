import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { InlineTextField, type InlineTextEditor } from '@/components/ui/text/InlineTextField';

import { WorkflowBlockActionsMenu, type WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * A container's body (lab `.uwe-cb`): its lists one ordinal column in, beside
 * one continuous rail through the container's ordinal. An If's rail is dashed:
 * its branches may not run.
 */
export function WorkflowContainerBody(props: Readonly<{
    conditional?: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <View style={workflowEditorStyles.containerBody}>
            <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[workflowEditorStyles.containerRail, props.conditional === true ? workflowEditorStyles.containerRailConditional : null]}
            />
            {props.children}
        </View>
    );
}

/**
 * One lane of a container, named on the tree line (its authored name or
 * "Lane 1", "Then", "Otherwise", "After each round"). A lane's own actions
 * (Remove) open from a caret beside its name, never as a destructive word at
 * rest and never as a second `⋯` above its first step's.
 */
export function WorkflowContainerLane(props: Readonly<{
    label: string;
    /** A Side by side lane's authored name, editable in place; "Lane {n}" is its placeholder (07). */
    nameEditor?: InlineTextEditor;
    conditional?: boolean;
    actions?: readonly WorkflowBlockAction[];
    labelTestID: string;
    actionsTestID?: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // An editable lane name is sized to its words, so its caret sits right after it (DESIGN-6 M1).
    const [nameWidth, setNameWidth] = React.useState<number | null>(null);
    return (
        <View accessibilityRole="none">
            <View style={workflowEditorStyles.laneLabelRow}>
                {props.nameEditor === undefined ? null : (
                    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                        style={workflowEditorStyles.headingNameMeasure}>
                        <Text testID={`${props.labelTestID}-measure`} style={workflowEditorStyles.laneLabel}
                            onLayout={(event) => setNameWidth(Math.ceil(event.nativeEvent.layout.width) + theme.margins.xs)}>
                            {props.nameEditor.value.length > 0 ? props.nameEditor.value : props.nameEditor.placeholder}
                        </Text>
                    </View>
                )}
                <View
                    testID={`${props.labelTestID}-tick`}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[workflowEditorStyles.laneTick, props.conditional === true ? workflowEditorStyles.laneTickConditional : null]}
                />
                {props.nameEditor === undefined
                    ? <Text testID={props.labelTestID} numberOfLines={1} style={workflowEditorStyles.laneLabel}>{props.label}</Text>
                    : <InlineTextField editor={{ ...props.nameEditor, testID: props.labelTestID }}
                        style={[workflowEditorStyles.laneLabelInput, { width: nameWidth ?? undefined, maxWidth: '100%' }]} />}
                {props.actions === undefined || props.actions.length === 0 ? null : (
                    <View style={workflowEditorStyles.laneCaret}>
                        <WorkflowBlockActionsMenu blockLabel={props.label} actions={props.actions} trigger="caret" testID={props.actionsTestID} />
                    </View>
                )}
            </View>
            {props.children}
        </View>
    );
}

/**
 * A container's consequence in its heading's trailing slot (lab `.uwe-cm`:
 * "Finish the others if one fails ⌄"). Editing, it opens the container's
 * options anchored here; reading, it is the quiet fact alone.
 */
export function WorkflowContainerOptionsControl(props: Readonly<{
    /** The consequence the options decide, when there is one to say. */
    label?: string;
    /** Names the control when it has no consequence of its own ("Options"). */
    optionsLabel: string;
    /** Opens the container's options; absent in a reading document. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const { onOpenOptions } = props;
    if (onOpenOptions === undefined) {
        return props.label === undefined ? null
            : <Text testID={props.testID} numberOfLines={1} style={workflowEditorStyles.kindCardNote}>{props.label}</Text>;
    }
    return (
        <View ref={anchorRef} collapsable={false}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.label === undefined ? props.optionsLabel : `${props.optionsLabel}: ${props.label}`}
                hasPopup="dialog"
                onPress={() => onOpenOptions(anchorRef)}
                style={(state) => [
                    workflowEditorStyles.actionTarget,
                    workflowEditorStyles.trailingControl,
                    state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                {props.label === undefined ? null
                    : <Text numberOfLines={1} style={workflowEditorStyles.kindCardNote}>{props.label}</Text>}
                <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            </HappierPressable>
        </View>
    );
}
