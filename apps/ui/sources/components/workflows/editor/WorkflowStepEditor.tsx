import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { computeExistingSessionComposerInputMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import { resolveSessionAuthoringAgentId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useSessionAuthoringEngineSummary } from '@/components/sessions/authoring/controls/SessionAuthoringControls';

import { Text } from '@/components/ui/text/Text';
import {
    ScopedAuthoringComposer,
    type AuthoringComposerScope,
    type ScopedAuthoringComposerHandle,
    type ScopedAuthoringDocument,
} from '@/components/sessions/authoring/ScopedAuthoringComposer';
import type {
    AuthoringComposerCustodyEntry,
    WorkflowAuthoringComposerCustody,
} from '@/components/sessions/authoring/authoringComposerCustody';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { t } from '@/text';

import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { resolveRoleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { WorkflowStep, WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { readWorkflowEngineChoiceV1, type WorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { useSessionAuthoringEnginePicker } from '@/components/sessions/authoring/controls/useSessionAuthoringEnginePicker';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

import {
    listWorkflowStepOverriddenFields,
    resolveEffectiveWorkflowStepExecution,
    type WorkflowDraftValidation,
    workflowIssuesForBlock,
} from '@/sync/domains/workflows/workflowAuthoring';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { WorkflowKindCard } from './WorkflowKindCard';
import { useWorkflowInsertChip } from './workflowInsertChip';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowStepDataEditor } from './WorkflowStepDataEditor';
import { formatWorkflowIssueText } from './workflowIssueText';
import { useWorkflowStepOptionsChip } from './WorkflowStepOptionsChip';
import { useWorkflowStepOptionsSummary } from './useWorkflowStepOptionsSummary';
import { WorkflowStepSessionDropZone, type WorkflowSessionDrop } from './WorkflowStepSessionDropZone';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import { createWorkflowPromptSuggestions, resolveWorkflowPromptReferenceStates } from './workflowPromptSuggestions';

/**
 * One repeatable authored step (07 S7, 04 §4.3): a stable ordinal, a prompt-derived label,
 * the prompt in the real composer with the step's **Step options** chip in its chip row,
 * and the values it gets without naming them, trailing the prompt.
 *
 * The prompt is the visual centre. Inherited configuration reads as one quiet chip
 * ("Workflow defaults") rather than repeating chrome on every step; a step that changes
 * something names it on that bordered chip, which opens the same controlled values.
 */

/** The step's engine group as its composer chip shows it: who runs it, on which model. */

type WorkflowStepPromptFieldProps = Readonly<{
    custody: AuthoringComposerCustodyEntry;
    /** Where this document's references, files and attachments are addressed from. */
    composerScope: AuthoringComposerScope;
    testID: string;
    document: WorkflowStep['document'];
    additionalSuggestions: React.ComponentProps<typeof ScopedAuthoringComposer>['additionalSuggestions'];
    referenceStates?: React.ComponentProps<typeof ScopedAuthoringComposer>['referenceStates'];
    accessibilityLabel: string;
    editable: boolean;
    onChangeDocument: (document: ScopedAuthoringDocument) => void;
    onCommitDocument?: () => void;
    onFocusPrompt: () => void;
    /** The step's own chips in the composer's chip row (Step options). */
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    agentInputContext?: React.ComponentProps<typeof ScopedAuthoringComposer>['agentInputContext'];
    /** `false` shows the prompt's static picture until the author activates it (the host's editing demand). */
    editing: boolean;
    onRequestEdit?: () => void;
}>;

/**
 * The prompt field, isolated at the row boundary.
 *
 * Every keystroke necessarily produces a new whole draft, so the recursive list
 * and each step's chrome re-render — that is cheap. The composer is not: it
 * mounts the text engine, dictation binding and presentation registration.
 * Isolating it here means typing in one step executes exactly one composer,
 * which is what the 100-step target actually requires. Its props are the row's
 * own facts and stable handlers, so an unrelated draft change cannot invalidate
 * it.
 *
 * There is exactly one composer here, not a reduced one for neutral workflows.
 * A step authored without a captured Session still runs on an exact Machine and
 * project folder, and that scope is all the canonical composer owners need to
 * offer the same mentions, references and plugin attachments a Session-origin
 * step gets.
 */
const WorkflowStepPromptField = React.memo(React.forwardRef<
    ScopedAuthoringComposerHandle,
    WorkflowStepPromptFieldProps
>(function WorkflowStepPromptField(props, ref): React.ReactElement {
    // A long prompt is clipped like a Session's: the same collapsed and expanded heights and the
    // composer's own expand toggle, so it never drowns the document (owner 2026-11-06).
    const viewportHeight = useWindowDimensions().height;
    const [expanded, setExpanded] = React.useState(false);
    const collapsedMaxHeight = computeExistingSessionComposerInputMaxHeight({ viewportHeight, expanded: false });
    const expandedMaxHeight = computeExistingSessionComposerInputMaxHeight({ viewportHeight, expanded: true });
    const inputExpansion = React.useMemo(() => ({
        expanded,
        ...(collapsedMaxHeight === undefined ? {} : { collapsedMaxHeight }),
        onToggle: () => setExpanded((current) => !current),
    }), [expanded, collapsedMaxHeight]);
    const inputMaxHeight = expanded ? expandedMaxHeight : collapsedMaxHeight;
    return (
        // The canonical composer owns its own field chrome, so this wrapper only
        // carries the row's stable test identity. The step-named label goes to
        // the composer's real text input, which is what assistive technology
        // focuses; a label on this view would never be read.
        <View testID={props.testID}>
            <ScopedAuthoringComposer
                inputAccessibilityLabel={props.accessibilityLabel}
                // The step's card is the edge (owner 2026-11-15: one card anatomy, no grey composer fill).
                panelPresentation="embedded"
                // A step card is narrower than its window: its chips wrap rather than clip on a rail (M5).
                hostActionBarLayout="wrap"
                inputExpansion={inputExpansion}
                {...(inputMaxHeight === undefined ? {} : { inputMaxHeight })}
                ref={ref}
                custody={props.custody}
                scope={props.composerScope}
                document={props.document}
                additionalSuggestions={props.additionalSuggestions}
                referenceStates={props.referenceStates}
                onChangeDocument={props.editable ? props.onChangeDocument : undefined}
                onBlur={props.editable ? props.onCommitDocument : undefined}
                attachmentsEnabled
                placeholder={t('workflows.editor.promptPlaceholder')}
                editable={props.editable}
                voiceAffordance="dictation"
                onFocus={props.onFocusPrompt}
                agentInputContext={props.agentInputContext}
                {...(props.extraActionChips === undefined ? {} : { extraActionChips: props.extraActionChips })}
                editing={props.editing}
                {...(props.onRequestEdit === undefined ? {} : { onRequestEdit: props.onRequestEdit })}
            />
        </View>
    );
}));

export function WorkflowStepEditor(props: Readonly<{
    step: WorkflowStep;
    draft: WorkflowEditorDraft;
    ordinal: number;
    /** The block's visible number (`workflowBlockOrdinalV1`); `null` for a container. */
    visibleOrdinal?: string | null;
    /** Whether this step is the selected block: its ordinal fills. */
    selected?: boolean;
    nameEditor?: WorkflowBlockNameEditor;
    total: number;
    /** Where this step's references, files and attachments are addressed from. */
    composerScope: AuthoringComposerScope;
    /**
     * The host's custody of every step document in this draft.
     *
     * Placement is recursive, so a move re-parents this row and React remounts
     * it. The live document, its exact mention ranges, staged attachment bytes
     * and caret therefore belong to the host, keyed by the block, not to a
     * mount-lifetime identity minted here.
     */
    composerCustody: WorkflowAuthoringComposerCustody;
    validation: WorkflowDraftValidation;
    actions: readonly WorkflowBlockAction[];
    onSelect: () => void;
    onChangeDocument: (document: WorkflowStep['document']) => void;
    onCommitDocument?: () => void;
    /** Opens Step options, anchored beside this step's Customize control. */
    onCustomize: (anchorRef: React.RefObject<View | null>) => void;
    onChangeInput: (input: readonly WorkflowValueReference[]) => void;
    onRemoveInput?: (index: number) => void;
    /**
     * Writes one of the step's own engine fields through the draft owner; `undefined` deletes it
     * so the step inherits the workflow default again (04 §5.2).
     */
    onChangeExecutionField?: <TField extends keyof WorkflowStepExecutionSelection>(
        field: TField,
        value: WorkflowStepExecutionSelection[TField] | undefined,
    ) => void;
    onChangeExecutionFields?: (fields: Partial<WorkflowStepExecutionSelection>) => void;
    onChangeEngine?: (engine: WorkflowEngineChoiceV1) => void;
    /** The host's Agent and model catalogs for the in-composer engine chip. */
    authoringFacts?: SessionAuthoringControlFacts;
    /** Registers the prompt input so Add can focus it once layout is ready. */
    registerPromptRef?: (blockId: string, focus: (() => void) | null) => void;
    /**
     * Whether this prompt is the one being edited. `false` shows its static picture; focusing the
     * prompt (Add, Edit step, the keyboard, a press) asks the host through `onRequestEdit`.
     */
    editing?: boolean;
    onRequestEdit?: () => void;
    /** `false`: the reading presentation (04 §4.11) — nothing here edits. */
    editable?: boolean;
    /** A reader's per-step facts, each in its fixed place (04 §4.11). */
    slots?: WorkflowDocumentStepSlots | null;
    /** The web Session drop target's resolver and binder; absent where no drag source exists. */
    sessionDrop?: WorkflowSessionDrop;
    /** `false` keeps this step's issue text silent until a refused Run/Save reveals it. */
    revealIssues?: boolean;
    testIDPrefix: string;
}>): React.ReactElement {
    const {
        step, ordinal, total, validation, actions,
        onSelect, onChangeDocument, onCustomize, registerPromptRef, testIDPrefix,
    } = props;

    const editable = props.editable !== false;
    const inputRef = React.useRef<ScopedAuthoringComposerHandle>(null);
    const custody = props.composerCustody.entryFor(step.id);
    // The prompt's handlers close over the current document through a ref, so
    // they stay referentially stable while the whole draft changes underneath.
    const latestRef = React.useRef({ step, draft: props.draft, onChangeInput: props.onChangeInput, onChangeDocument, onSelect, onRequestEdit: props.onRequestEdit });
    latestRef.current = { step, draft: props.draft, onChangeInput: props.onChangeInput, onChangeDocument, onSelect, onRequestEdit: props.onRequestEdit };
    const additionalSuggestions = React.useCallback((query: string) => createWorkflowPromptSuggestions({
        draft: latestRef.current.draft,
        step: latestRef.current.step,
        query,
        onChangeInput: latestRef.current.onChangeInput,
    }), []);
    // The composer publishes its portable document through the protocol's
    // read-only projection of the same values the saved definition owns, so the
    // authored document is rebuilt here through the canonical value schema.
    const handleChangeDocument = React.useCallback((document: ScopedAuthoringDocument) => {
        latestRef.current.onChangeDocument({
            text: document.text,
            references: [...document.references],
            attachments: document.attachments.map((attachment) => ({
                ...attachment,
                value: PluginJsonValueV2Schema.parse(attachment.value),
            })),
        });
    }, []);
    const handleFocusPrompt = React.useCallback(() => {
        latestRef.current.onSelect();
    }, []);
    const handleRequestEdit = React.useCallback(() => latestRef.current.onRequestEdit?.(), []);

    React.useEffect(() => {
        registerPromptRef?.(step.id, () => inputRef.current?.focus());
        return () => registerPromptRef?.(step.id, null);
    }, [registerPromptRef, step.id]);

    const latestCustomizeRef = React.useRef(onCustomize);
    latestCustomizeRef.current = onCustomize;
    const optionsSummary = useWorkflowStepOptionsSummary(props.draft, step);
    const stepOptionsChip = useWorkflowStepOptionsChip({
        label: optionsSummary.label,
        changed: optionsSummary.changed,
        onOpen: (anchorRef) => latestCustomizeRef.current(anchorRef),
        testID: `${testIDPrefix}-step-${step.id}-customize`,
        labelTestID: `${testIDPrefix}-step-${step.id}-inheritance`,
    });
    // The engine chip (agent or role · model) leads the composer's chip row, quiet while the step
    // inherits and bordered once the step sets its own (04 §4.3). It is keyed on the step's own
    // engine facts, not the whole draft, so typing elsewhere never re-renders this composer.
    const effective = resolveEffectiveWorkflowStepExecution(props.draft, step);
    const agentId = resolveSessionAuthoringAgentId({ agentTarget: effective.agentTarget, facts: props.authoringFacts });
    // A participant a Run supplies for this step owns its Session and launch: the chip names it and offers no Agent choice.
    const participant = step.execution?.participant;
    const engineChoice = React.useMemo(() => readWorkflowEngineChoiceV1(props.draft.defaults, step.execution),
        [props.draft.defaults, step.execution]);
    const roleId = engineChoice && 'roleId' in engineChoice ? engineChoice.roleId : null;
    const engine = participant ?? engineChoice;
    const engineChangeRef = React.useRef({ fields: props.onChangeExecutionFields, engine: props.onChangeEngine });
    engineChangeRef.current = { fields: props.onChangeExecutionFields, engine: props.onChangeEngine };
    const changeEngineFields = React.useCallback((fields: Partial<WorkflowStepExecutionSelection>) => engineChangeRef.current.fields?.(fields), []);
    const roleSelection = React.useMemo(() => ({
        value: roleId,
        workflowRoles: props.draft.roles,
        onChange: (nextRoleId: string) => { if (editable) engineChangeRef.current.engine?.({ roleId: nextRoleId }); },
    }), [editable, roleId, props.draft.roles]);
    const enginePicker = useSessionAuthoringEnginePicker({ values: effective, facts: props.authoringFacts,
        disabled: !editable, onChangeFields: changeEngineFields, roleSelection });
    // The composer's Agent picker reads this Machine's readiness while it is open, through the shared owner.
    const [enginePickerOpen, setEnginePickerOpen] = React.useState(false);
    const engineSummary = useSessionAuthoringEngineSummary({ values: effective, engine,
        workflowRoles: props.draft.roles, facts: props.authoringFacts });
    const permissionMode = isPermissionMode(effective.permissionMode) ? effective.permissionMode : undefined;
    // A role reads by its name (a built-in's or this workflow's own), through the one role resolver.
    const roleName = React.useMemo(() => (roleId ? resolveRoleDisplayName(roleId, props.draft.roles) : null),
        [roleId, props.draft.roles]);
    const agentInputContext = React.useMemo(() => ({
        agentType: enginePicker.agentId ?? agentId ?? undefined,
        agentLabel: roleName ?? enginePicker.label,
        engineLabel: engineSummary,
        modelMode: effective.modelSelection?.ref.modelId,
        permissionMode,
        showStatusPermissionMode: false,
        agentPickerOptions: editable && participant === undefined ? enginePicker.options : [],
        agentPickerSelectedOptionId: enginePicker.selectedOptionId,
        onAgentPickerSelect: enginePicker.onSelect,
        // The native AgentInput owns opening its options. This presence also keeps
        // the effective engine chip visible in a read-only document.
        onAgentClick: enginePicker.onAgentClick,
        onAgentPickerVisibilityChange: setEnginePickerOpen,
        ...(!editable ? props.slots?.enginePresentation : undefined),
    }), [agentId, effective.modelSelection, permissionMode, enginePicker.agentId,
        editable, participant, roleName, engineSummary, enginePicker.label, enginePicker.onAgentClick, enginePicker.onSelect, enginePicker.options, enginePicker.selectedOptionId, props.slots?.enginePresentation]);
    // Insert leads the row (owner 2026-11-15): the visible way into the '@' value list.
    const insertChip = useWorkflowInsertChip({
        onInsert: () => inputRef.current?.control('insertMention'),
        testID: `${testIDPrefix}-step-${step.id}-insert`,
    });
    const composerChips = React.useMemo(() => (editable ? [insertChip, stepOptionsChip] : [stepOptionsChip]),
        [editable, insertChip, stepOptionsChip]);
    const promptFrameRef = React.useRef<View>(null);
    const issues = workflowIssuesForBlock(validation, step.id, props.draft);
    const referenceStates = resolveWorkflowPromptReferenceStates(step, issues);
    const displayName = workflowBlockReferenceLabel(step);
    const accessibilityLabel = t('workflows.a11y.stepContext', {
        block: displayName,
        position: ordinal,
        total,
    });

    return (
        <View
            testID={`${testIDPrefix}-step-${step.id}`}
            style={workflowEditorStyles.blockBody}
        >
            <WorkflowBlockHeading
                nameEditor={props.nameEditor}
                ordinal={ordinal}
                selected={props.selected}
                unnamed={resolveWorkflowUnnamedHeading(step)}
                visibleOrdinal={props.visibleOrdinal ?? null}
                displayName={displayName}
                accessibilityLabel={accessibilityLabel}
                issue={issues[0] === undefined ? null : formatWorkflowIssueText(issues[0], props.draft)}
                actions={editable ? actions : []}
                accessory={props.slots?.state}
                onSelect={onSelect}
                testID={`${testIDPrefix}-step-${step.id}-label`}
                actionsTestID={`${testIDPrefix}-step-${step.id}-actions`}
            />
            {props.slots?.occurrenceSelector ?? null}

            {/* A Session carried onto the step binds its conversation. The
                zone always wraps the prompt so enabling it never remounts the composer. */}
            {/* The card places itself on the grid (`blockCard`), as an Action's does. */}
            <View>
            <WorkflowStepSessionDropZone
                stepId={step.id}
                label={displayName}
                {...(props.sessionDrop === undefined ? {} : { sessionDrop: props.sessionDrop })}
                testID={`${testIDPrefix}-step-${step.id}-session-drop`}
            >
                {/* The editor's one card (owner 2026-11-15): the prompt inside it, its chip row (Agent, Step
                    options) at the card's foot; at rest the same card names what runs it (WorkflowBlockSummary). */}
                <WorkflowKindCard testID={`${testIDPrefix}-step-${step.id}-card`} title={displayName} header={false}>
                <View ref={promptFrameRef} collapsable={false} style={workflowEditorStyles.promptFrame}>
                    <WorkflowStepPromptField
                        ref={inputRef}
                        custody={custody}
                        composerScope={props.composerScope}
                        testID={`${testIDPrefix}-step-${step.id}-prompt`}
                        document={step.document}
                        additionalSuggestions={additionalSuggestions}
                        referenceStates={referenceStates}
                        accessibilityLabel={accessibilityLabel}
                        editable={editable}
                        onChangeDocument={handleChangeDocument}
                        onCommitDocument={props.onCommitDocument}
                        onFocusPrompt={handleFocusPrompt}
                        agentInputContext={agentInputContext}
                        {...(composerChips === undefined ? {} : { extraActionChips: composerChips })}
                        editing={props.editing !== false}
                        {...(props.onRequestEdit === undefined ? {} : { onRequestEdit: handleRequestEdit })}
                    />
                </View>
                </WorkflowKindCard>
            </WorkflowStepSessionDropZone>
            </View>
            {enginePickerOpen ? enginePicker.readinessDemand : null}

            {props.slots?.reviewedCard ?? null}

            {!editable && props.slots?.engineChip ? (
                <View style={workflowEditorStyles.metaRow}>
                    {props.slots.engineChip}
                </View>
            ) : null}

            {/* A supplied footer fact shares the trailing values' line: a reader's "Open conversation" (run-A_steps), and an
                editable document's Test Run output, duration and Open details. */}
            <WorkflowStepDataEditor
                draft={props.draft}
                step={step}
                editable={editable}
                editing={props.selected === true}
                onEdit={onSelect}
                {...(props.slots?.footer ? { footerAccessory: props.slots.footer } : {})}
                onChangeInput={props.onChangeInput}
                onRemoveInput={props.onRemoveInput}
                testIDPrefix={testIDPrefix}
            />

            {!editable || props.revealIssues === false || issues.length === 0 ? null : (
                <View style={workflowEditorStyles.stepIssues}>
                    {issues.map((issue) => (
                        <Text
                            key={`${issue.code}:${issue.path}`}
                            testID={`${testIDPrefix}-step-${step.id}-issue`}
                            style={workflowEditorStyles.issueText}
                        >
                            {formatWorkflowIssueText(issue, props.draft)}
                        </Text>
                    ))}
                </View>
            )}
        </View>
    );
}
