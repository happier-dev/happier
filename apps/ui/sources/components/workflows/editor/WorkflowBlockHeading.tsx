import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { WorkflowBlockActionsMenu, type WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * The one heading every authored block uses: a stable tabular ordinal, the
 * block's name as the control that selects it, and its overflow actions.
 *
 * The name is a real button rather than pressable text, so it is focusable,
 * announced as an action and answers press, hover and keyboard focus through
 * the same feedback as every other editor control. Its accessible name carries
 * the block's context and its hint the first validation issue, which is how a
 * screen reader hears "which block, where, and whether it needs repair" at the
 * block boundary without an outer container swallowing the editable prompt.
 */
export function WorkflowBlockHeading(props: Readonly<{
    ordinal: number;
    displayName: string;
    /** Name, position and set size for assistive technology; defaults to the name. */
    accessibilityLabel?: string;
    /** The first issue on this block, when it needs repair. */
    issue?: string | null;
    actions: readonly WorkflowBlockAction[];
    /** Contributed Agent brand or the Action, Workflow or person glyph, never a backing tile. */
    kindMark?: React.ReactNode;
    /** The heading line's fixed slot for a reader's facts (a state word, an occurrence selector). */
    accessory?: React.ReactNode;
    onSelect: () => void;
    testID: string;
    actionsTestID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={workflowEditorStyles.heading}>
            <Text
                style={workflowEditorStyles.ordinal}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                {t('workflows.editor.stepOrdinal', { position: props.ordinal })}
            </Text>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel ?? props.displayName}
                {...(props.issue === undefined || props.issue === null ? {} : { accessibilityHint: props.issue })}
                onPress={props.onSelect}
                style={(state) => [
                    workflowEditorStyles.actionTarget,
                    workflowEditorStyles.headingButton,
                    state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                {props.kindMark === undefined ? null : <View testID={`${props.testID}-kind-mark`}
                    accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {props.kindMark}
                </View>}
                <Text numberOfLines={2} style={workflowEditorStyles.headingName}>{props.displayName}</Text>
            </HappierPressable>
            <View style={workflowEditorStyles.headingActions}>
                {props.accessory ?? null}
                <WorkflowBlockActionsMenu
                    blockLabel={props.displayName}
                    actions={props.actions}
                    testID={props.actionsTestID}
                />
            </View>
        </View>
    );
}
