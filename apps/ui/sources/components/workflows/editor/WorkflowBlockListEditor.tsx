import * as React from 'react';
import type { WorkflowStarterExampleSelection } from '@happier-dev/protocol/workflows/builtins/examples';
import { Platform, View } from 'react-native';

import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import type { WorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type {
    WorkflowBlock,
    WorkflowRepetition,
    WorkflowStep,
} from '@happier-dev/protocol/workflows/workflowV1';

import { workflowIssuesForBlock, type WorkflowDraftValidation } from '@/sync/domains/workflows/workflowAuthoring';
import { collectWorkflowFieldIssueTexts, formatWorkflowIssueText } from './workflowIssueText';
import { withWorkflowAuthoringEngine, withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import {
    collectWorkflowBlockIds,
    createWorkflowParallelBranch,
    moveWorkflowBlock,
    removeWorkflowBlock,
    setWorkflowStepExecutionField,
    setWorkflowBlockName,
    setWorkflowParallelBranchName,
    updateWorkflowBlock,
    type WorkflowBlockListRef,
    type WorkflowBlockRemoval,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { insertWorkflowEditorBlock, resolveSelectionAfterRemoval, type WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';


import { WorkflowAddBlockMenu, type WorkflowAddBlockRequest } from './WorkflowAddBlockMenu';
import { WorkflowActionBlockEditor } from './WorkflowActionBlockEditor';
import { WorkflowNestedWorkflowBlockEditor } from './WorkflowNestedWorkflowBlockEditor';
import { WorkflowWaitBlockEditor } from './WorkflowWaitBlockEditor';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowGroupEditor } from './WorkflowGroupEditor';
import { WorkflowLoopEditor } from './WorkflowLoopEditor';
import { WorkflowStepEditor } from './WorkflowStepEditor';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { listWorkflowBlockOrdinalsV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';
import type { WorkflowSessionDrop } from './WorkflowStepSessionDropZone';
import { formatWorkflowConditionLead, formatWorkflowConditionSentence, WorkflowConditionArmLines } from './WorkflowConditionEditor';
import { WorkflowContainerBody, WorkflowContainerLane, WorkflowContainerOptionsControl } from './WorkflowContainerBody';
import { WorkflowReferenceSentence } from './WorkflowStepDataEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { collectWorkflowConditionValueReferences } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { duplicateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WORKFLOW_EDITOR_TOUCH_POINTER, workflowEditorStyles } from './workflowEditorStyles';
import type { WorkflowDocumentPresentation } from './workflowDocumentPresentation';
import { WorkflowAgentChangeTint } from './WorkflowAgentChangeTint';
import { WorkflowRunWhenConnector } from './WorkflowRunWhenConnector';

export type { WorkflowDocumentPresentation, WorkflowDocumentStepSlots } from './workflowDocumentPresentation';

/**
 * The one recursive ordered block list.
 *
 * Root, parallel branches, loop bodies and conditional branches all render
 * through this component, so there is exactly one insertion, reorder, removal
 * and selection model rather than four editor implementations. It is fully
 * controlled: it holds no draft state and every mutation goes back out through
 * `onChange`.
 */

export type WorkflowBlockListEditorProps = Readonly<{
    draft: WorkflowEditorDraft;
    highlightedBlockIds?: readonly string[];
    list: WorkflowBlockListRef;
    blocks: readonly WorkflowBlock[];
    depth: number;
    selectedBlockId: string | null;
    validation: WorkflowDraftValidation;
    /**
     * Where every prompt in this list addresses reference search, file search
     * and portable attachment pickers: a captured Session, or the exact Machine
     * and project folder the workflow already selected.
     */
    composerScope: AuthoringComposerScope;
    /**
     * The host's custody of every step document.
     *
     * This list is the thing that re-parents a block, so it cannot also be the
     * thing that owns the composer: it passes custody through to each row —
     * including through its own recursion — and never caches a document itself.
     */
    composerCustody: WorkflowAuthoringComposerCustody;
    onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => void;
    onCommitChange?: () => void;
    onSelect: (blockId: string | null) => void;
    /** Opens Step options for a block, anchored beside the control that asked. */
    onCustomize: (blockId: string, anchorRef: React.RefObject<View | null>) => void;
    /** The web Session drop target for Agent steps (J19); absent where no drag source exists. */
    sessionDrop?: WorkflowSessionDrop;
    registerPromptRef?: (blockId: string, focus: (() => void) | null) => void;
    requestPromptFocus?: (blockId: string) => void;
    /**
     * Reports an exact removal so the page can offer an in-place Undo.
     *
     * The coordinate travels, not a whole-draft snapshot: restoring therefore
     * composes with anything edited afterwards instead of reverting it. Nested
     * lists inherit this through the same props spread, so one Undo owner
     * serves every depth.
     */
    onBlockRemoved?: (removal: WorkflowBlockRemoval) => void;
    /** Whole-example insertion belongs to the root draft, not a nested block-list scope. */
    onUseExample?: (example: WorkflowStarterExampleSelection) => void;
    /**
     * `false`: the host's own bar holds the root list's Add (a phone, lab P1), so the document
     * ends without a second, identical Add; Start from an example stays. Nested lists keep theirs.
     */
    rootAddRow?: boolean;
    /** Names the scope for the Add control's accessible hint. */
    scopeLabel?: string;
    /**
     * Editing (default) or the reading presentation 05's Steps tab and a
     * read-only workflow use (04 §4.11). Nested lists inherit it.
     */
    presentation?: WorkflowDocumentPresentation;
    /**
     * Whether step-level issue text is shown (B3): untouched fields stay
     * silent until an explicit Run or Save is refused. Nested lists inherit it.
     */
    revealIssues?: boolean;
    /** Options for an Action step's fields with an `optionsSourceId` (the canonical resolver). */
    resolveActionFieldOptions?: ResolveSessionActionFieldOptions;
    /** The host's Agent and model catalogs for each step's in-composer engine chip (04 §4.3). */
    authoringFacts?: SessionAuthoringControlFacts;
    /** This workflow's own reference, which a Run a workflow step cannot call. */
    currentWorkflowRef?: string | null;
    testIDPrefix?: string;
}>;

export function WorkflowBlockListEditor(props: WorkflowBlockListEditorProps): React.ReactElement {
    const {
        draft, list, blocks, depth, selectedBlockId, validation,
        onChange, onSelect, onCustomize, registerPromptRef, requestPromptFocus,
    } = props;
    const testIDPrefix = props.testIDPrefix ?? 'workflow-editor';
    const editable = props.presentation?.editable !== false;
    const slotsFor = props.presentation?.step;
    const scopeLabel = props.scopeLabel ?? t('workflows.a11y.blockList');
    const composerScope = React.useMemo<AuthoringComposerScope>(() => (
        props.composerScope.kind === 'session'
            ? {
                kind: 'session',
                sessionId: props.composerScope.sessionId,
                ...(props.composerScope.serverId === undefined
                    ? {}
                    : { serverId: props.composerScope.serverId }),
            }
            : {
                kind: 'machine',
                machineId: props.composerScope.machineId,
                ...(props.composerScope.serverId === undefined
                    ? {}
                    : { serverId: props.composerScope.serverId }),
                ...(props.composerScope.directory === undefined
                    ? {}
                    : { directory: props.composerScope.directory }),
                ...(props.composerScope.machineHomeDir === undefined
                    ? {}
                    : { machineHomeDir: props.composerScope.machineHomeDir }),
            }
    ), [
        props.composerScope.kind,
        props.composerScope.serverId,
        props.composerScope.kind === 'session' ? props.composerScope.sessionId : props.composerScope.machineId,
        props.composerScope.kind === 'machine' ? props.composerScope.directory : undefined,
        props.composerScope.kind === 'machine' ? props.composerScope.machineHomeDir : undefined,
    ]);

    // One numbering for the whole document (lab E1): leaves 1…n in execution order, containers none.
    const visibleOrdinals = React.useMemo(() => listWorkflowBlockOrdinalsV1(draft.blocks), [draft.blocks]);

    const addBlock = React.useCallback((request: WorkflowAddBlockRequest, afterBlockId?: string) => {
        const insertion = insertWorkflowEditorBlock(draft, { request, list, ...(afterBlockId === undefined ? {} : { afterBlockId }) });
        const { block } = insertion;
        onChange(insertion.draft);
        onSelect(block.id);
        // Only a composer-bearing step has a prompt to focus.
        if (block.kind === 'step' || block.kind === 'wait') requestPromptFocus?.(block.id);
    }, [draft, list, onChange, onSelect, requestPromptFocus]);

    const buildActions = React.useCallback((block: WorkflowBlock, index: number): readonly WorkflowBlockAction[] => {
        const actions: WorkflowBlockAction[] = [];
        if (!editable) return actions;
        actions.push({ id: 'duplicate', label: t('common.duplicate'), onSelect: () => {
            const copy = duplicateWorkflowBlock(draft, block.id);
            if (copy.blockId === null) return;
            onChange(copy.draft);
            onSelect(copy.blockId);
            if (block.kind === 'step' || block.kind === 'wait') requestPromptFocus?.(copy.blockId);
        } });
        if (index > 0) {
            actions.push({
                id: 'moveUp',
                label: t('workflows.editor.moveUp'),
                onSelect: () => onChange(moveWorkflowBlock(draft, block.id, 'up')),
            });
            const previous = blocks[index - 1];
            if (previous !== undefined && previous.kind !== 'step') {
                actions.push({
                    id: 'moveIn',
                    label: t('workflows.editor.moveIn'),
                    onSelect: () => onChange(moveWorkflowBlock(draft, block.id, 'in')),
                });
            }
        }
        if (index < blocks.length - 1) {
            actions.push({
                id: 'moveDown',
                label: t('workflows.editor.moveDown'),
                onSelect: () => onChange(moveWorkflowBlock(draft, block.id, 'down')),
            });
        }
        if (list.kind !== 'root') {
            actions.push({
                id: 'moveOut',
                label: t('workflows.editor.moveOut'),
                onSelect: () => onChange(moveWorkflowBlock(draft, block.id, 'out')),
            });
        }
        actions.push({
            id: 'remove',
            label: t('workflows.editor.remove'),
            destructive: true,
            onSelect: () => {
                // Focus moves to a surviving meaningful control before the row
                // disappears, so assistive technology is never left on nothing.
                const survivor = resolveSelectionAfterRemoval({
                    draftBeforeRemoval: draft,
                    removedBlockId: block.id,
                });
                onSelect(survivor);
                if (survivor !== null) requestPromptFocus?.(survivor);
                const removal = removeWorkflowBlock(draft, block.id);
                onChange(removal.draft, t('workflows.editor.removedBlock', { block: workflowBlockReferenceLabel(block) }));
                if (removal.removal !== null) props.onBlockRemoved?.(removal.removal);
            },
        });
        return actions;
    }, [blocks, draft, editable, list.kind, onChange, onSelect, props.onBlockRemoved, requestPromptFocus]);

    // On touch there is no hover: the inserters show while a block in this list is selected. Under a
    // precise pointer they show on hover or focus only, so a selection never leaves a hairline in
    // every gap of the document (DESIGN-4 P2).
    const selectedInList = selectedBlockId !== null && blocks.some((block) => block.id === selectedBlockId);
    const revealInserters = WORKFLOW_EDITOR_TOUCH_POINTER && selectedInList;

    const nameEditorFor = (block: WorkflowBlock): WorkflowBlockNameEditor | undefined => editable ? {
        value: block.name ?? '',
        placeholder: workflowBlockReferenceLabel(block),
        accessibilityLabel: `${t('common.rename')} · ${workflowBlockReferenceLabel(block)}`,
        onChangeText: (name) => onChange(setWorkflowBlockName(draft, block.id, name), t('workflows.editor.history.renameStep'), false),
        onCommit: props.onCommitChange,
    } : undefined;

    return (
        <View
            testID={`${testIDPrefix}-list-${list.kind}`}
            accessibilityRole="list"
            accessibilityLabel={scopeLabel}
            style={workflowEditorStyles.blockList}
        >
            {depth === 0 && props.presentation?.note !== undefined
                ? typeof props.presentation.note === 'string' || typeof props.presentation.note === 'number'
                    ? <Text style={[workflowEditorStyles.metaText, workflowEditorStyles.listNote]}>{props.presentation.note}</Text>
                    : <View style={workflowEditorStyles.listNote}>{props.presentation.note}</View>
                : null}
            {blocks.map((block, index) => {
                const ordinal = index + 1;
                const selected = selectedBlockId === block.id;
                const actions = buildActions(block, index);
                const slots = slotsFor?.(block.id) ?? null;
                // A Wait for you has no composer-owned issue line; the page reveals its first issue here.
                // A typed card marks each offending row (DESIGN-6 P3).
                const blockIssues = (block.kind === 'wait' || block.kind === 'action' || block.kind === 'workflow')
                    && editable && props.revealIssues !== false ? workflowIssuesForBlock(validation, block.id, draft) : [];
                const waitIssue = block.kind === 'wait' ? blockIssues[0] : undefined;
                const fieldIssues = block.kind === 'action' || block.kind === 'workflow'
                    ? collectWorkflowFieldIssueTexts(blockIssues, draft) : undefined;
                // Blocks without a prompt still take the page's "focus the first issue" (DESIGN-6 P3).
                const focusRegistration = registerPromptRef === undefined || block.kind === 'step' ? undefined
                    : (focus: (() => void) | null) => registerPromptRef(block.id, focus);

                const previous = index > 0 ? blocks[index - 1] : undefined;
                return (
                    <React.Fragment key={block.id}>
                    {/* The gap before a block is the list's rhythm, one row: the edge's run-when caption on
                        the name column and, editing, the inserter bound to this exact position (lab: one
                        Add, no per-list Add). Neither adds a band of its own (DESIGN-7 M2). */}
                    {previous !== undefined || block.runWhen !== undefined ? (
                        <View testID={`${testIDPrefix}-gap-${block.id}`} style={workflowEditorStyles.blockGap}>
                            <View style={workflowEditorStyles.blockGapCaption}>
                                <WorkflowRunWhenConnector
                                    value={block.runWhen ?? 'success'} editable={editable}
                                    testID={`${testIDPrefix}-${block.id}-run-when`}
                                    onChange={runWhen => onChange(updateWorkflowBlock(draft, block.id, current => {
                                        if (runWhen !== 'success') return { ...current, runWhen };
                                        const { runWhen: _dropped, ...rest } = current;
                                        return rest;
                                    }))} />
                            </View>
                            {editable && previous !== undefined ? (
                                <View style={workflowEditorStyles.blockGapInserter}>
                                    <WorkflowAddBlockMenu
                                        composerScope={composerScope}
                                        variant="inserter"
                                        revealed={revealInserters}
                                        onAdd={(request) => addBlock(request, previous.id)}
                                        {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                                        scopeLabel={scopeLabel}
                                        testID={`${testIDPrefix}-insert-after-${previous.id}`}
                                    />
                                </View>
                            ) : null}
                        </View>
                    ) : null}
                    <View
                        // Each block is a real member of the ordered list, so
                        // assistive technology can say "2 of 3" and move by item.
                        // Position and set size are web ARIA; native reads the
                        // same facts from the block heading's accessible name.
                        role="listitem"
                        {...(Platform.OS === 'web'
                            ? { 'aria-posinset': ordinal, 'aria-setsize': blocks.length }
                            : {})}
                    >
                        {/* The block and its condition line, one column: a sibling here must
                            never take width from the block's card. A container draws the rail. */}
                        <View style={workflowEditorStyles.blockColumn}>
                        {block.kind === 'step' ? (
                            <WorkflowStepEditor
                                nameEditor={nameEditorFor(block)}
                                draft={draft}
                                step={block}
                                ordinal={ordinal}
                                visibleOrdinal={visibleOrdinals.get(block.id) ?? null}
                                selected={selected}
                                total={blocks.length}
                                composerScope={composerScope}
                                composerCustody={props.composerCustody}
                                validation={validation}
                                actions={actions}
                                onSelect={() => onSelect(block.id)}
                                onChangeDocument={(document) => onChange(updateWorkflowBlock(
                                    draft,
                                    block.id,
                                    (current) => current.kind === 'step' ? { ...current, document } : current,
                                ), t('workflows.editor.history.document'), false)}
                                onCommitDocument={props.onCommitChange}
                                onCustomize={(anchorRef) => onCustomize(block.id, anchorRef)}
                                onChangeInput={(input) => onChange(updateWorkflowBlock(draft, block.id, (current) => (
                                    current.kind === 'step' ? { ...current, input: [...input] } : current
                                )))}
                                onChangeExecutionField={(field, value) => onChange(setWorkflowStepExecutionField(draft, block.id, field, value))}
                                onChangeExecutionFields={(fields) => onChange(updateWorkflowBlock(draft, block.id, current => current.kind === 'step'
                                    ? { ...current, execution: withWorkflowAuthoringEngineFields(current.execution ?? {}, fields) } : current))}
                                onChangeEngine={(engine) => onChange(updateWorkflowBlock(draft, block.id, current => current.kind === 'step'
                                    ? { ...current, execution: withWorkflowAuthoringEngine(current.execution ?? {}, engine) } : current))}
                                {...(props.authoringFacts === undefined ? {} : { authoringFacts: props.authoringFacts })}
                                {...(registerPromptRef === undefined ? {} : { registerPromptRef })}
                                editable={editable}
                                slots={slots}
                                {...(props.sessionDrop === undefined ? {} : { sessionDrop: props.sessionDrop })}
                                revealIssues={props.revealIssues !== false}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'parallel' ? (
                            <WorkflowGroupEditor
                                nameEditor={nameEditorFor(block)}
                                {...(focusRegistration === undefined ? {} : { focusRegistration })}
                                block={block}
                                ordinal={ordinal}
                                selected={selected}
                                actions={actions}
                                headingAccessory={slots?.occurrenceSelector ?? slots?.state}
                                onSelect={() => onSelect(block.id)}
                                {...(editable ? {
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => onCustomize(block.id, anchorRef),
                                    onAddBranch: () => onChange(updateWorkflowBlock(draft, block.id, (current) => (
                                        current.kind === 'parallel'
                                            ? { ...current, branches: [...current.branches, createWorkflowParallelBranch(collectWorkflowBlockIds(draft))] }
                                            : current
                                    ))),
                                    onRemoveBranch: (branchId: string) => onChange(updateWorkflowBlock(draft, block.id, (current) => (
                                        current.kind !== 'parallel' || current.branches.length <= 1
                                            ? current
                                            : { ...current, branches: current.branches.filter((branch) => branch.id !== branchId) }
                                    ))),
                                    onRenameBranch: (branchId: string, name: string) => onChange(
                                        setWorkflowParallelBranchName(draft, block.id, branchId, name), t('workflows.editor.history.renameLane'), false),
                                    ...(props.onCommitChange === undefined ? {} : { onCommitRename: props.onCommitChange }),
                                } : {})}
                                renderBranch={(branch, branchIndex) => (
                                    <WorkflowBlockListEditor
                                        {...props}
                                        list={{ kind: 'parallelBranch', parallelId: block.id, branchId: branch.id }}
                                        blocks={branch.blocks}
                                        depth={depth + 1}
                                        scopeLabel={branch.name ?? t('workflows.page.inspector.lane', { position: branchIndex + 1 })}
                                    />
                                )}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'loop' ? (
                            <WorkflowLoopEditor
                                nameEditor={nameEditorFor(block)}
                                {...(focusRegistration === undefined ? {} : { focusRegistration })}
                                draft={draft}
                                block={block}
                                ordinal={ordinal}
                                selected={selected}
                                actions={actions}
                                headingAccessory={slots?.occurrenceSelector ?? slots?.state}
                                onSelect={() => onSelect(block.id)}
                                {...(editable ? {
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => onCustomize(block.id, anchorRef),
                                } : {})}
                                renderBody={() => (
                                    <WorkflowBlockListEditor
                                        {...props}
                                        list={{ kind: 'loopBody', loopId: block.id }}
                                        blocks={block.body}
                                        depth={depth + 1}
                                        scopeLabel={t('workflows.editor.loopBody')}
                                    />
                                )}
                                renderContinuation={block.repetition.kind === 'evaluate'
                                    ? () => {
                                        const evaluator = (block.repetition as Extract<WorkflowRepetition, { kind: 'evaluate' }>).evaluator;
                                        // The one who decides may be an Agent step or an Action step (U4).
                                        if (evaluator.kind === 'action') {
                                            return (
                                                <WorkflowActionBlockEditor
                                                    nameEditor={nameEditorFor(evaluator)}
                                                    composerScope={composerScope}
                                                    block={evaluator}
                                                    draft={draft}
                                                    ordinal={block.body.length + 1}
                                                    visibleOrdinal={visibleOrdinals.get(evaluator.id) ?? null}
                                                    total={block.body.length + 1}
                                                    actions={[]}
                                                    onSelect={() => onSelect(evaluator.id)}
                                                    onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                                        draft,
                                                        evaluator.id,
                                                        (current) => (current.kind === 'action' ? next : current),
                                                    ))}
                                                    {...(props.resolveActionFieldOptions === undefined
                                                        ? {}
                                                        : { resolveFieldOptions: props.resolveActionFieldOptions })}
                                                    editable={editable}
                                                    testIDPrefix={testIDPrefix}
                                                />
                                            );
                                        }
                                        return (
                                        <WorkflowStepEditor
                                            nameEditor={nameEditorFor(evaluator)}
                                            draft={draft}
                                            step={evaluator}
                                            ordinal={block.body.length + 1}
                                            visibleOrdinal={visibleOrdinals.get(evaluator.id) ?? null}
                                            total={block.body.length + 1}
                                            composerScope={composerScope}
                                            composerCustody={props.composerCustody}
                                            validation={validation}
                                            actions={[]}
                                            onSelect={() => onSelect(evaluator.id)}
                                            onChangeDocument={(document) => onChange(updateWorkflowBlock(
                                                draft,
                                                evaluator.id,
                                                (current) => (current.kind === 'step'
                                                    ? { ...current, document }
                                                    : current),
                                            ), t('workflows.editor.history.document'), false)}
                                            onCommitDocument={props.onCommitChange}
                                            onCustomize={(anchorRef) => onCustomize(evaluator.id, anchorRef)}
                                            onChangeInput={(input) => onChange(updateWorkflowBlock(
                                                draft,
                                                evaluator.id,
                                                (current) => current.kind === 'step' ? { ...current, input: [...input] } : current,
                                            ))}
                                            {...(registerPromptRef === undefined ? {} : { registerPromptRef })}
                                            editable={editable}
                                            testIDPrefix={testIDPrefix}
                                        />
                                        );
                                    }
                                    : undefined}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'action' ? (
                            <WorkflowActionBlockEditor
                                nameEditor={nameEditorFor(block)}
                                composerScope={composerScope}
                                block={block}
                                {...(focusRegistration === undefined ? {} : { focusRegistration })}
                                {...(fieldIssues === undefined ? {} : { fieldIssues })}
                                {...(editable ? {
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => onCustomize(block.id, anchorRef),
                                } : {})}
                                draft={draft}
                                ordinal={ordinal}
                                visibleOrdinal={visibleOrdinals.get(block.id) ?? null}
                                selected={selected}
                                total={blocks.length}
                                actions={actions}
                                onSelect={() => onSelect(block.id)}
                                onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                    draft,
                                    block.id,
                                    (current) => (current.kind === 'action' ? next : current),
                                ))}
                                {...(props.resolveActionFieldOptions === undefined
                                    ? {}
                                    : { resolveFieldOptions: props.resolveActionFieldOptions })}
                                editable={editable}
                                slots={slots}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'workflow' ? (
                            <WorkflowNestedWorkflowBlockEditor
                                nameEditor={nameEditorFor(block)}
                                {...(focusRegistration === undefined ? {} : { focusRegistration })}
                                {...(fieldIssues === undefined ? {} : { fieldIssues })}
                                block={block}
                                {...(editable ? {
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => onCustomize(block.id, anchorRef),
                                } : {})}
                                draft={draft}
                                ordinal={ordinal}
                                visibleOrdinal={visibleOrdinals.get(block.id) ?? null}
                                selected={selected}
                                total={blocks.length}
                                actions={actions}
                                onSelect={() => onSelect(block.id)}
                                onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                    draft,
                                    block.id,
                                    (current) => (current.kind === 'workflow' ? next : current),
                                ))}
                                editable={editable}
                                slots={slots}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'wait' ? (
                            <WorkflowWaitBlockEditor
                                nameEditor={nameEditorFor(block)}
                                {...(focusRegistration === undefined ? {} : { focusRegistration })}
                                inLane={list.kind !== 'root'}
                                block={block}
                                draft={draft}
                                {...(editable ? {
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => onCustomize(block.id, anchorRef),
                                } : {})}
                                ordinal={ordinal}
                                visibleOrdinal={visibleOrdinals.get(block.id) ?? null}
                                selected={selected}
                                total={blocks.length}
                                actions={actions}
                                composerScope={composerScope}
                                composerCustody={props.composerCustody}
                                issue={waitIssue === undefined ? null : formatWorkflowIssueText(waitIssue, draft)}
                                onSelect={() => onSelect(block.id)}
                                onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                    draft,
                                    block.id,
                                    (current) => (current.kind === 'wait' ? next : current),
                                ))}
                                editable={editable}
                                slots={slots}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'if' ? (
                            <View testID={`${testIDPrefix}-if-${block.id}`} style={workflowEditorStyles.blockBody}>
                                <WorkflowBlockHeading
                                    nameEditor={nameEditorFor(block)}
                                    kindMark={<Icon name={WORKFLOW_BLOCK_KIND_GLYPH.if} size={ICON_SIZE.sm} />}
                                    ordinal={ordinal}
                                    selected={selected}
                                    unnamed={resolveWorkflowUnnamedHeading(block)}
                                    displayName={workflowBlockReferenceLabel(block)}
                                    {...(focusRegistration === undefined ? {} : { focusRegistration })}
                                    meta={<Text testID={`${testIDPrefix}-if-${block.id}-sentence`}
                                        accessibilityLabel={t('workflows.page.inspector.ifSentence', { condition: formatWorkflowConditionSentence(draft, block.when) })}>
                                        <WorkflowReferenceSentence draft={draft}
                                            sentence={t('workflows.page.inspector.ifSentence', { condition: formatWorkflowConditionLead(draft, block.when) })}
                                            references={collectWorkflowConditionValueReferences(block.when)} />
                                    </Text>}
                                    trailing={<WorkflowContainerOptionsControl
                                        optionsLabel={t('workflows.page.inspector.options')}
                                        {...(editable ? {
                                            onOpenOptions: (anchorRef: React.RefObject<View | null>) => onCustomize(block.id, anchorRef),
                                        } : {})}
                                        testID={`${testIDPrefix}-if-${block.id}-summary`}
                                    />}
                                    actions={editable && block.otherwise.length === 0 ? [
                                        ...actions.filter((action) => action.id !== 'remove'),
                                        { id: 'addOtherwise', label: t('workflows.editor.addOtherwise'), onSelect: () => {
                                            const insertion = insertWorkflowEditorBlock(draft, { request: { kind: 'step' }, list: { kind: 'ifOtherwise', ifId: block.id } });
                                            onChange(insertion.draft);
                                            onSelect(insertion.block.id);
                                            requestPromptFocus?.(insertion.block.id);
                                        } },
                                        ...actions.filter((action) => action.id === 'remove'),
                                    ] : actions}
                                    accessory={slots?.state}
                                    onSelect={() => onSelect(block.id)}
                                    testID={`${testIDPrefix}-if-${block.id}-label`}
                                    actionsTestID={`${testIDPrefix}-if-${block.id}-actions`}
                                />
                                <WorkflowConditionArmLines draft={draft} condition={block.when} testID={`${testIDPrefix}-if-${block.id}-summary-arms`} />
                                <WorkflowContainerBody conditional>
                                    <WorkflowContainerLane conditional label={t('workflows.editor.ifTrue')}
                                        labelTestID={`${testIDPrefix}-if-${block.id}-then-label`}>
                                        <WorkflowBlockListEditor
                                            {...props}
                                            list={{ kind: 'ifThen', ifId: block.id }}
                                            blocks={block.then}
                                            depth={depth + 1}
                                            scopeLabel={t('workflows.editor.ifTrue')}
                                        />
                                    </WorkflowContainerLane>
                                    {/* An empty Otherwise is not drawn (lab E1); the If's own menu adds one. */}
                                    {block.otherwise.length === 0 ? null : (
                                        <WorkflowContainerLane conditional label={t('workflows.editor.otherwise')}
                                            labelTestID={`${testIDPrefix}-if-${block.id}-otherwise-label`}>
                                            <WorkflowBlockListEditor
                                                {...props}
                                                list={{ kind: 'ifOtherwise', ifId: block.id }}
                                                blocks={block.otherwise}
                                                depth={depth + 1}
                                                scopeLabel={t('workflows.editor.otherwise')}
                                            />
                                        </WorkflowContainerLane>
                                    )}
                                </WorkflowContainerBody>
                            </View>
                        ) : null}

                        {block.kind !== 'if' && block.onlyWhen !== undefined ? (
                            <Text
                                testID={`${testIDPrefix}-${block.kind}-${block.id}-only-when`}
                                style={workflowEditorStyles.groupSummary}
                            >
                                {t('workflows.page.inspector.onlyWhenSentence', {
                                    condition: formatWorkflowConditionSentence(draft, block.onlyWhen),
                                })}
                            </Text>
                        ) : null}
                        </View>
                        {props.highlightedBlockIds?.includes(block.id) ? <WorkflowAgentChangeTint blockId={block.id} /> : null}
                    </View>
                    {/* A nested list's last gap appends there; the root's end row adds after its last block. */}
                    {editable && index === blocks.length - 1 && list.kind !== 'root' ? (
                        <WorkflowAddBlockMenu
                            composerScope={composerScope}
                            variant="inserter"
                            revealed={revealInserters}
                            onAdd={(request) => addBlock(request, block.id)}
                            {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                            scopeLabel={scopeLabel}
                            testID={`${testIDPrefix}-add-${list.kind}`}
                        />
                    ) : null}
                    </React.Fragment>
                );
            })}

            {editable && list.kind === 'root' && !(props.rootAddRow === false && props.onUseExample === undefined) ? (
                <View style={blocks.length === 0 ? undefined : workflowEditorStyles.listEnd}>
                    <WorkflowAddBlockMenu
                        composerScope={composerScope}
                        examplesOnly={props.rootAddRow === false}
                        onAdd={(request) => addBlock(request, blocks[blocks.length - 1]?.id)}
                        {...(props.onUseExample === undefined ? {} : { onUseExample: props.onUseExample })}
                        {...(props.currentWorkflowRef === undefined ? {} : { currentWorkflowRef: props.currentWorkflowRef })}
                        scopeLabel={scopeLabel}
                        testID={`${testIDPrefix}-add-${list.kind}`}
                    />
                </View>
            ) : null}
        </View>
    );
}
