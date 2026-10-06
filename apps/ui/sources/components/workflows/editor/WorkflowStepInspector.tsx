import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
    type WorkflowStep,
    type WorkflowStepExecutionSelection,
    type WorkflowEngineSelectionV1,
    type WorkflowSessionAuthoringSelection,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol';

import {
    findSessionAuthoringAgentTargetOption,
    resolveSessionAuthoringFieldTitle,
    type SessionAuthoringControlFacts,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import {
    resolveEffectiveWorkflowStepExecution,
    resolveWorkflowStepFieldInheritance,
} from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

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
        gap: theme.margins.md,
    },
    scopeLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        paddingVertical: theme.margins.xs,
    },
    fieldName: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    inheritedBadge: {
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
    },
    overrideBadge: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    resetAction: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
        marginLeft: 'auto',
    },
    control: {
        paddingBottom: theme.margins.sm,
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

export type WorkflowStepInspectorFieldId = (typeof WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS)[number];

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
        engine?: WorkflowEngineSelectionV1;
        onChangeEngine?: (engine: WorkflowEngineSelectionV1) => void;
        workflowRoles?: readonly WorkflowRoleV1[];
    }>) => React.ReactNode;
    onResetField: (field: WorkflowStepInspectorFieldId) => void;
    onChangeFields?: (fields: Partial<WorkflowSessionAuthoringSelection>) => void;
    onChangeEngine?: (engine: WorkflowEngineSelectionV1) => void;
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
    const engineOverridden = props.step.execution?.engine !== undefined
        || ['agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides']
            .some(field => Object.hasOwn(props.step.execution ?? {}, field));
    const effective = React.useMemo(
        () => resolveEffectiveWorkflowStepExecution(props.draft, props.step),
        [props.draft, props.step],
    );
    const selectedAgentTarget = React.useMemo(() => findSessionAuthoringAgentTargetOption(
        props.authoringFacts?.agentTargets,
        effective.agentTarget,
    ), [effective.agentTarget, props.authoringFacts?.agentTargets]);

    return (
        <View testID={testIDPrefix} style={styles.root}>
            <Text style={styles.scopeLabel}>
                {workflowBlockReferenceLabel(props.step)}
            </Text>

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
                const control = props.renderFieldControl?.({
                    field,
                    effective,
                    inheritance,
                    onChange: (value) => props.onChangeField(field, value),
                    onChangeFields: props.onChangeFields,
                    engine: props.step.execution?.engine ?? props.draft.defaults.engine,
                    onChangeEngine: props.onChangeEngine,
                    workflowRoles: props.draft.roles,
                });

                return (
                    <View key={field}>
                        <View style={styles.fieldRow}>
                            {/* The field's own canonical name, the same string
                                its picker is titled with. Agent-contributed
                                runtime copy wins over the localized generic
                                fallback. */}
                            <Text testID={fieldId} style={styles.fieldName}>
                                {field === engineField ? t('workflows.page.sections.agentTitle') : resolveSessionAuthoringFieldTitle(field, selectedAgentTarget) ?? field}
                            </Text>
                            <Text
                                testID={`${fieldId}-state`}
                                style={inheritance === 'inherited' ? styles.inheritedBadge : styles.overrideBadge}
                            >
                                {inheritance === 'inherited'
                                    ? t('workflows.page.blocks.workflowDefaults')
                                    : t('workflows.page.changedForStep')}
                            </Text>
                            {inheritance === 'override' ? (
                                <HappierPressable
                                    testID={`${fieldId}-reset`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('workflows.editor.useWorkflowDefault')}
                                    onPress={() => field === engineField && props.onResetEngine !== undefined
                                        ? props.onResetEngine?.() : props.onResetField(field)}
                                    style={(state) => [
                                        workflowEditorStyles.actionTarget,
                                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                    ]}
                                >
                                    <Text style={styles.resetAction}>
                                        {t('workflows.editor.useWorkflowDefault')}
                                    </Text>
                                </HappierPressable>
                            ) : null}
                        </View>
                        {control === null || control === undefined ? null : (
                            <View style={styles.control}>{control}</View>
                        )}
                    </View>
                );
            })}
        </View>
    );
}
