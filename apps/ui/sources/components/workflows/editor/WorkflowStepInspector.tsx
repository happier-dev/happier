import { withoutWorkflowAuthoringEngine } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
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
    type WorkflowStepExecutionSelection,
    type WorkflowSessionAuthoringSelection,
    WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
} from '@happier-dev/protocol/workflows/workflowV1';
import {
    readWorkflowEngineChoiceV1,
    workflowSelectionChoosesEngineV1,
    type WorkflowEngineChoiceV1,
} from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

import {
    findSessionAuthoringAgentTargetOption,
    resolveSessionAuthoringAgentId,
    resolveSessionAuthoringFieldTitle,
    type SessionAuthoringControlFacts,
    type SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import {
    resolveEffectiveWorkflowStepExecution,
    resolveWorkflowStepFieldInheritance,
} from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

import { WorkflowNumberField } from './WorkflowNumberField';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * The selected step's settings, shown in the wide inspector or the phone
 * focused-detail presentation. Both use this one composition and the same
 * selected-step owner, so switching layout never changes what can be authored.
 *
 * Value editing is delegated to `renderFieldControl`, which the host fills from
 * the shared Session-authoring controls. This module owns the part that is
 * workflow-specific: whether a field is inherited or explicitly overridden, and
 * the reset that returns it to the workflow default. An override equal to the
 * current default stays visibly explicit.
 */

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 0,
    },
    /**
     * A field's name, its state and its reset on one line while they fit; in a narrow popover the
     * reset wraps beneath rather than squeezing each into a two-line column (DESIGN-13, live).
     */
    fieldRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
        rowGap: 0,
        paddingVertical: theme.space.s4,
    },
    fieldName: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.primary,
    },
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
    return (
        <View>
            <WorkflowNumberField
                label={t('workflows.editor.timeoutTitle')}
                value={props.timeoutMs}
                onChange={props.onChange}
                placeholder={t('workflows.editor.noDeadline')}
                testID={`${props.testIDPrefix}-timeout`}
            />
            <Text style={styles.inheritedBadge}>{t('workflows.editor.timeoutExplain')}</Text>
        </View>
    );
}

export type WorkflowStepInspectorFieldId = SessionAuthoringFieldId;

/** The Agent and model arm, set as one choice (the engine); the step's other Session fields sit beside it. */
export const WORKFLOW_ENGINE_FIELD_IDS = Object.freeze(['agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides'] as const satisfies readonly SessionAuthoringFieldId[]);
export const WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE = Object.freeze(WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS.filter(
    (field) => !(WORKFLOW_ENGINE_FIELD_IDS as readonly string[]).includes(field)));

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

export function WorkflowStepInspector(props: Readonly<{
    draft: WorkflowEditorDraft;
    step: WorkflowStep;
    /**
     * The host supplies the canonical Session-authoring control for a field.
     * Returning `null` means this build cannot edit that field's value yet; the
     * inheritance state and reset still render, so nothing is silently hidden.
     */
    renderFieldControl?: (params: Readonly<{
        field: WorkflowStepInspectorFieldId;
        effective: WorkflowStepExecutionSelection;
        inheritance: 'inherited' | 'override';
        onChange: (value: WorkflowStepExecutionSelection[WorkflowStepInspectorFieldId] | undefined) => void;
        onChangeFields?: (fields: Partial<WorkflowSessionAuthoringSelection>) => void;
        engine?: WorkflowEngineChoiceV1;
        onChangeEngine?: (engine: WorkflowEngineChoiceV1) => void;
        workflowRoles?: readonly WorkflowRoleV1[];
        /** The field's inheritance state and reset, for the control to show beside its own name. */
        stateAccessory?: React.ReactNode;
    }>) => React.ReactNode;
    onResetField: (field: WorkflowStepInspectorFieldId) => void;
    onChangeFields?: (fields: Partial<WorkflowSessionAuthoringSelection>) => void;
    onChangeEngine?: (engine: WorkflowEngineChoiceV1) => void;
    onResetEngine?: () => void;
    onChangeField: (
        field: WorkflowStepInspectorFieldId,
        value: WorkflowStepExecutionSelection[WorkflowStepInspectorFieldId] | undefined,
    ) => void;
    /**
     * The step's authored result-wait deadline. `undefined` clears it: omission
     * means no workflow-authored deadline, never a default duration. Absent, the
     * deadline is authored elsewhere (Step options keeps it under Advanced).
     */
    onChangeTimeout?: (timeoutMs: number | undefined) => void;
    /** Fields to show; defaults to the canonical chip order. */
    fields?: readonly WorkflowStepInspectorFieldId[];
    /**
     * The host's option sources. Only the selected Agent is read here, and only
     * so an Agent-named field can be named by the Agent that names it.
     */
    authoringFacts?: SessionAuthoringControlFacts;
    testIDPrefix?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'workflow-inspector';
    const fields = props.fields ?? WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS;
    const engineField = props.onChangeFields === undefined ? undefined
        : fields.find(field => field === 'agentTarget' || field === 'modelSelection');
    const engineOverridden = workflowSelectionChoosesEngineV1(props.step.execution)
        || WORKFLOW_ENGINE_FIELD_IDS.some(field => Object.hasOwn(props.step.execution ?? {}, field));
    const effective = React.useMemo(
        () => resolveEffectiveWorkflowStepExecution(props.draft, props.step),
        [props.draft, props.step],
    );
    const selectedAgentTarget = React.useMemo(() => findSessionAuthoringAgentTargetOption(
        props.authoringFacts?.agentTargets,
        effective.agentTarget,
    ), [effective.agentTarget, props.authoringFacts?.agentTargets]);

    const waitsOnAgent = resolveSessionAuthoringAgentId({ agentTarget: effective.agentTarget, facts: props.authoringFacts }) === null;
    return (
        <View testID={testIDPrefix} style={styles.root}>
            {/* The step is named once, by the Step options header that holds this group. */}
            {props.onChangeTimeout === undefined ? null : (
                <WorkflowStepTimeoutField
                    timeoutMs={props.step.timeoutMs}
                    onChange={props.onChangeTimeout}
                    testIDPrefix={testIDPrefix}
                />
            )}

            {fields.map((field) => {
                if (engineField !== undefined && (field === 'acpSessionModeId' || field === 'sessionConfigOptionOverrides'
                    || ((field === 'agentTarget' || field === 'modelSelection') && field !== engineField))) return null;
                const inheritance = field === engineField ? (engineOverridden ? 'override' : 'inherited')
                    : resolveWorkflowStepFieldInheritance(props.step, field);
                const fieldId = `${testIDPrefix}-${field}`;

                const isEngine = field === engineField;
                const stateAccessory = (
                    <WorkflowFieldInheritance
                        fieldId={fieldId}
                        inheritance={inheritance}
                        onReset={() => isEngine && props.onResetEngine !== undefined
                            ? props.onResetEngine() : props.onResetField(field)}
                    />
                );
                const control = props.renderFieldControl?.({
                    field,
                    effective,
                    inheritance,
                    onChange: (value) => props.onChangeField(field, value),
                    onChangeFields: props.onChangeFields,
                    engine: readWorkflowEngineChoiceV1(props.draft.defaults, props.step.execution),
                    onChangeEngine: props.onChangeEngine,
                    workflowRoles: props.draft.roles,
                    stateAccessory,
                });

                // The control's own field row names the field and carries the state beside that name.
                // Only a field with no control of its own gets a name line here, so it is never silent.
                if (control !== null && control !== undefined) {
                    // Its Agent-owned fields wait on an Agent and their one-field forms hide, so it is said
                    // once, right under Agent and model where they would be (owner 2026-11-06).
                    return <React.Fragment key={field}>{control}{isEngine && waitsOnAgent ? (
                        <Text testID={`${testIDPrefix}-requires-agent`} style={workflowEditorStyles.metaText}>{t('newSession.chooseAgentFirst')}</Text>
                    ) : null}</React.Fragment>;
                }
                return (
                    <View key={field} style={styles.fieldRow}>
                        {/* The field's canonical name, the same string its picker is titled with.
                            Agent-contributed runtime copy wins over the localized generic fallback. */}
                        <Text testID={fieldId} style={styles.fieldName}>
                            {isEngine ? t('workflows.page.sections.agentTitle') : resolveSessionAuthoringFieldTitle(field, selectedAgentTarget) ?? field}
                        </Text>
                        {stateAccessory}
                    </View>
                );
            })}
        </View>
    );
}

/** Return the step's complete engine to workflow inheritance. */
export function withoutWorkflowStepEngine(execution: WorkflowStep['execution']): NonNullable<WorkflowStep['execution']> {
    return withoutWorkflowAuthoringEngine(execution);
}
