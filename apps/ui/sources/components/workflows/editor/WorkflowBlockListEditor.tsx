import * as React from 'react';
import type { WorkflowStarterExampleSelection } from '@happier-dev/protocol/workflows/builtins/examples';
import { Platform, View } from 'react-native';

import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import type { WorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

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
import { formatWorkflowConditionSentence, resolveWorkflowConditionHeadline } from '../presentation/workflowConditionPresentation';
import { WorkflowContainerBody, WorkflowContainerLane, WorkflowContainerOptionsControl } from './WorkflowContainerBody';
import { WorkflowReferenceSentence } from './WorkflowStepDataEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';

import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { duplicateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WORKFLOW_EDITOR_TOUCH_POINTER, workflowEditorStyles } from './workflowEditorStyles';
import type { WorkflowDocumentPresentation } from './workflowDocumentPresentation';
import { WorkflowAgentChangeTint } from './WorkflowAgentChangeTint';
import { WorkflowRunWhenCaption } from './WorkflowRunWhenConnector';

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
    /**
     * Opens a block's Step options from its control (`anchorRef`, where focus returns). A leaf block
     * also names its card region (`cardRef`), so the options sit beside the card without covering it.
     */
    onCustomize: (blockId: string, anchorRef: React.RefObject<View | null>, cardRef?: React.RefObject<View | null>) => void;
    /** A retained inspector owns its card refs when responsive layouts remount this document. */
    cardRefs?: React.RefObject<Map<string, React.RefObject<View | null>>>;
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
        registerPromptRef, requestPromptFocus,
    } = props;
    const owner = React.useRef(props);
    owner.current = props;
    const preferredLanguage = usePreferredLanguage();
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
        const current = owner.current;
        const insertion = insertWorkflowEditorBlock(current.draft, {
            request, list: current.list, ...(afterBlockId === undefined ? {} : { afterBlockId }),
        });
        current.onChange(insertion.draft);
        current.onSelect(insertion.block.id);
        if (insertion.block.kind === 'step' || insertion.block.kind === 'wait') current.requestPromptFocus?.(insertion.block.id);
    }, []);

    // On touch there is no hover: the inserters show while a block in this list is selected. Under a
    // precise pointer they show on hover or focus only, so a selection never leaves a hairline in
    // every gap of the document (DESIGN-4 P2).
    const selectedInList = selectedBlockId !== null && blocks.some((block) => block.id === selectedBlockId);
    const revealInserters = WORKFLOW_EDITOR_TOUCH_POINTER && selectedInList;

    // A leaf block's row is its card; a container's row spans its whole body, so only its own control anchors.
    const localCardRefs = React.useRef(new Map<string, React.RefObject<View | null>>());
    const cardRefs = props.cardRefs ?? localCardRefs;
    const cardRefFor = React.useCallback((blockId: string): React.RefObject<View | null> => {
        const existing = cardRefs.current.get(blockId);
        if (existing !== undefined) return existing;
        const created: React.RefObject<View | null> = React.createRef<View>();
        cardRefs.current.set(blockId, created);
        return created;
    }, [cardRefs]);

    const rowContext = React.useMemo(() => ({
        composerScope, composerCustody: props.composerCustody, depth, listKind: list.kind,
        scopeLabel, editable, revealInserters, revealIssues: props.revealIssues,
        currentWorkflowRef: props.currentWorkflowRef, testIDPrefix, authoringFacts: props.authoringFacts,
        sessionDrop: props.sessionDrop, resolveActionFieldOptions: props.resolveActionFieldOptions,
        registerPromptRef, requestPromptFocus, onCommitChange: props.onCommitChange,
        cardRefFor, addBlock, preferredLanguage,
    }), [composerScope, props.composerCustody, depth, list.kind, scopeLabel, editable, revealInserters,
        props.revealIssues, props.currentWorkflowRef, testIDPrefix, props.authoringFacts,
        props.sessionDrop, props.resolveActionFieldOptions, registerPromptRef, requestPromptFocus,
        props.onCommitChange, cardRefFor, addBlock, preferredLanguage]);

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
                const waitIssue = block.kind === 'wait' && editable && props.revealIssues !== false
                    ? workflowIssuesForBlock(validation, block.id, draft)[0] : undefined;
                // Wait cards read their own document. Only conditions require the
                // definition's reference labels; other block editors also consume
                // defaults and cross-step data, so retain that dependency.
                const definition = block.kind === 'wait' && block.onlyWhen === undefined ? null : draft;
                return <WorkflowBlockListItem key={block.id} owner={owner} context={rowContext}
                    definition={definition} validation={definition === null ? null : validation}
                    block={block} index={index} total={blocks.length}
                    previousId={index > 0 ? blocks[index - 1]?.id : undefined}
                    previousKind={index > 0 ? blocks[index - 1]?.kind : undefined}
                    selected={selectedBlockId === block.id}
                    nestedSelection={block.kind === 'parallel' || block.kind === 'loop' || block.kind === 'if' ? selectedBlockId : null}
                    visibleOrdinal={visibleOrdinals.get(block.id) ?? null}
                    evaluatorOrdinal={block.kind === 'loop' && block.repetition.kind === 'evaluate'
                        ? visibleOrdinals.get(block.repetition.evaluator.id) ?? null : null}
                    slots={slotsFor?.(block.id) ?? null}
                    highlighted={props.highlightedBlockIds?.includes(block.id) === true}
                    waitIssue={waitIssue === undefined ? null : formatWorkflowIssueText(waitIssue, draft)} />;
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

type WorkflowBlockListRowContext = Readonly<{
    composerScope: AuthoringComposerScope;
    composerCustody: WorkflowAuthoringComposerCustody;
    depth: number;
    listKind: WorkflowBlockListRef['kind'];
    scopeLabel: string;
    editable: boolean;
    revealInserters: boolean;
    revealIssues: boolean | undefined;
    currentWorkflowRef: string | null | undefined;
    testIDPrefix: string;
    authoringFacts: SessionAuthoringControlFacts | undefined;
    sessionDrop: WorkflowSessionDrop | undefined;
    resolveActionFieldOptions: ResolveSessionActionFieldOptions | undefined;
    registerPromptRef: WorkflowBlockListEditorProps['registerPromptRef'];
    requestPromptFocus: WorkflowBlockListEditorProps['requestPromptFocus'];
    onCommitChange: WorkflowBlockListEditorProps['onCommitChange'];
    cardRefFor: (blockId: string) => React.RefObject<View | null>;
    addBlock: (request: WorkflowAddBlockRequest, afterBlockId?: string) => void;
}>;

/** A row receives changed display facts; edits always resolve against its live list owner. */
const WorkflowBlockListItem = React.memo(function WorkflowBlockListItem(row: Readonly<{
    owner: React.RefObject<WorkflowBlockListEditorProps>;
    context: WorkflowBlockListRowContext;
    definition: WorkflowEditorDraft | null;
    validation: WorkflowDraftValidation | null;
    block: WorkflowBlock;
    previousId: string | undefined;
    previousKind: WorkflowBlock['kind'] | undefined;
    index: number;
    total: number;
    selected: boolean;
    nestedSelection: string | null;
    visibleOrdinal: string | null;
    evaluatorOrdinal: string | null;
    slots: import('./workflowDocumentPresentation').WorkflowDocumentStepSlots | null;
    highlighted: boolean;
    waitIssue: string | null;
}>): React.ReactElement {
    const props = row.owner.current;
    const draft = row.definition ?? props.draft;
    const validation = row.validation ?? props.validation;
    const { list, blocks } = props;
    const { block, index } = row;
    const { composerScope, depth, scopeLabel, editable, revealInserters, testIDPrefix,
        registerPromptRef, requestPromptFocus, cardRefFor, addBlock } = row.context;
    const readDraft = () => row.owner.current.draft;
    const onChange: WorkflowBlockListEditorProps['onChange'] = (...args) => row.owner.current.onChange(...args);
    const onSelect: WorkflowBlockListEditorProps['onSelect'] = (...args) => row.owner.current.onSelect(...args);
    const onCustomize: WorkflowBlockListEditorProps['onCustomize'] = (...args) => row.owner.current.onCustomize(...args);
    const buildActions = (block: WorkflowBlock, index: number): readonly WorkflowBlockAction[] => {
        const actions: WorkflowBlockAction[] = [];
        if (!editable) return actions;
        actions.push({ id: 'duplicate', label: t('common.duplicate'), onSelect: () => {
            const copy = duplicateWorkflowBlock(readDraft(), block.id);
            if (copy.blockId === null) return;
            onChange(copy.draft);
            onSelect(copy.blockId);
            if (block.kind === 'step' || block.kind === 'wait') requestPromptFocus?.(copy.blockId);
        } });
        if (index > 0) {
            actions.push({
                id: 'moveUp',
                label: t('workflows.editor.moveUp'),
                onSelect: () => onChange(moveWorkflowBlock(readDraft(), block.id, 'up')),
            });
            const previous = blocks[index - 1];
            if (previous !== undefined && previous.kind !== 'step') {
                actions.push({
                    id: 'moveIn',
                    label: t('workflows.editor.moveIn'),
                    onSelect: () => onChange(moveWorkflowBlock(readDraft(), block.id, 'in')),
                });
            }
        }
        if (index < blocks.length - 1) {
            actions.push({
                id: 'moveDown',
                label: t('workflows.editor.moveDown'),
                onSelect: () => onChange(moveWorkflowBlock(readDraft(), block.id, 'down')),
            });
        }
        if (list.kind !== 'root') {
            actions.push({
                id: 'moveOut',
                label: t('workflows.editor.moveOut'),
                onSelect: () => onChange(moveWorkflowBlock(readDraft(), block.id, 'out')),
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
                    draftBeforeRemoval: readDraft(),
                    removedBlockId: block.id,
                });
                onSelect(survivor);
                if (survivor !== null) requestPromptFocus?.(survivor);
                const removal = removeWorkflowBlock(readDraft(), block.id);
                onChange(removal.draft, t('workflows.editor.removedBlock', { block: workflowBlockReferenceLabel(block) }));
                if (removal.removal !== null) row.owner.current.onBlockRemoved?.(removal.removal);
            },
        });
        return actions;
    };

    const customizeBlock = (block: WorkflowBlock, anchorRef: React.RefObject<View | null>) => {
        const leaf = block.kind === 'step' || block.kind === 'action' || block.kind === 'workflow' || block.kind === 'wait';
        onCustomize(block.id, anchorRef, leaf ? cardRefFor(block.id) : undefined);
    };
    const nameEditorFor = (block: WorkflowBlock): WorkflowBlockNameEditor | undefined => editable ? {
        value: block.name ?? '',
        placeholder: workflowBlockReferenceLabel(block),
        accessibilityLabel: `${t('common.rename')} · ${workflowBlockReferenceLabel(block)}`,
        onChangeText: (name) => onChange(setWorkflowBlockName(readDraft(), block.id, name), t('workflows.editor.history.renameStep'), false),
        onCommit: props.onCommitChange,
    } : undefined;


    const ordinal = index + 1;
    const selected = row.selected;
                const actions = buildActions(block, index);
    const slots = row.slots;
                // A Wait for you has no composer-owned issue line; the page reveals its first issue here.
                // A typed card marks each offending row (DESIGN-6 P3).
                const blockIssues = (block.kind === 'wait' || block.kind === 'action' || block.kind === 'workflow')
                    && editable && props.revealIssues !== false ? workflowIssuesForBlock(validation, block.id, draft) : [];
                const fieldIssues = block.kind === 'action' || block.kind === 'workflow'
                    ? collectWorkflowFieldIssueTexts(blockIssues, draft) : undefined;
                // Blocks without a prompt still take the page's "focus the first issue" (DESIGN-6 P3).
                const focusRegistration = registerPromptRef === undefined || block.kind === 'step' ? undefined
                    : (focus: (() => void) | null) => registerPromptRef(block.id, focus);

    const previous = row.previousId === undefined ? undefined : { id: row.previousId, kind: row.previousKind };
                const ifHeadline = block.kind === 'if' ? resolveWorkflowConditionHeadline(draft, block.when) : null;

    return (
                    <React.Fragment key={block.id}>
                    {/* The gap before a block is the list's rhythm, one row on the name column: a
                        non-default run-when caption ("If it fails"), and, editing, the inserter bound to
                        this exact position (lab: one Add, no per-list Add). Neither adds a band of its
                        own (DESIGN-7 M2); the default edge says nothing (lab E1). */}
                    {previous !== undefined || (block.runWhen !== undefined && block.runWhen !== 'success') ? (
                        <View testID={`${testIDPrefix}-gap-${block.id}`} style={workflowEditorStyles.blockGap}>
                            <WorkflowRunWhenCaption value={block.runWhen} testID={`${testIDPrefix}-${block.id}-run-when`} />
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
                        ref={cardRefFor(block.id)}
                        collapsable={false}
                        // Each block is a real member of the ordered list, so
                        // assistive technology can say "2 of 3" and move by item.
                        // Position and set size are web ARIA; native reads the
                        // same facts from the block heading's accessible name.
                        role="listitem"
                        {...(Platform.OS === 'web'
                            ? { 'aria-posinset': ordinal, 'aria-setsize': blocks.length }
                            : {})}
                    >
                        {/* The selected leaf's plate sits behind it; a container's selection stays on its mark. */}
                        {selected && editable && (block.kind === 'step' || block.kind === 'action' || block.kind === 'workflow' || block.kind === 'wait') ? (
                            <View pointerEvents="none" testID={`${testIDPrefix}-${block.id}-selected`} style={workflowEditorStyles.selectedPlate} />
                        ) : null}
                        {/* The block and its condition line, one column: a sibling here must
                            never take width from the block's card. A container draws the rail. */}
                        <View style={workflowEditorStyles.blockColumn}>
                        {block.kind === 'step' ? (
                            <WorkflowStepEditor
                                nameEditor={nameEditorFor(block)}
                                draft={draft}
                                step={block}
                                ordinal={ordinal}
                                visibleOrdinal={row.visibleOrdinal}
                                selected={selected}
                                total={blocks.length}
                                composerScope={composerScope}
                                composerCustody={props.composerCustody}
                                validation={validation}
                                actions={actions}
                                onSelect={() => onSelect(block.id)}
                                onChangeDocument={(document) => onChange(updateWorkflowBlock(
                                    readDraft(),
                                    block.id,
                                    (current) => current.kind === 'step' ? { ...current, document } : current,
                                ), t('workflows.editor.history.document'), false)}
                                onCommitDocument={props.onCommitChange}
                                onCustomize={(anchorRef) => customizeBlock(block, anchorRef)}
                                onChangeInput={(input) => onChange(updateWorkflowBlock(readDraft(), block.id, (current) => (
                                    current.kind === 'step' ? { ...current, input: [...input] } : current
                                )))}
                                onChangeExecutionField={(field, value) => onChange(setWorkflowStepExecutionField(readDraft(), block.id, field, value))}
                                onChangeExecutionFields={(fields) => onChange(updateWorkflowBlock(readDraft(), block.id, current => current.kind === 'step'
                                    ? { ...current, execution: withWorkflowAuthoringEngineFields(current.execution ?? {}, fields) } : current))}
                                onChangeEngine={(engine) => onChange(updateWorkflowBlock(readDraft(), block.id, current => current.kind === 'step'
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
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => customizeBlock(block, anchorRef),
                                    onAddBranch: () => onChange(updateWorkflowBlock(readDraft(), block.id, (current) => (
                                        current.kind === 'parallel'
                                            ? { ...current, branches: [...current.branches, createWorkflowParallelBranch(collectWorkflowBlockIds(readDraft()))] }
                                            : current
                                    ))),
                                    onRemoveBranch: (branchId: string) => onChange(updateWorkflowBlock(readDraft(), block.id, (current) => (
                                        current.kind !== 'parallel' || current.branches.length <= 1
                                            ? current
                                            : { ...current, branches: current.branches.filter((branch) => branch.id !== branchId) }
                                    ))),
                                    onRenameBranch: (branchId: string, name: string) => onChange(
                                        setWorkflowParallelBranchName(readDraft(), block.id, branchId, name), t('workflows.editor.history.renameLane'), false),
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
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => customizeBlock(block, anchorRef),
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
                                                    visibleOrdinal={row.evaluatorOrdinal}
                                                    total={block.body.length + 1}
                                                    actions={[]}
                                                    onSelect={() => onSelect(evaluator.id)}
                                                    onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                                        readDraft(),
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
                                            visibleOrdinal={row.evaluatorOrdinal}
                                            total={block.body.length + 1}
                                            composerScope={composerScope}
                                            composerCustody={props.composerCustody}
                                            validation={validation}
                                            actions={[]}
                                            onSelect={() => onSelect(evaluator.id)}
                                            onChangeDocument={(document) => onChange(updateWorkflowBlock(
                                                readDraft(),
                                                evaluator.id,
                                                (current) => (current.kind === 'step'
                                                    ? { ...current, document }
                                                    : current),
                                            ), t('workflows.editor.history.document'), false)}
                                            onCommitDocument={props.onCommitChange}
                                            onCustomize={(anchorRef) => onCustomize(evaluator.id, anchorRef)}
                                            onChangeInput={(input) => onChange(updateWorkflowBlock(
                                                readDraft(),
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
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => customizeBlock(block, anchorRef),
                                } : {})}
                                draft={draft}
                                ordinal={ordinal}
                                visibleOrdinal={row.visibleOrdinal}
                                selected={selected}
                                total={blocks.length}
                                actions={actions}
                                onSelect={() => onSelect(block.id)}
                                onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                    readDraft(),
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
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => customizeBlock(block, anchorRef),
                                } : {})}
                                draft={draft}
                                ordinal={ordinal}
                                visibleOrdinal={row.visibleOrdinal}
                                selected={selected}
                                total={blocks.length}
                                actions={actions}
                                onSelect={() => onSelect(block.id)}
                                onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                    readDraft(),
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
                                {...(editable ? {
                                    onOpenOptions: (anchorRef: React.RefObject<View | null>) => customizeBlock(block, anchorRef),
                                } : {})}
                                ordinal={ordinal}
                                visibleOrdinal={row.visibleOrdinal}
                                selected={selected}
                                total={blocks.length}
                                actions={actions}
                                composerScope={composerScope}
                                composerCustody={props.composerCustody}
                                issue={row.waitIssue}
                                onSelect={() => onSelect(block.id)}
                                onChangeBlock={(next) => onChange(updateWorkflowBlock(
                                    readDraft(),
                                    block.id,
                                    (current) => (current.kind === 'wait' ? next : current),
                                ))}
                                editable={editable}
                                slots={slots}
                                testIDPrefix={testIDPrefix}
                            />
                        ) : null}

                        {block.kind === 'if' && ifHeadline !== null ? (
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
                                            sentence={t('workflows.page.inspector.ifSentence', { condition: ifHeadline.sentence })}
                                            references={ifHeadline.references} />
                                    </Text>}
                                    // A bare chevron has no words to wrap with: it stays beside the row's menu, whatever the sentence does.
                                    accessory={<>{slots?.state}<WorkflowContainerOptionsControl
                                        optionsLabel={t('workflows.page.inspector.options')}
                                        {...(editable ? {
                                            onOpenOptions: (anchorRef: React.RefObject<View | null>) => customizeBlock(block, anchorRef),
                                        } : {})}
                                        testID={`${testIDPrefix}-if-${block.id}-summary`}
                                    /></>}
                                    actions={editable && block.otherwise.length === 0 ? [
                                        ...actions.filter((action) => action.id !== 'remove'),
                                        { id: 'addOtherwise', label: t('workflows.editor.addOtherwise'), onSelect: () => {
                                            const insertion = insertWorkflowEditorBlock(readDraft(), { request: { kind: 'step' }, list: { kind: 'ifOtherwise', ifId: block.id } });
                                            onChange(insertion.draft);
                                            onSelect(insertion.block.id);
                                            requestPromptFocus?.(insertion.block.id);
                                        } },
                                        ...actions.filter((action) => action.id === 'remove'),
                                    ] : actions}
                                    onSelect={() => onSelect(block.id)}
                                    testID={`${testIDPrefix}-if-${block.id}-label`}
                                    actionsTestID={`${testIDPrefix}-if-${block.id}-actions`}
                                />
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
                        {row.highlighted ? <WorkflowAgentChangeTint blockId={block.id} /> : null}
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
});
