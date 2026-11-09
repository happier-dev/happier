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

/** A container's body (lab `.uwe-cb`): its lanes one ordinal column in, each forking off its spine. */
export function WorkflowContainerBody(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    return <View style={workflowEditorStyles.containerBody}>{props.children}</View>;
}

/**
 * Where a block's spine runs (lab round 1106 F1): to the next block's mark, to the block's own end
 * (a lane's last block, a list's last container), or past a lane's end inserter while editing.
 */
export type WorkflowSpineReach = 'next' | 'end' | 'endPastInserter';

/** The spine below one block's mark, in its ordinal column. Drawing only: hidden from assistive technology. */
export function WorkflowSpineSegment(props: Readonly<{
    reach: WorkflowSpineReach;
    testID?: string;
}>): React.ReactElement {
    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                workflowEditorStyles.spineSegment,
                props.reach === 'next' ? workflowEditorStyles.spineToNext
                    : props.reach === 'end' ? workflowEditorStyles.spineToEnd : workflowEditorStyles.spineToEndPastInserter,
            ]}
        />
    );
}

/**
 * One lane of a container (its authored name or "Lane 1", "Then", "Otherwise", "Repeat these
 * steps"): it forks off the container's spine at its label and joins back where the lane ends, so a
 * branch reads as a detour that returns to the flow; an If's header says when it runs. A lane's own
 * actions (Remove) open from a caret beside its name, never as a destructive word at rest
 * and never as a second `⋯` above its first step's.
 */
export function WorkflowContainerLane(props: Readonly<{
    label: string;
    /**
     * The label's words when they are richer than `label` (an If's condition with its reference
     * tokens); `label` still names the lane for its menu.
     */
    content?: React.ReactNode;
    /** Opens what the label states (an If's condition), anchored on the label; absent when reading. */
    onPressLabel?: (anchorRef: React.RefObject<View | null>) => void;
    /** The label button's accessible name when it opens something. */
    labelAccessibilityLabel?: string;
    /** A Side by side lane's authored name, editable in place; "Lane {n}" is its placeholder (07). */
    nameEditor?: InlineTextEditor;
    actions?: readonly WorkflowBlockAction[];
    labelTestID: string;
    actionsTestID?: string;
    children: React.ReactNode;
    /** What ends the lane before it joins back (a loop's stop rule and round limit). */
    footer?: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // An editable lane name is sized to its words, so its caret sits right after it (DESIGN-6 M1).
    const [nameWidth, setNameWidth] = React.useState<number | null>(null);
    const labelAnchorRef = React.useRef<View>(null);
    const { onPressLabel } = props;
    const words = props.content ?? props.label;
    const label = props.nameEditor !== undefined
        ? <InlineTextField editor={{ ...props.nameEditor, testID: props.labelTestID }}
            style={[workflowEditorStyles.laneLabelInput, { width: nameWidth ?? undefined, maxWidth: '100%' }]} />
        : onPressLabel === undefined
            ? <Text testID={props.labelTestID} numberOfLines={props.content === undefined ? 1 : 2} style={workflowEditorStyles.laneLabel}>{words}</Text>
            : (
                <View ref={labelAnchorRef} collapsable={false} style={workflowEditorStyles.laneLabelButton}>
                    <HappierPressable
                        testID={props.labelTestID}
                        accessibilityRole="button"
                        accessibilityLabel={props.labelAccessibilityLabel ?? props.label}
                        hasPopup="dialog"
                        onPress={() => onPressLabel(labelAnchorRef)}
                        style={(state) => [
                            workflowEditorStyles.actionTarget,
                            state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        ]}
                    >
                        <Text numberOfLines={2} style={workflowEditorStyles.laneLabel}>{words}</Text>
                    </HappierPressable>
                </View>
            );
    return (
        <View accessibilityRole="none">
            <View style={workflowEditorStyles.laneLabelRow}>
                {props.nameEditor === undefined ? null : (
                    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                        style={workflowEditorStyles.headingNameMeasure}>
                        <Text testID={`${props.labelTestID}-measure`} style={workflowEditorStyles.laneLabel}
                            onLayout={(event) => setNameWidth(Math.ceil(event.nativeEvent.layout.width) + theme.space.s4)}>
                            {props.nameEditor.value.length > 0 ? props.nameEditor.value : props.nameEditor.placeholder}
                        </Text>
                    </View>
                )}
                <View
                    testID={`${props.labelTestID}-tick`}
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={workflowEditorStyles.laneFork}
                />
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                    style={workflowEditorStyles.laneLead} />
                {label}
                {props.actions === undefined || props.actions.length === 0 ? null : (
                    <View style={workflowEditorStyles.laneCaret}>
                        <WorkflowBlockActionsMenu blockLabel={props.label} actions={props.actions} trigger="caret" testID={props.actionsTestID} />
                    </View>
                )}
            </View>
            {props.children}
            {props.footer}
            <View testID={`${props.labelTestID}-join`} pointerEvents="none" accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants" style={workflowEditorStyles.laneJoin}>
                <View style={workflowEditorStyles.laneJoinBend} />
            </View>
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
