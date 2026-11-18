import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    type WorkflowStep,
    WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
} from '@happier-dev/protocol/workflows/workflowV1';
import { workflowSelectionChoosesEngineV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { withoutWorkflowAuthoringEngine } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';

import type { SessionAuthoringFieldId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';

import { WorkflowNumberField } from './WorkflowNumberField';
import { WorkflowFieldPair } from './WorkflowStepDataEditor';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * A step's own options beside the workflow's: which Session fields form its engine, whether the step
 * chooses its own, the way back to the workflow's, the inheritance line a row shows, and its deadline.
 */

const styles = StyleSheet.create((theme) => ({
    inheritance: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        columnGap: theme.space.s8,
    },
    inheritedBadge: {
        ...Typography.variant('micro'),
        color: theme.colors.text.tertiary,
    },
    overrideBadge: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    resetAction: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.button.secondary.tint,
    },
}));

/**
 * A step's result-wait deadline: the exact value the author types, in the unit
 * the field states; empty is omission ("no authored deadline").
 */
export function WorkflowStepTimeoutField(props: Readonly<{
    timeoutMs: number | undefined;
    onChange: (timeoutMs: number | undefined) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    // One row on the options' label track: the field on the control column, its placeholder the one "No deadline",
    // the unit after a set number; what it means is the field's hint, not a paragraph in the row (WF-ACCEPT-1118B item 1).
    return (
        <View style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair label={t('workflows.editor.timeoutTitle')} trackKey="timeout">
                <WorkflowNumberField
                    presentation="track"
                    label={t('workflows.editor.timeoutTitle')}
                    value={props.timeoutMs}
                    onChange={props.onChange}
                    placeholder={t('workflows.editor.noDeadline')}
                    {...(props.timeoutMs === undefined ? {} : { suffix: t('workflows.editor.timeoutUnit') })}
                    accessibilityHint={t('workflows.editor.timeoutExplain')}
                    testID={`${props.testIDPrefix}-timeout`}
                />
            </WorkflowFieldPair>
        </View>
    );
}

/** The Agent and model arm, set as one choice (the engine); the step's other Session fields sit beside it. */
export const WORKFLOW_ENGINE_FIELD_IDS = Object.freeze(['agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides'] as const satisfies readonly SessionAuthoringFieldId[]);
export const WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE = Object.freeze(WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS.filter(
    (field) => !(WORKFLOW_ENGINE_FIELD_IDS as readonly string[]).includes(field)));

/** Whether a step chooses its own engine (role, Agent, model, mode or effort) rather than the workflow's. */
export function isWorkflowStepEngineOverridden(step: WorkflowStep): boolean {
    return workflowSelectionChoosesEngineV1(step.execution)
        || WORKFLOW_ENGINE_FIELD_IDS.some(field => Object.hasOwn(step.execution ?? {}, field));
}

/** A step's own selection without its engine, so the step runs on the workflow's again. */
export function withoutWorkflowStepEngine(execution: WorkflowStep['execution']): NonNullable<WorkflowStep['execution']> {
    return withoutWorkflowAuthoringEngine(execution);
}

/** A row's inheritance state ("From the workflow" / "Changed for this step · Use workflow's"). */
export function WorkflowFieldInheritance(props: Readonly<{
    fieldId: string;
    inheritance: 'inherited' | 'override';
    onReset: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    // Every row of the step scope says where its value comes from (owner 2026-11-15, lab r1 settings popover).
    if (props.inheritance === 'inherited') {
        return <Text testID={`${props.fieldId}-state`} style={styles.inheritedBadge}>{t('workflows.page.fromTheWorkflow')}</Text>;
    }
    return (
        <View style={styles.inheritance}>
            <Text
                testID={`${props.fieldId}-state`}
                style={styles.overrideBadge}
            >
                {t('workflows.page.changedForStep')}
            </Text>
            <HappierPressable
                testID={`${props.fieldId}-reset`}
                accessibilityRole="button"
                accessibilityLabel={t('workflows.editor.useWorkflowDefault')}
                onPress={props.onReset}
                style={(state) => [
                    workflowEditorStyles.actionTarget,
                    state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <Text style={styles.resetAction}>
                    {t('workflows.page.useWorkflowsValue')}
                </Text>
            </HappierPressable>
        </View>
    );
}
