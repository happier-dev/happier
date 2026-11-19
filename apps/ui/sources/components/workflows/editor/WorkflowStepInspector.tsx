import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

import {
    type WorkflowStep,
    WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
} from '@happier-dev/protocol/workflows/workflowV1';
import { workflowSelectionChoosesEngineV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { withoutWorkflowAuthoringEngine } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';

import type { SessionAuthoringFieldId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';

import { WorkflowNumberField } from './WorkflowNumberField';
import { renderWorkflowCardFieldRow } from './workflowCardFieldRow';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * A step's own options beside the workflow's: which Session fields form its engine, whether the step
 * chooses its own, the way back to the workflow's, and its deadline.
 */

/**
 * A step's result-wait deadline: the exact value the author types, in the unit
 * the field states; empty is omission ("no authored deadline").
 */
export function WorkflowStepTimeoutField(props: Readonly<{
    timeoutMs: number | undefined;
    onChange: (timeoutMs: number | undefined) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    // One row on the options' label track: the field on the control column at the shared field width (the same row as
    // Workspace beside it), its placeholder the one "No deadline", the unit after a set number; what it means is the
    // field's hint, not a paragraph in the row (WF-ACCEPT-1118B item 1, WF-ACCEPT-1119 item 1).
    return renderWorkflowCardFieldRow('timeout', t('workflows.editor.timeoutTitle'), (
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
    ));
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

const QUIET_ACTION_START = { justifyContent: 'flex-start' } as const;

/**
 * The editor's quiet text action in a popover row: its words in the secondary tint, led by a + when it adds something
 * ("+ Add condition", "+ Add input"). One anatomy for every such action, so a row never grows a bare text button.
 */
export function WorkflowQuietAction(props: Readonly<{
    label: string;
    onPress: () => void;
    testID?: string;
    /** Spoken name when the visible words are not the whole action. Default: the words. */
    accessibilityLabel?: string;
    leadingPlus?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            onPress={props.onPress}
            style={(state) => [
                workflowEditorStyles.actionTarget,
                workflowEditorStyles.addRow,
                // Its words start on the row's edge (the target's centring is for its height, not across a stretched column).
                QUIET_ACTION_START,
                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            {props.leadingPlus === true ? <Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> : null}
            <Text style={workflowEditorStyles.metaAction}>{props.label}</Text>
        </HappierPressable>
    );
}

/**
 * The way back to the workflow's value on a step row whose own control shows that it is changed (a segmented bar's set
 * state), beside that control, as a changed chip offers it in its menu.
 */
export function WorkflowFieldReset(props: Readonly<{ testID: string; onReset: () => void }>): React.ReactElement {
    return <WorkflowQuietAction testID={props.testID} label={t('workflows.page.useWorkflowsValue')}
        accessibilityLabel={t('workflows.editor.useWorkflowDefault')} onPress={props.onReset} />;
}
