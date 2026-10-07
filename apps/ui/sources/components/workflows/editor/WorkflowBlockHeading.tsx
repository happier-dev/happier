import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { InlineTextField, type InlineTextEditor } from '@/components/ui/text/InlineTextField';
import { workflowBlockOrdinalV1 } from '@happier-dev/protocol/workflows';
import { t } from '@/text';

import { WorkflowBlockActionsMenu, type WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { workflowEditorStyles } from './workflowEditorStyles';

export type WorkflowBlockNameEditor = InlineTextEditor;

/**
 * The one heading every authored block uses: a stable tabular ordinal, the
 * block's name as the control that selects it, and its overflow actions.
 *
 * The name is a caret-only field in the editor and a selection button for readers.
 * Its accessible name carries
 * the block's context and its hint the first validation issue, which is how a
 * screen reader hears "which block, where, and whether it needs repair" at the
 * block boundary without an outer container swallowing the editable prompt.
 */
export function WorkflowBlockHeading(props: Readonly<{
    ordinal: number;
    displayName: string;
    nameEditor?: InlineTextEditor;
    /** Catalog provenance beside a typed card's title; never an authored step name. */
    sourceLabel?: string;
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
                {t('workflows.editor.stepOrdinal', { position: Number(workflowBlockOrdinalV1(props.ordinal - 1)) })}
            </Text>
            {props.nameEditor === undefined ? <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={[props.accessibilityLabel ?? props.displayName, props.sourceLabel].filter(Boolean).join(' · ')}
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
                {props.sourceLabel === undefined ? null : (
                    <Text numberOfLines={1} style={[workflowEditorStyles.metaText, { flexShrink: 1 }]}>{props.sourceLabel}</Text>
                )}
            </HappierPressable> : (
                <View style={[workflowEditorStyles.headingButton, { flex: 1 }]}>
                    {props.kindMark === undefined ? null : <View testID={`${props.testID}-kind-mark`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.kindMark}</View>}
                    <InlineTextField editor={{ ...props.nameEditor, testID: props.testID, onFocus: props.onSelect,
                        ...(props.issue === undefined || props.issue === null ? {} : { accessibilityHint: props.issue }),
                        accessibilityLabel: props.accessibilityLabel ?? props.nameEditor.accessibilityLabel }}
                        style={[workflowEditorStyles.headingNameInput, { flex: 1 }]} />
                    {props.sourceLabel === undefined ? null : <Text numberOfLines={1} style={[workflowEditorStyles.metaText, { flexShrink: 1 }]}>{props.sourceLabel}</Text>}
                </View>
            )}
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
