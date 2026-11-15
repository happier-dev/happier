import * as React from 'react';
import { View } from 'react-native';

import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import {
    readSessionAuthoringAgentTargetValue,
    resolveSessionAuthoringFieldTitle,
    retireUnavailableSessionAuthoringRuntimeDescriptor,
    type SessionAuthoringControlFacts,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    applyWorkflowDefinitionEditsV1,
    findWorkflowBlock,
    setWorkflowDefaultField,
    setWorkflowFinalOutput,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
    listWorkflowFinalOutputOptions,
    type WorkflowDraftValidation,
    type WorkflowExistingSessionOption,
} from '@/sync/domains/workflows/workflowAuthoring';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

import type { WorkflowRunAsTarget, WorkflowRunAsTargetKind } from '../run/workflowRunAsTargets';
import { formatWorkflowContinuitySummary, useWorkflowContinuedSessionLabel, WorkflowContinuityControls } from './WorkflowContinuityControls';
import { WorkflowFinalOutputEditor } from './WorkflowFinalOutputEditor';
import { WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE } from './WorkflowStepInspector';
import { WorkflowRolesEditor } from './WorkflowRolesEditor';
import { WorkflowBlockOptions, WorkflowSettingsFrame } from './WorkflowBlockOptions';
import { issuesUnder, NO_DISCLOSURE, WorkflowInspectorGroup } from './workflowInspectorGroup';
import { workflowEditorStyles } from './workflowEditorStyles';
import type { WorkflowSessionDrop } from './useWorkflowSessionBinding';
import { withWorkflowAuthoringEngine, withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import { readWorkflowEngineChoiceV1, resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { WorkflowRecentRuns } from './WorkflowRecentRuns';

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
    /** Saved source only; an unsaved draft has no run history. */
    workflowDefinitionId?: string;
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
    sessionOptionsStatus?: React.ComponentProps<typeof WorkflowContinuityControls>['sessionOptionsStatus'];
    onRetrySessionOptions?: () => void;
    onSessionOptionsDemandChange?: (demanded: boolean) => void;
    bindExistingSession?: WorkflowSessionDrop['bind'];
    /** "Each step runs in": a step's Runs in reads the workflow's default from here. */
    executionTarget?: WorkflowRunAsTargetKind;
    runAsTargets?: readonly WorkflowRunAsTarget[];
    /** The workflow's description (Artifact metadata the host owns); absent change handler: read-only. */
    description?: string;
    onChangeDescription?: (next: string) => void;
    testIDPrefix: string;
}>;


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

/**
 * Workflow subject: Workflow settings, the workflow scope of the one settings popover (owner
 * 2026-11-15). Where, what each step runs in, what a run asks for and when it runs are the page's
 * first cards; these are the rest — every Session field a step inherits (the same New Session chip
 * owners a step's Agent page uses), roles, conversation and workspace, the result and the
 * description — each group a summary until it needs to be open.
 */
function WorkflowSettingsContent(props: WorkflowInspectorProps): React.ReactElement {
    const { draft, onChange, testIDPrefix } = props;
    const continuedSessionLabel = useWorkflowContinuedSessionLabel(draft.defaults.conversation);
    const readOnly = props.documentEditable === false;
    const defaultAuthoringValues = React.useMemo(() => resolveWorkflowStepSelectionV1({ defaults: draft.defaults, purpose: 'authoring' }).selection, [draft.defaults]);
    const issues = props.validation?.issues ?? [];
    const disclosure = props.groupDisclosure ?? NO_DISCLOSURE;
    const groupProps = { disclosure, ...(props.onChangeGroupDisclosure === undefined ? {} : { onChangeDisclosure: props.onChangeGroupDisclosure }) };

    // Closed, the group names what the workflow sets for every step; nothing set reads as the Agent's default.
    const setModelFields = WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE.filter((field) => Object.hasOwn(draft.defaults, field));
    const modelSummary = setModelFields.map((field) => resolveSessionAuthoringFieldTitle(field) ?? field).join(' · ') || t('common.default');

    const finalOutputLabel = React.useMemo(() => {
        const finalOutput = draft.finalOutput;
        if (finalOutput === undefined) return t('workflows.finalOutput.none');
        const option = listWorkflowFinalOutputOptions(draft).find((candidate) => candidate.blockId === finalOutput.producer.blockId);
        const block = option === undefined ? findWorkflowBlock(draft, finalOutput.producer.blockId) : null;
        const label = option?.label ?? (block === null ? finalOutput.producer.blockId : workflowBlockReferenceLabel(block));
        return t('workflows.page.inspector.finalOutput', { output: label });
    }, [draft]);

    const content = (
        <>
            <WorkflowInspectorGroup
                {...groupProps}
                groupId="conversation"
                title={t('workflows.page.sections.conversationTitle')}
                summary={formatWorkflowContinuitySummary({
                    draft,
                    conversation: draft.defaults.conversation,
                    sessionLabel: continuedSessionLabel,
                    workspace: draft.defaults.workspace,
                    ...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions }),
                })}
                attention={issuesUnder(issues, ['/defaults/conversation', '/defaults/workspace'])}
                valueSet={draft.defaults.conversation !== undefined || draft.defaults.workspace !== undefined}
                testID={`${testIDPrefix}-group-conversation`}
            >
                {/* Editing, the controls are page rows with their own inset; a content row around them would indent a second grid. */}
                <View testID={`${testIDPrefix}-defaults-continuity-row`}>{readOnly ? <SectionContentRow><Text style={workflowEditorStyles.metaText}>{formatWorkflowContinuitySummary({
                        draft, conversation: draft.defaults.conversation, workspace: draft.defaults.workspace,
                        sessionLabel: continuedSessionLabel,
                        existingSessions: props.existingSessions,
                    })}</Text></SectionContentRow> : <WorkflowContinuityControls
                        draft={draft}
                        conversation={draft.defaults.conversation}
                        workspace={draft.defaults.workspace}
                        {...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions })}
                        onSessionOptionsDemandChange={props.onSessionOptionsDemandChange}
                        sessionOptionsStatus={props.sessionOptionsStatus}
                        onRetrySessionOptions={props.onRetrySessionOptions}
                        onChangeConversation={(value) => onChange(setWorkflowDefaultField(draft, 'conversation', value))}
                        {...(props.bindExistingSession === undefined ? {} : {
                            onBindExistingSession: (sessionId: string) => props.bindExistingSession!(null, sessionId),
                        })}
                        onChangeWorkspace={(value) => onChange(setWorkflowDefaultField(draft, 'workspace', value))}
                        testIDPrefix={`${testIDPrefix}-defaults-continuity`}
                    />}</View>
            </WorkflowInspectorGroup>

            <WorkflowInspectorGroup
                {...groupProps}
                groupId="agent"
                title={t('workflows.page.sections.modelAndPermissionsTitle')}
                summary={modelSummary}
                description={t('workflows.page.sections.agentDescription')}
                attention={issuesUnder(issues, WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE.map((field) => `/defaults/${field}`))}
                valueSet={setModelFields.length > 0}
                testID={`${testIDPrefix}-group-agent`}
            >
                <SessionAuthoringControls
                    disabled={readOnly}
                    presentation="fields"
                    engineFieldTitle={null}
                    // Every field a step inherits beside its Agent (the Agent is on the "How and where it runs" card),
                    // the same list a step's settings show: one field list, never a workflow subset.
                    fields={WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE}
                    values={defaultAuthoringValues} engine={readWorkflowEngineChoiceV1(draft.defaults)} workflowRoles={draft.roles}
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
                <WorkflowRolesEditor draft={draft} onEdit={(ops) => {
                    if (readOnly) return;
                    const result = applyWorkflowDefinitionEditsV1(draft, ops);
                    if (result.ok) onChange(result.draft);
                }} prefix={testIDPrefix} editable={!readOnly} />
            </WorkflowInspectorGroup>

            <WorkflowInspectorGroup
                {...groupProps}
                groupId="result"
                title={t('workflows.page.inspector.resultTitle')}
                summary={finalOutputLabel}
                attention={issuesUnder(issues, ['/finalOutput'])}
                valueSet={draft.finalOutput !== undefined}
                testID={`${testIDPrefix}-group-result`}
            >
                {readOnly ? (
                    <SectionContentRow testID={`${testIDPrefix}-final-output-row`}>
                        <Text style={workflowEditorStyles.metaText}>{finalOutputLabel}</Text>
                    </SectionContentRow>
                ) : (
                    <View testID={`${testIDPrefix}-final-output-row`}>
                        <WorkflowFinalOutputEditor
                            draft={draft}
                            onChange={(finalOutput) => onChange(setWorkflowFinalOutput(draft, finalOutput))}
                            testIDPrefix={testIDPrefix}
                        />
                    </View>
                )}
            </WorkflowInspectorGroup>

            {props.description === undefined && props.onChangeDescription === undefined ? null : (
                <ItemGroup title={t('workflows.page.descriptionLabel')}>
                    <SectionContentRow testID={`${testIDPrefix}-description-row`}>
                        <FieldTextInput
                            value={props.description ?? ''}
                            multiline
                            editable={!readOnly && props.onChangeDescription !== undefined}
                            placeholder={t('workflows.page.descriptionPlaceholder')}
                            accessibilityLabel={t('workflows.page.descriptionLabel')}
                            onChangeText={(next) => props.onChangeDescription?.(next)}
                            testID={`${testIDPrefix}-description`}
                        />
                    </SectionContentRow>
                </ItemGroup>
            )}
            {props.workflowDefinitionId === undefined ? null : <WorkflowRecentRuns
                definitionId={props.workflowDefinitionId} workflowName={draft.name}
                {...groupProps} testIDPrefix={testIDPrefix} />}
        </>
    );
    if (props.presentation !== 'popover') return content;
    return (
        <WorkflowSettingsFrame
            title={t('workflows.page.settings')}
            location={t('workflows.page.settingsSubtitle')}
            {...(props.onDone === undefined ? {} : { onDone: props.onDone })}
            pageKey="workflow"
            testIDPrefix={testIDPrefix}
        >
            {content}
        </WorkflowSettingsFrame>
    );
}
