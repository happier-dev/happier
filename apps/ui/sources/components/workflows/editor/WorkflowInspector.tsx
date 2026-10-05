import * as React from 'react';
import { View } from 'react-native';

import {
    SessionAuthoringControls,
    useSessionAuthoringFieldSummary,
} from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import {
    readSessionAuthoringAgentTargetValue,
    retireUnavailableSessionAuthoringRuntimeDescriptor,
    type SessionAuthoringControlFacts,
    type SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import {
    WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
} from '@happier-dev/protocol/workflows/workflowV1';
import {
    findWorkflowBlock,
    setWorkflowDefaultField,
    setWorkflowFinalOutput,
    setWorkflowInputs,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
    listWorkflowFinalOutputOptions,
    type WorkflowDraftValidation,
    type WorkflowExistingSessionOption,
} from '@/sync/domains/workflows/workflowAuthoring';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';

import type { WorkflowRunAsTarget, WorkflowRunAsTargetKind } from '../run/workflowRunAsTargets';
import { formatWorkflowContinuitySummary, WorkflowContinuityControls } from './WorkflowContinuityControls';
import { WorkflowFinalOutputEditor } from './WorkflowFinalOutputEditor';
import { WorkflowInputsEditor } from './WorkflowInputsEditor';
import { WorkflowRolesEditor } from './WorkflowRolesEditor';
import { formatWorkflowWhereSummary, WorkflowProjectTargetControl } from './WorkflowProjectTargetControl';
import { WorkflowBlockOptions } from './WorkflowBlockOptions';
import { issuesUnder, NO_DISCLOSURE, WorkflowInspectorGroup } from './workflowInspectorGroup';
import { workflowEditorStyles } from './workflowEditorStyles';
import type { WorkflowSessionDrop } from './useWorkflowSessionBinding';
import { withWorkflowAuthoringEngine, withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

/**
 * The one content owner for workflow and step settings (04 §5.2): one
 * subject-aware content, two presentations.
 *
 * - `workflow` subject, `pane` presentation: the editor's Workflow settings,
 *   docked or overlaid by the pane resolver, or in `@/modal` on a phone.
 * - `block` subject, `popover` presentation: Step options, anchored beside the
 *   step's Customize control, or in `@/modal` on a phone.
 *
 * Settings groups are quiet by default: each is one disclosure whose closed
 * line is its effective values. A group is open when it holds a value set for
 * this subject, an issue, or a required-but-missing field, or when the person
 * opened it — the person's choice lives in the editor view state, never in the
 * definition. A closed disclosure never hides an error or a required field.
 *
 * Triggers and definition-local roles extend the same draft/history owner.
 */
export type WorkflowInspectorSubject =
    | Readonly<{ kind: 'workflow' }>
    | Readonly<{ kind: 'block'; blockId: string }>;

export type WorkflowInspectorPresentation = 'pane' | 'popover';

export type WorkflowInspectorProps = Readonly<{
    subject: WorkflowInspectorSubject;
    presentation: WorkflowInspectorPresentation;
    draft: WorkflowEditorDraft;
    onChange: (next: WorkflowEditorDraft) => void;
    /** Definition access is independent of the active Account's personal triggers. */
    documentEditable?: boolean;
    /** The page's validation: an issue inside a group keeps that group open. */
    validation?: WorkflowDraftValidation;
    /** The person's own open/closed choices, from the editor view state. */
    groupDisclosure?: ReadonlyMap<string, boolean>;
    onChangeGroupDisclosure?: (groupId: string, expanded: boolean) => void;
    /** Closes the popover presentation ("Done"). */
    onDone?: () => void;
    authoringFacts?: SessionAuthoringControlFacts;
    existingSessions?: readonly WorkflowExistingSessionOption[];
    bindExistingSession?: WorkflowSessionDrop['bind'];
    /** Where it runs: the host's placement, edited through the Where owner. */
    projectTarget?: WorkflowAuthoringTarget | null;
    machineName: string | null;
    projectMachines?: readonly Machine[];
    onChangeProjectTarget?: (target: WorkflowAuthoringTarget) => void;
    /** "Each step runs in": the run default (U5 precedence 4) and each class's availability. */
    executionTarget?: WorkflowRunAsTargetKind;
    runAsTargets?: readonly WorkflowRunAsTarget[];
    onChangeExecutionTarget?: (kind: WorkflowRunAsTargetKind) => void;
    /**
     * The workflow subject's first section, **Runs automatically** (07 S10, S4): the trigger owner's
     * `WorkflowTriggerSection`, supplied by the host that owns the trigger draft.
     */
    runsAutomatically?: React.ReactNode;
    testIDPrefix: string;
}>;

/** The fields the Agent and model summary reads, in the chips' order. */
const AGENT_SUMMARY_FIELDS: readonly SessionAuthoringFieldId[] = ['agentTarget', 'modelSelection', 'permissionMode'];


export function WorkflowInspector(props: WorkflowInspectorProps): React.ReactElement | null {
    if (props.subject.kind === 'block') {
        const block = findWorkflowBlock(props.draft, props.subject.blockId);
        // A subject that no longer resolves renders nothing and the host closes its presentation.
        if (block === null) return null;
        // Keyed by block so a pushed page (Result, Only run when) never carries over to another block.
        return <WorkflowBlockOptions key={block.id} {...props} block={block} />;
    }
    return <WorkflowSettingsContent {...props} />;
}

/** Workflow subject: the Workflow settings groups, each a summary until it needs to be open. */
function WorkflowSettingsContent(props: WorkflowInspectorProps): React.ReactElement {
    const { draft, onChange, testIDPrefix } = props;
    const readOnly = props.documentEditable === false;
    const defaultAuthoringValues = React.useMemo(() => resolveWorkflowStepSelectionV1({ defaults: draft.defaults, purpose: 'authoring' }).selection, [draft.defaults]);
    const executionTarget = props.executionTarget ?? 'session';
    const issues = props.validation?.issues ?? [];
    const disclosure = props.groupDisclosure ?? NO_DISCLOSURE;
    const groupProps = { disclosure, ...(props.onChangeGroupDisclosure === undefined ? {} : { onChangeDisclosure: props.onChangeGroupDisclosure }) };

    const runsInLabel = executionTarget === 'detached_run'
        ? t('workflows.page.sections.aBackgroundRun')
        : t('workflows.page.sections.aSession');
    const machineHomeDir = props.projectMachines?.find((machine) => machine.id === props.projectTarget?.machineId)
        ?.metadata?.homeDir ?? null;
    const whereSummary = formatWorkflowWhereSummary({
        target: props.projectTarget,
        machineName: props.machineName,
        machineHomeDir,
    }) ?? t('workflows.page.inspector.whereMissing');

    const agentSummary = useSessionAuthoringFieldSummary({
        fields: AGENT_SUMMARY_FIELDS,
        values: defaultAuthoringValues,
        ...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts }),
    });
    const agentValueSet = WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS.some((field) => Object.hasOwn(draft.defaults, field));

    const finalOutputLabel = React.useMemo(() => {
        const finalOutput = draft.finalOutput;
        if (finalOutput === undefined) return t('workflows.finalOutput.none');
        const option = listWorkflowFinalOutputOptions(draft).find((candidate) => candidate.blockId === finalOutput.producer.blockId);
        const block = option === undefined ? findWorkflowBlock(draft, finalOutput.producer.blockId) : null;
        const label = option?.label ?? (block === null ? finalOutput.producer.blockId : workflowBlockReferenceLabel(block));
        return t('workflows.page.inspector.finalOutput', { output: label });
    }, [draft]);
    const inputsLabel = draft.inputs.length === 0
        ? t('workflows.page.inspector.none')
        : t('workflows.page.inspector.inputCount', { count: draft.inputs.length });

    return (
        <>
            {props.runsAutomatically ?? null}
            <WorkflowInspectorGroup
                {...groupProps}
                groupId="where"
                title={t('workflows.page.sections.whereTitle')}
                summary={props.runAsTargets === undefined ? whereSummary : `${whereSummary} · ${runsInLabel}`}
                // The machine is required: while it is missing the group stays open
                // (its placeholder says so; no error text before the person acts).
                attention={props.projectTarget === null || props.projectTarget === undefined}
                valueSet
                testID={`${testIDPrefix}-group-where`}
            >
                {/* One row, one field select (lab E1 "Machine and project"); the Where owner draws it. */}
                <View testID={`${testIDPrefix}-where-field`}>
                    <WorkflowProjectTargetControl
                        presentation="field"
                        title={t('workflows.page.sections.machineAndProject')}
                        target={props.projectTarget}
                        machineName={props.machineName}
                        {...(props.projectMachines === undefined ? {} : { machines: props.projectMachines })}
                        {...(readOnly || props.onChangeProjectTarget === undefined ? {} : { onChange: props.onChangeProjectTarget })}
                        testIDPrefix={testIDPrefix}
                    />
                </View>
                {props.runAsTargets === undefined || props.onChangeExecutionTarget === undefined ? null : (
                    <SegmentedChoiceItem<WorkflowRunAsTargetKind>
                        disabled={readOnly}
                        testIDPrefix={`${testIDPrefix}-run-as`}
                        title={t('workflows.page.sections.eachStepRunsIn')}
                        // The consequence wraps; it is never cut to an ellipsis.
                        subtitleLines={0}
                        subtitle={executionTarget === 'detached_run'
                            ? t('workflows.page.sections.eachStepBackground')
                            : t('workflows.page.sections.eachStepSession')}
                        value={executionTarget}
                        onChange={(next) => props.onChangeExecutionTarget?.(next)}
                        options={props.runAsTargets.map((target) => ({
                            id: target.kind,
                            label: target.kind === 'detached_run'
                                ? t('workflows.page.sections.aBackgroundRun')
                                : t('workflows.page.sections.aSession'),
                            // An unavailable class stays visible with its reason; never downgraded.
                            ...(target.available
                                ? {}
                                : { unavailableReason: t(`workflows.page.unavailable.${target.unavailableReason}`) }),
                        }))}
                    />
                )}
            </WorkflowInspectorGroup>

            <WorkflowInspectorGroup
                {...groupProps}
                groupId="agent"
                title={t('workflows.page.sections.agentTitle')}
                summary={agentSummary.join(' · ')}
                attention={issuesUnder(issues, WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS.map((field) => `/defaults/${field}`))}
                valueSet={agentValueSet}
                testID={`${testIDPrefix}-group-agent`}
            >
                <SectionContentRow testID={`${testIDPrefix}-agent-description-row`}>
                    <Text style={workflowEditorStyles.metaText}>{t('workflows.page.sections.agentDescription')}</Text>
                </SectionContentRow>
                <SessionAuthoringControls
                    disabled={readOnly}
                    presentation="fields"
                    fields={WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS}
                    values={defaultAuthoringValues} engine={draft.defaults.engine}
                    onChangeEngine={(engine) => { if (!readOnly) onChange({ ...draft, defaults: withWorkflowAuthoringEngine(draft.defaults, engine) }); }}
                    onChangeFields={(fields) => {
                        if (readOnly) return;
                        let next = { ...draft, defaults: withWorkflowAuthoringEngineFields(draft.defaults, fields) };
                        const retired = retireUnavailableSessionAuthoringRuntimeDescriptor({
                            runtimeDescriptorV1: draft.defaults.runtimeDescriptorV1,
                            agentTarget: fields.agentTarget ?? draft.defaults.agentTarget, facts: props.authoringFacts,
                        });
                        if (retired !== draft.defaults.runtimeDescriptorV1) next = setWorkflowDefaultField(next, 'runtimeDescriptorV1', retired);
                        onChange(next);
                    }}
                    onChangeField={(field, value) => {
                        if (readOnly) return;
                        let next = setWorkflowDefaultField(draft, field, value);
                        if (field === 'agentTarget') {
                            const retired = retireUnavailableSessionAuthoringRuntimeDescriptor({
                                runtimeDescriptorV1: draft.defaults.runtimeDescriptorV1,
                                agentTarget: readSessionAuthoringAgentTargetValue(value),
                                facts: props.authoringFacts,
                            });
                            if (retired !== draft.defaults.runtimeDescriptorV1) {
                                next = setWorkflowDefaultField(next, 'runtimeDescriptorV1', retired);
                            }
                        }
                        onChange(next);
                    }}
                    {...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts })}
                    testIDPrefix={`${testIDPrefix}-defaults`}
                />
            </WorkflowInspectorGroup>

            <WorkflowInspectorGroup {...groupProps} groupId="roles"
                title={t('workflows.page.sections.rolesTitle')}
                summary={(draft.roles?.map((role) => 'name' in role ? role.name : role.roleId).join(' · ')) || t('workflows.page.inspector.none')}
                attention={issuesUnder(issues, ['/roles'])} valueSet={(draft.roles?.length ?? 0) > 0}
                testID={`${testIDPrefix}-group-roles`}>
                <WorkflowRolesEditor draft={draft} onChange={onChange} prefix={testIDPrefix} editable={!readOnly} />
            </WorkflowInspectorGroup>

            <WorkflowInspectorGroup
                {...groupProps}
                groupId="conversation"
                title={t('workflows.page.sections.conversationTitle')}
                summary={formatWorkflowContinuitySummary({
                    draft,
                    conversation: draft.defaults.conversation,
                    workspace: draft.defaults.workspace,
                    ...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions }),
                })}
                attention={issuesUnder(issues, ['/defaults/conversation', '/defaults/workspace'])}
                valueSet={draft.defaults.conversation !== undefined || draft.defaults.workspace !== undefined}
                testID={`${testIDPrefix}-group-conversation`}
            >
                <SectionContentRow testID={`${testIDPrefix}-defaults-continuity-row`}>
                    {readOnly ? <Text style={workflowEditorStyles.metaText}>{formatWorkflowContinuitySummary({
                        draft, conversation: draft.defaults.conversation, workspace: draft.defaults.workspace,
                        existingSessions: props.existingSessions,
                    })}</Text> : <WorkflowContinuityControls
                        draft={draft}
                        conversation={draft.defaults.conversation}
                        workspace={draft.defaults.workspace}
                        {...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions })}
                        onChangeConversation={(value) => onChange(setWorkflowDefaultField(draft, 'conversation', value))}
                        {...(props.bindExistingSession === undefined ? {} : {
                            onBindExistingSession: (sessionId: string) => props.bindExistingSession!(null, sessionId),
                        })}
                        onChangeWorkspace={(value) => onChange(setWorkflowDefaultField(draft, 'workspace', value))}
                        testIDPrefix={`${testIDPrefix}-defaults-continuity`}
                    />}
                </SectionContentRow>
            </WorkflowInspectorGroup>

            <WorkflowInspectorGroup
                {...groupProps}
                groupId="inputs"
                title={t('workflows.page.sections.inputsTitle')}
                summary={`${inputsLabel} · ${finalOutputLabel}`}
                attention={issuesUnder(issues, ['/inputs', '/finalOutput'])}
                valueSet={draft.inputs.length > 0 || draft.finalOutput !== undefined}
                testID={`${testIDPrefix}-group-inputs`}
            >
                <SectionContentRow testID={`${testIDPrefix}-inputs-row`}>
                    {readOnly ? draft.inputs.map(input => <Text key={input.name} style={workflowEditorStyles.metaText}>
                        {input.description ?? input.name}
                    </Text>) : <WorkflowInputsEditor
                        inputs={draft.inputs}
                        onChange={(inputs) => onChange(setWorkflowInputs(draft, inputs))}
                        testIDPrefix={testIDPrefix}
                    />}
                </SectionContentRow>
                <SectionContentRow testID={`${testIDPrefix}-final-output-row`}>
                    {readOnly ? <Text style={workflowEditorStyles.metaText}>{finalOutputLabel}</Text> : <WorkflowFinalOutputEditor
                        draft={draft}
                        onChange={(finalOutput) => onChange(setWorkflowFinalOutput(draft, finalOutput))}
                        testIDPrefix={testIDPrefix}
                    />}
                </SectionContentRow>
            </WorkflowInspectorGroup>
        </>
    );
}
