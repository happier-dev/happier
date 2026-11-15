import * as React from 'react';
import type { WorkflowStarterExampleSelection } from '@happier-dev/protocol/workflows/builtins/examples';
import { removeWorkflowStepInputV1 } from '@happier-dev/protocol/workflows/workflowComposerDocumentV1';
import { Platform, View } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

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

import {
  workflowIssuesForBlock,
  type WorkflowDraftValidation,
} from '@/sync/domains/workflows/workflowAuthoring';
import {
  collectWorkflowFieldIssueTexts,
  formatWorkflowIssueText,
} from './workflowIssueText';
import {
  withWorkflowAuthoringEngine,
  withWorkflowAuthoringEngineFields,
} from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
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
import {
  insertWorkflowEditorBlock,
  resolveSelectionAfterRemoval,
  type WorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowEditorDraft';

import {
  WorkflowAddBlockMenu,
  type WorkflowAddBlockRequest,
} from './WorkflowAddBlockMenu';
import { WorkflowActionBlockEditor } from './WorkflowActionBlockEditor';
import { WorkflowNestedWorkflowBlockEditor } from './WorkflowNestedWorkflowBlockEditor';
import { WorkflowWaitBlockEditor } from './WorkflowWaitBlockEditor';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowGroupEditor } from './WorkflowGroupEditor';
import { WorkflowLoopEditor } from './WorkflowLoopEditor';
import { WorkflowStepEditor } from './WorkflowStepEditor';
import {
  resolveWorkflowUnnamedHeading,
  workflowBlockReferenceLabel,
  workflowPromptFirstLine,
} from '@/sync/domains/workflows/workflowBlockLabel';
import { listWorkflowBlockOrdinalsV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';
import type { WorkflowSessionDrop } from './WorkflowStepSessionDropZone';
import {
  formatWorkflowConditionSentence,
  resolveWorkflowConditionHeadline,
} from '../presentation/workflowConditionPresentation';
import {
  WorkflowContainerBody,
  WorkflowContainerLane,
  WorkflowContainerOptionsControl,
  WorkflowSpineSegment,
  type WorkflowSpineReach,
} from './WorkflowContainerBody';
import { WorkflowReferenceSentence } from './WorkflowStepDataEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';

import {
  WorkflowBlockHeading,
  type WorkflowBlockNameEditor,
} from './WorkflowBlockHeading';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';
import { WorkflowBlockSummary, WORKFLOW_SUMMARY_ROW_ESTIMATE } from './WorkflowBlockSummary';
import {
  createWorkflowRowEngagement,
  useWorkflowRowReached,
  useWorkflowEditorRowsMountOnReach,
  type WorkflowRowEngagement,
} from './workflowRowEngagement';
import { duplicateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
  useWorkflowDocumentGridStyles, WorkflowDocumentGridContext, workflowEditorStyles,
} from './workflowEditorStyles';
import type { WorkflowDocumentPresentation } from './workflowDocumentPresentation';
import { WorkflowAgentChangeTint } from './WorkflowAgentChangeTint';
import { WorkflowRunWhenCaption } from './WorkflowRunWhenConnector';
import { projectWorkflowActionRowPresentation, type WorkflowActionRowPresentation } from './workflowActionRowPresentation';

export type {
  WorkflowDocumentPresentation,
  WorkflowDocumentStepSlots,
} from './workflowDocumentPresentation';

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
  /** Live custody for multiple edits before React publishes the next rendered draft. */
  readDraft?: () => WorkflowEditorDraft;
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
  onChange: (
    next: WorkflowEditorDraft,
    label?: string,
    committed?: boolean,
  ) => void;
  onCommitChange?: () => void;
  onSelect: (blockId: string | null) => void;
  /** Opens Step options for a block, anchored beside the control that asked. */
  /**
   * Opens a block's Step options from its control (`anchorRef`, where focus returns). A leaf block
   * also names its card region (`cardRef`), so the options sit beside the card without covering it.
   */
  onCustomize: (
    blockId: string,
    anchorRef: React.RefObject<View | null>,
    cardRef?: React.RefObject<View | null>,
  ) => void;
  /** A retained inspector owns its card refs when responsive layouts remount this document. */
  cardRefs?: React.RefObject<Map<string, React.RefObject<View | null>>>;
  /** The web Session drop target for Agent steps (J19); absent where no drag source exists. */
  sessionDrop?: WorkflowSessionDrop;
  registerPromptRef?: (blockId: string, focus: (() => void) | null) => void;
  requestPromptFocus?: (blockId: string) => void;
  /**
   * The block whose prompt the author is editing: only that row mounts the live composer, every
   * other prompt shows its static picture until it is activated (`onRequestEditBlock`). Absent,
   * every prompt is live (a reading host). Nested lists inherit both.
   */
  editingBlockId?: string | null;
  onRequestEditBlock?: (blockId: string) => void;
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

export function WorkflowBlockListEditor(
  props: WorkflowBlockListEditorProps,
): React.ReactElement {
  const grid = useWorkflowDocumentGridStyles();
  const {
    draft,
    list,
    blocks,
    depth,
    selectedBlockId,
    validation,
    registerPromptRef,
    requestPromptFocus,
  } = props;
  const owner = React.useRef(props);
  owner.current = props;
  const preferredLanguage = usePreferredLanguage();
  const testIDPrefix = props.testIDPrefix ?? 'workflow-editor';
  const editable = props.presentation?.editable !== false;
  const slotsFor = props.presentation?.step;
  const scopeLabel = props.scopeLabel ?? t('workflows.a11y.blockList');
  const composerScope = React.useMemo<AuthoringComposerScope>(
    () =>
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
          },
    [
      props.composerScope.kind,
      props.composerScope.serverId,
      props.composerScope.kind === 'session'
        ? props.composerScope.sessionId
        : props.composerScope.machineId,
      props.composerScope.kind === 'machine'
        ? props.composerScope.directory
        : undefined,
      props.composerScope.kind === 'machine'
        ? props.composerScope.machineHomeDir
        : undefined,
    ],
  );

  // One numbering for the whole document (lab E1): leaves 1…n in execution order, containers none.
  const visibleOrdinals = React.useMemo(
    () => listWorkflowBlockOrdinalsV1(draft.blocks),
    [draft.blocks],
  );
  const actionPresentations = React.useRef(new Map<string, WorkflowActionRowPresentation>());
  const nextActionPresentations = new Map<string, WorkflowActionRowPresentation>();
  for (const block of blocks) {
    if (block.kind !== 'action') continue;
    nextActionPresentations.set(block.id, projectWorkflowActionRowPresentation(draft, block, validation,
      editable && props.revealIssues !== false, actionPresentations.current.get(block.id)));
  }
  actionPresentations.current = nextActionPresentations;

  const addBlock = React.useCallback(
    (request: WorkflowAddBlockRequest, afterBlockId?: string) => {
      const current = owner.current;
      const insertion = insertWorkflowEditorBlock(current.readDraft?.() ?? current.draft, {
        request,
        list: current.list,
        ...(afterBlockId === undefined ? {} : { afterBlockId }),
      });
      current.onChange(insertion.draft);
      current.onSelect(insertion.block.id);
      if (insertion.block.kind === 'step' || insertion.block.kind === 'wait')
        current.requestPromptFocus?.(insertion.block.id);
    },
    [],
  );

  // On touch there is no hover: the inserters show while a block in this list is selected. Under a
  // precise pointer they show on hover or focus only, so a selection never leaves a hairline in
  // every gap of the document (DESIGN-4 P2).
  const selectedInList =
    selectedBlockId !== null &&
    blocks.some((block) => block.id === selectedBlockId);
  const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
  const revealInserters = touchPrimaryPointer && selectedInList;
  // The row of this list a pointer or the keyboard reached last; only it (and its gaps) mounts the
  // controls an unreached summary row leaves out (PERF-WF3B).
  const [engagement] = React.useState(createWorkflowRowEngagement);

  // A leaf block's row is its card; a container's row spans its whole body, so only its own control anchors.
  const localCardRefs = React.useRef(
    new Map<string, React.RefObject<View | null>>(),
  );
  const cardRefs = props.cardRefs ?? localCardRefs;
  const cardRefFor = React.useCallback(
    (blockId: string): React.RefObject<View | null> => {
      const existing = cardRefs.current.get(blockId);
      if (existing !== undefined) return existing;
      const created: React.RefObject<View | null> = React.createRef<View>();
      cardRefs.current.set(blockId, created);
      return created;
    },
    [cardRefs],
  );

  const rowContext = React.useMemo(
    () => ({
      composerScope,
      composerCustody: props.composerCustody,
      depth,
      listKind: list.kind,
      scopeLabel,
      editable,
      revealInserters,
      revealIssues: props.revealIssues,
      currentWorkflowRef: props.currentWorkflowRef,
      testIDPrefix,
      registerPromptRef,
      requestPromptFocus,
      onCommitChange: props.onCommitChange,
      requestEdit: props.onRequestEditBlock,
      cardRefFor,
      addBlock,
      preferredLanguage,
      engagement,
    }),
    [
      props.onRequestEditBlock,
      composerScope,
      props.composerCustody,
      depth,
      list.kind,
      scopeLabel,
      editable,
      revealInserters,
      props.revealIssues,
      props.currentWorkflowRef,
      testIDPrefix,
      registerPromptRef,
      requestPromptFocus,
      props.onCommitChange,
      cardRefFor,
      addBlock,
      preferredLanguage,
      engagement,
    ],
  );

  return (
    <View
      testID={`${testIDPrefix}-list-${list.kind}`}
      accessibilityRole="list"
      accessibilityLabel={scopeLabel}
      style={workflowEditorStyles.blockList}
    >
      {depth === 0 && props.presentation?.note !== undefined ? (
        typeof props.presentation.note === 'string' ||
        typeof props.presentation.note === 'number' ? (
          <Text
            style={[
              workflowEditorStyles.metaText,
              grid.listNote,
            ]}
          >
            {props.presentation.note}
          </Text>
        ) : (
          <View style={grid.listNote}>
            {props.presentation.note}
          </View>
        )
      ) : null}
      {blocks.map((block, index) => {
        // With an editing demand, a written prompt block that is neither selected nor being
        // edited is its one-line summary: a long workflow mounts one block editor, not one
        // per block (PERF-WF3). An empty prompt has nothing to summarise and keeps its composer.
        const summarized = (candidate: WorkflowBlock | undefined) =>
          candidate !== undefined &&
          props.editingBlockId !== undefined &&
          props.onRequestEditBlock !== undefined &&
          editable &&
          slotsFor === undefined &&
          (candidate.kind === 'step' || candidate.kind === 'wait') &&
          props.editingBlockId !== candidate.id &&
          selectedBlockId !== candidate.id;
        // A summary shows the written prompt (up to three lines at rest); an unwritten one keeps its composer.
        const summary =
          summarized(block) && (block.kind === 'step' || block.kind === 'wait')
            && workflowPromptFirstLine(block.document.text) !== null
            ? block.document.text.trim()
            : null;
        const waitIssue =
          (block.kind === 'wait' || summary !== null) &&
          editable &&
          props.revealIssues !== false
            ? workflowIssuesForBlock(validation, block.id, draft)[0]
            : undefined;
        // Wait cards and summaries read their own block. Only conditions require the
        // definition's reference labels; other block editors also consume
        // defaults and cross-step data, so retain that dependency.
        const definition =
          (block.kind === 'action' && selectedBlockId !== block.id) ||
          ((block.kind === 'wait' || (block.kind === 'step' && summary !== null)) &&
          block.onlyWhen === undefined)
            ? null
            : draft;
        const container =
          block.kind === 'parallel' ||
          block.kind === 'loop' ||
          block.kind === 'if';
        const leadingGap = index > 0 || (block.runWhen !== undefined && block.runWhen !== 'success');
        const row = (
          <WorkflowBlockListItem
            key={block.id}
            owner={owner}
            context={rowContext}
            {...(block.kind === 'step' || container
              ? {
                  authoringFacts: props.authoringFacts,
                  sessionDrop: props.sessionDrop,
                }
              : {})}
            {...(block.kind === 'action' || container
              ? { resolveActionFieldOptions: props.resolveActionFieldOptions }
              : {})}
            definition={definition}
            actionPresentation={block.kind === 'action' ? nextActionPresentations.get(block.id) : undefined}
            validation={definition === null ? null : validation}
            block={block}
            leadingGap={leadingGap}
            index={index}
            total={blocks.length}
            previousId={index > 0 ? blocks[index - 1]?.id : undefined}
            previousKind={index > 0 ? blocks[index - 1]?.kind : undefined}
            selected={selectedBlockId === block.id}
            editing={
              props.editingBlockId === undefined ||
              props.editingBlockId === block.id
            }
            nestedEditing={
              block.kind === 'parallel' ||
              block.kind === 'loop' ||
              block.kind === 'if'
                ? props.editingBlockId
                : undefined
            }
            nestedSelection={
              block.kind === 'parallel' ||
              block.kind === 'loop' ||
              block.kind === 'if'
                ? selectedBlockId
                : null
            }
            visibleOrdinal={visibleOrdinals.get(block.id) ?? null}
            evaluatorOrdinal={
              block.kind === 'loop' && block.repetition.kind === 'evaluate'
                ? (visibleOrdinals.get(block.repetition.evaluator.id) ?? null)
                : null
            }
            slots={slotsFor?.(block.id) ?? null}
            highlighted={props.highlightedBlockIds?.includes(block.id) === true}
            summary={summary}
            previousSummarized={index > 0 && summarized(blocks[index - 1])}
            waitIssue={
              waitIssue === undefined
                ? null
                : formatWorkflowIssueText(waitIssue, draft)
            }
          />
        );
        // Admit the whole prompt row at the existing visibility boundary, including its rail and
        // gap. Reached rows stay mounted; selection/editing also admits an offscreen focus target.
        return block.kind === 'step' || block.kind === 'wait' ? (
          <LazyMountOnScreen
            key={block.id}
            initiallyVisible={summary === null}
            placeholder={(
              <>
                {leadingGap ? <View style={grid.blockGap} /> : null}
                <View style={{ minHeight: WORKFLOW_SUMMARY_ROW_ESTIMATE[block.kind] }} />
              </>
            )}
          >
            {row}
          </LazyMountOnScreen>
        ) : row;
      })}

      {editable &&
      list.kind === 'root' &&
      !(props.rootAddRow === false && props.onUseExample === undefined) ? (
        <View
          style={blocks.length === 0 ? undefined : grid.listEnd}
        >
          <WorkflowAddBlockMenu
            composerScope={composerScope}
            examplesOnly={props.rootAddRow === false}
            onAdd={(request) =>
              addBlock(request, blocks[blocks.length - 1]?.id)
            }
            {...(props.onUseExample === undefined
              ? {}
              : { onUseExample: props.onUseExample })}
            {...(props.currentWorkflowRef === undefined
              ? {}
              : { currentWorkflowRef: props.currentWorkflowRef })}
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
  registerPromptRef: WorkflowBlockListEditorProps['registerPromptRef'];
  requestPromptFocus: WorkflowBlockListEditorProps['requestPromptFocus'];
  onCommitChange: WorkflowBlockListEditorProps['onCommitChange'];
  requestEdit: WorkflowBlockListEditorProps['onRequestEditBlock'];
  cardRefFor: (blockId: string) => React.RefObject<View | null>;
  addBlock: (request: WorkflowAddBlockRequest, afterBlockId?: string) => void;
  engagement: WorkflowRowEngagement;
}>;

/** A row receives changed display facts; edits always resolve against its live list owner. */
const WorkflowBlockListItem = React.memo(function WorkflowBlockListItem(
  row: Readonly<{
    owner: React.RefObject<WorkflowBlockListEditorProps>;
    context: WorkflowBlockListRowContext;
    definition: WorkflowEditorDraft | null;
    validation: WorkflowDraftValidation | null;
    actionPresentation?: WorkflowActionRowPresentation;
    block: WorkflowBlock;
    leadingGap: boolean;
    previousId: string | undefined;
    previousKind: WorkflowBlock['kind'] | undefined;
    index: number;
    total: number;
    selected: boolean;
    /** Whether this row's prompt is the one being edited (its live composer is mounted). */
    editing: boolean;
    /** A container's nested lists read the edited block, as `nestedSelection` carries the selected one. */
    nestedEditing: string | null | undefined;
    nestedSelection: string | null;
    visibleOrdinal: string | null;
    evaluatorOrdinal: string | null;
    slots:
      | import('./workflowDocumentPresentation').WorkflowDocumentStepSlots
      | null;
    highlighted: boolean;
    /** The written prompt while this block shows as its summary row; `null` mounts its editor. */
    summary: string | null;
    /** Whether the block before this one is a summary row too: then this gap's Add waits to be reached. */
    previousSummarized: boolean;
    /** The first issue of a Wait, or of a block shown as its summary. */
    waitIssue: string | null;
    /** Agent steps consume these facts; containers forward them to nested lists. */
    authoringFacts?: SessionAuthoringControlFacts;
    sessionDrop?: WorkflowSessionDrop;
    /** Action steps consume field options; containers forward them to nested lists. */
    resolveActionFieldOptions?: ResolveSessionActionFieldOptions;
  }>,
): React.ReactElement {
  const grid = useWorkflowDocumentGridStyles();
  const compactGrid = React.useContext(WorkflowDocumentGridContext) === 'compact';
  const props = row.owner.current;
  const draft = row.definition ?? props.draft;
  const validation = row.validation ?? props.validation;
  const { list, blocks } = props;
  const { block, index } = row;
  const {
    composerScope,
    depth,
    scopeLabel,
    editable,
    revealInserters,
    testIDPrefix,
    registerPromptRef,
    requestPromptFocus,
    cardRefFor,
    addBlock,
    requestEdit,
    engagement,
  } = row.context;
  // A summary row nobody has reached is its words (PERF-WF3B): its ⋯ rests as a mark and the Add
  // in the gap before it is not mounted until a pointer or the keyboard reaches this row or the one
  // before it. Reaching it mounts both in place, so Tab still walks name → ⋯ → the next gap's Add.
  const reached = useWorkflowRowReached(engagement, block.id, row.previousId);
  const rowsMountOnReach = useWorkflowEditorRowsMountOnReach();
  const restingRow =
    rowsMountOnReach && row.summary !== null && !reached.row;
  const restingGap =
    rowsMountOnReach &&
    row.summary !== null &&
    row.previousSummarized &&
    !reached.row &&
    !reached.previous &&
    !revealInserters;
  const reach = rowsMountOnReach
    ? {
        onMouseEnter: () => engagement.engage(block.id),
        onFocus: () => engagement.engage(block.id),
      }
    : undefined;
  const readDraft = () => row.owner.current.readDraft?.() ?? row.owner.current.draft;
  const onChange: WorkflowBlockListEditorProps['onChange'] = (...args) =>
    row.owner.current.onChange(...args);
  const onSelect: WorkflowBlockListEditorProps['onSelect'] = (...args) =>
    row.owner.current.onSelect(...args);
  const onCustomize: WorkflowBlockListEditorProps['onCustomize'] = (...args) =>
    row.owner.current.onCustomize(...args);
  const buildActions = (
    block: WorkflowBlock,
    index: number,
  ): readonly WorkflowBlockAction[] => {
    const actions: WorkflowBlockAction[] = [];
    if (!editable) return actions;
    actions.push({
      id: 'duplicate',
      label: t('common.duplicate'),
      onSelect: () => {
        const copy = duplicateWorkflowBlock(readDraft(), block.id);
        if (copy.blockId === null) return;
        onChange(copy.draft);
        onSelect(copy.blockId);
        if (block.kind === 'step' || block.kind === 'wait')
          requestPromptFocus?.(copy.blockId);
      },
    });
    if (index > 0) {
      actions.push({
        id: 'moveUp',
        label: t('workflows.editor.moveUp'),
        onSelect: () =>
          onChange(moveWorkflowBlock(readDraft(), block.id, 'up')),
      });
      const previous = blocks[index - 1];
      if (previous !== undefined && previous.kind !== 'step') {
        actions.push({
          id: 'moveIn',
          label: t('workflows.editor.moveIn'),
          onSelect: () =>
            onChange(moveWorkflowBlock(readDraft(), block.id, 'in')),
        });
      }
    }
    if (index < blocks.length - 1) {
      actions.push({
        id: 'moveDown',
        label: t('workflows.editor.moveDown'),
        onSelect: () =>
          onChange(moveWorkflowBlock(readDraft(), block.id, 'down')),
      });
    }
    if (list.kind !== 'root') {
      actions.push({
        id: 'moveOut',
        label: t('workflows.editor.moveOut'),
        onSelect: () =>
          onChange(moveWorkflowBlock(readDraft(), block.id, 'out')),
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
        onChange(
          removal.draft,
          t('workflows.editor.removedBlock', {
            block: workflowBlockReferenceLabel(block),
          }),
        );
        if (removal.removal !== null)
          row.owner.current.onBlockRemoved?.(removal.removal);
      },
    });
    return actions;
  };

  const customizeBlock = (
    block: WorkflowBlock,
    anchorRef: React.RefObject<View | null>,
  ) => {
    const leaf =
      block.kind === 'step' ||
      block.kind === 'action' ||
      block.kind === 'workflow' ||
      block.kind === 'wait';
    onCustomize(block.id, anchorRef, leaf ? cardRefFor(block.id) : undefined);
  };
  const nameEditorFor = (
    block: WorkflowBlock,
  ): WorkflowBlockNameEditor | undefined =>
    editable
      ? {
          value: block.name ?? '',
          placeholder: workflowBlockReferenceLabel(block),
          accessibilityLabel: `${t('common.rename')} · ${workflowBlockReferenceLabel(block)}`,
          onChangeText: (name) =>
            onChange(
              setWorkflowBlockName(readDraft(), block.id, name),
              t('workflows.editor.history.renameStep'),
              false,
            ),
          onCommit: props.onCommitChange,
        }
      : undefined;

  const ordinal = index + 1;
  const selected = row.selected;
  const actions = buildActions(block, index);
  const slots = row.slots;
  // A Wait for you has no composer-owned issue line; the page reveals its first issue here.
  // A typed card marks each offending row (DESIGN-6 P3).
  const blockIssues =
    (block.kind === 'wait' ||
      block.kind === 'action' ||
      block.kind === 'workflow') &&
    editable &&
    props.revealIssues !== false
      ? workflowIssuesForBlock(validation, block.id, draft)
      : [];
  const fieldIssues =
    row.actionPresentation?.fieldIssues ?? (block.kind === 'action' || block.kind === 'workflow'
      ? collectWorkflowFieldIssueTexts(blockIssues, draft)
      : undefined);
  // Blocks without a prompt still take the page's "focus the first issue" (DESIGN-6 P3).
  const focusRegistration =
    registerPromptRef === undefined || block.kind === 'step'
      ? undefined
      : (focus: (() => void) | null) => registerPromptRef(block.id, focus);

  const previous =
    row.previousId === undefined
      ? undefined
      : { id: row.previousId, kind: row.previousKind };
  const ifHeadline =
    block.kind === 'if'
      ? resolveWorkflowConditionHeadline(draft, block.when, editable ? 'authoring' : 'run')
      : null;
  const onlyWhenHeadline = !editable && block.kind !== 'if' && block.onlyWhen !== undefined
    ? resolveWorkflowConditionHeadline(draft, block.onlyWhen, 'run') : null;
  // A named If states its condition where its branch starts ("Only when …", lab round 1106 F1); an
  // unnamed one keeps the sentence as its title, so the condition is said once either way.
  const ifConditionOnLane =
    block.kind === 'if' && (block.name?.trim() ?? '') !== '';
  const ifSentence =
    block.kind === 'if' && ifHeadline !== null ? (
      <Text
        testID={`${testIDPrefix}-if-${block.id}-sentence`}
        accessibilityLabel={ifHeadline.unconditional === true ? ifHeadline.sentence : t(
          ifConditionOnLane
            ? 'workflows.page.inspector.onlyWhenSentence'
            : 'workflows.page.inspector.ifSentence',
          { condition: formatWorkflowConditionSentence(draft, block.when) },
        )}
      >
        <WorkflowReferenceSentence
          draft={draft}
          sentence={ifHeadline.unconditional === true ? ifHeadline.sentence : t(
            ifConditionOnLane
              ? 'workflows.page.inspector.onlyWhenSentence'
              : 'workflows.page.inspector.ifSentence',
            { condition: ifHeadline.sentence },
          )}
          references={ifHeadline.references}
        />
      </Text>
    ) : null;
  const isLast = index === blocks.length - 1;
  const spineReach: WorkflowSpineReach | null =
    list.kind === 'root'
      ? !isLast
        ? 'next'
        : block.kind === 'parallel' ||
            block.kind === 'loop' ||
            block.kind === 'if'
          ? 'end'
          : null
      : !isLast
        ? 'next'
        : editable
          ? 'endPastInserter'
          : 'end';
  // On a phone a leaf's card runs under its number (`blockCard`); its spine then links its end to the next mark.
  const cardUnderNumber = compactGrid && (block.kind === 'action' || block.kind === 'workflow'
    || (block.kind === 'step' && row.summary === null));
  const SummaryRowFrame = Platform.OS === 'web' ? View : React.Fragment;

  return (
    <React.Fragment key={block.id}>
      {/* The gap before a block is the list's rhythm, one row on the name column: a
                        non-default run-when caption ("If it fails"), and, editing, the inserter bound to
                        this exact position (lab: one Add, no per-list Add). Neither adds a band of its
                        own (DESIGN-7 M2); the default edge says nothing (lab E1). */}
      {row.leadingGap ? (
        <View
          testID={`${testIDPrefix}-gap-${block.id}`}
          style={grid.blockGap}
          {...reach}
        >
          <WorkflowRunWhenCaption
            value={block.runWhen}
            testID={`${testIDPrefix}-${block.id}-run-when`}
          />
          {editable && previous !== undefined && !restingGap ? (
            <View style={workflowEditorStyles.blockGapInserter}>
              <WorkflowAddBlockMenu
                composerScope={composerScope}
                variant="inserter"
                revealed={revealInserters}
                onAdd={(request) => addBlock(request, previous.id)}
                {...(props.currentWorkflowRef === undefined
                  ? {}
                  : { currentWorkflowRef: props.currentWorkflowRef })}
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
        testID={`${testIDPrefix}-${block.id}-block`}
        {...reach}
        // Each block is a real member of the ordered list, so
        // assistive technology can say "2 of 3" and move by item.
        // Position and set size are web ARIA; native reads the
        // same facts from the block heading's accessible name.
        role="listitem"
        {...(Platform.OS === 'web'
          ? { 'aria-posinset': ordinal, 'aria-setsize': blocks.length }
          : {})}
      >
        {/* The spine from this block's mark (lab round 1106 F1): to the next block's in its list, or,
            in a lane, down to where the lane joins back; a root list's last container keeps it
            through its lanes. */}
        {spineReach === null ? null : (
          <WorkflowSpineSegment
            reach={spineReach}
            fromBlockEnd={cardUnderNumber}
            testID={`${testIDPrefix}-${block.id}-spine`}
          />
        )}
        {/* Selection reads on the block's filled ordinal, never a grey plate behind its card (owner 2026-11-15). */}
        {/* The block and its condition line, one column: a sibling here must
                            never take width from the block's card. A container draws the rail. */}
        <View style={grid.blockColumn}>
          {row.summary !== null &&
          (block.kind === 'step' || block.kind === 'wait') ? (
            <SummaryRowFrame
              {...(Platform.OS === 'web' ? { style: { minHeight: WORKFLOW_SUMMARY_ROW_ESTIMATE[block.kind] } } : {})}
            >
              <WorkflowBlockSummary
              block={block}
              summary={row.summary}
              {...(block.kind === 'step' ? { draft } : {})}
              {...(row.authoringFacts === undefined ? {} : { authoringFacts: row.authoringFacts })}
              ordinal={ordinal}
              visibleOrdinal={row.visibleOrdinal}
              total={blocks.length}
              actions={actions}
              issue={row.waitIssue}
              inLane={list.kind !== 'root'}
              resting={restingRow}
              onSelect={onSelect}
              {...(registerPromptRef === undefined ? {} : { registerPromptRef })}
              {...(requestPromptFocus === undefined
                ? {}
                : { requestPromptFocus })}
              {...(row.sessionDrop === undefined
                ? {}
                : { sessionDrop: row.sessionDrop })}
              testIDPrefix={testIDPrefix}
            />
            </SummaryRowFrame>
          ) : null}

          {block.kind === 'step' && row.summary === null ? (
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
              onChangeDocument={(document) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'step'
                      ? { ...current, document }
                      : current,
                  ),
                  t('workflows.editor.history.document'),
                  false,
                )
              }
              onCommitDocument={props.onCommitChange}
              onCustomize={(anchorRef) => customizeBlock(block, anchorRef)}
              onChangeInput={(input) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'step'
                      ? { ...current, input: [...input] }
                      : current,
                  ),
                )
              }
              onRemoveInput={(index) => onChange(updateWorkflowBlock(readDraft(), block.id,
                (current) => current.kind === 'step' ? removeWorkflowStepInputV1(current, index) : current))}
              onChangeExecutionField={(field, value) =>
                onChange(
                  setWorkflowStepExecutionField(
                    readDraft(),
                    block.id,
                    field,
                    value,
                  ),
                )
              }
              onChangeExecutionFields={(fields) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'step'
                      ? {
                          ...current,
                          execution: withWorkflowAuthoringEngineFields(
                            current.execution ?? {},
                            fields,
                          ),
                        }
                      : current,
                  ),
                )
              }
              onChangeEngine={(engine) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'step'
                      ? {
                          ...current,
                          execution: withWorkflowAuthoringEngine(
                            current.execution ?? {},
                            engine,
                          ),
                        }
                      : current,
                  ),
                )
              }
              {...(row.authoringFacts === undefined
                ? {}
                : { authoringFacts: row.authoringFacts })}
              {...(registerPromptRef === undefined
                ? {}
                : { registerPromptRef })}
              editing={row.editing}
              {...(requestEdit === undefined
                ? {}
                : { onRequestEdit: () => requestEdit(block.id) })}
              editable={editable}
              slots={slots}
              {...(row.sessionDrop === undefined
                ? {}
                : { sessionDrop: row.sessionDrop })}
              revealIssues={props.revealIssues !== false}
              testIDPrefix={testIDPrefix}
            />
          ) : null}

          {block.kind === 'parallel' ? (
            <WorkflowGroupEditor
              nameEditor={nameEditorFor(block)}
              {...(focusRegistration === undefined
                ? {}
                : { focusRegistration })}
              block={block}
              ordinal={ordinal}
              selected={selected}
              actions={actions}
              headingAccessory={slots?.occurrenceSelector ?? slots?.state}
              onSelect={() => onSelect(block.id)}
              {...(editable
                ? {
                    onOpenOptions: (anchorRef: React.RefObject<View | null>) =>
                      customizeBlock(block, anchorRef),
                    onAddBranch: () =>
                      onChange(
                        updateWorkflowBlock(readDraft(), block.id, (current) =>
                          current.kind === 'parallel'
                            ? {
                                ...current,
                                branches: [
                                  ...current.branches,
                                  createWorkflowParallelBranch(
                                    collectWorkflowBlockIds(readDraft()),
                                  ),
                                ],
                              }
                            : current,
                        ),
                      ),
                    onRemoveBranch: (branchId: string) =>
                      onChange(
                        updateWorkflowBlock(readDraft(), block.id, (current) =>
                          current.kind !== 'parallel' ||
                          current.branches.length <= 1
                            ? current
                            : {
                                ...current,
                                branches: current.branches.filter(
                                  (branch) => branch.id !== branchId,
                                ),
                              },
                        ),
                      ),
                    onRenameBranch: (branchId: string, name: string) =>
                      onChange(
                        setWorkflowParallelBranchName(
                          readDraft(),
                          block.id,
                          branchId,
                          name,
                        ),
                        t('workflows.editor.history.renameLane'),
                        false,
                      ),
                    ...(props.onCommitChange === undefined
                      ? {}
                      : { onCommitRename: props.onCommitChange }),
                  }
                : {})}
              renderBranch={(branch, branchIndex) => (
                <WorkflowBlockListEditor
                  {...props}
                  list={{
                    kind: 'parallelBranch',
                    parallelId: block.id,
                    branchId: branch.id,
                  }}
                  blocks={branch.blocks}
                  depth={depth + 1}
                  scopeLabel={
                    branch.name ??
                    t('workflows.page.inspector.lane', {
                      position: branchIndex + 1,
                    })
                  }
                />
              )}
              testIDPrefix={testIDPrefix}
            />
          ) : null}

          {block.kind === 'loop' ? (
            <WorkflowLoopEditor
              nameEditor={nameEditorFor(block)}
              {...(focusRegistration === undefined
                ? {}
                : { focusRegistration })}
              draft={draft}
              block={block}
              ordinal={ordinal}
              selected={selected}
              actions={actions}
              headingAccessory={slots?.occurrenceSelector ?? slots?.state}
              onSelect={() => onSelect(block.id)}
              {...(editable
                ? {
                    onOpenOptions: (anchorRef: React.RefObject<View | null>) =>
                      customizeBlock(block, anchorRef),
                  }
                : {})}
              renderBody={() => (
                <WorkflowBlockListEditor
                  {...props}
                  list={{ kind: 'loopBody', loopId: block.id }}
                  blocks={block.body}
                  depth={depth + 1}
                  scopeLabel={t('workflows.editor.loopBody')}
                />
              )}
              renderContinuation={
                block.repetition.kind === 'evaluate'
                  ? () => {
                      const evaluator = (
                        block.repetition as Extract<
                          WorkflowRepetition,
                          { kind: 'evaluate' }
                        >
                      ).evaluator;
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
                            {...(editable
                              ? {
                                  onOpenOptions: (
                                    anchorRef: React.RefObject<View | null>,
                                  ) => onCustomize(evaluator.id, anchorRef),
                                }
                              : {})}
                            onSelect={() => onSelect(evaluator.id)}
                            onChangeBlock={(next) =>
                              onChange(
                                updateWorkflowBlock(
                                  readDraft(),
                                  evaluator.id,
                                  (current) =>
                                    current.kind === 'action' ? next : current,
                                ),
                              )
                            }
                            {...(row.resolveActionFieldOptions === undefined
                              ? {}
                              : {
                                  resolveFieldOptions:
                                    row.resolveActionFieldOptions,
                                })}
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
                          onChangeDocument={(document) =>
                            onChange(
                              updateWorkflowBlock(
                                readDraft(),
                                evaluator.id,
                                (current) =>
                                  current.kind === 'step'
                                    ? { ...current, document }
                                    : current,
                              ),
                              t('workflows.editor.history.document'),
                              false,
                            )
                          }
                          onCommitDocument={props.onCommitChange}
                          onCustomize={(anchorRef) =>
                            onCustomize(evaluator.id, anchorRef)
                          }
                          onChangeInput={(input) =>
                            onChange(
                              updateWorkflowBlock(
                                readDraft(),
                                evaluator.id,
                                (current) =>
                                  current.kind === 'step'
                                    ? { ...current, input: [...input] }
                                    : current,
                              ),
                            )
                          }
                          onRemoveInput={(index) => onChange(updateWorkflowBlock(readDraft(), evaluator.id,
                            (current) => current.kind === 'step' ? removeWorkflowStepInputV1(current, index) : current))}
                          {...(registerPromptRef === undefined
                            ? {}
                            : { registerPromptRef })}
                          editing={
                            props.editingBlockId === undefined ||
                            props.editingBlockId === evaluator.id
                          }
                          {...(requestEdit === undefined
                            ? {}
                            : {
                                onRequestEdit: () => requestEdit(evaluator.id),
                              })}
                          editable={editable}
                          testIDPrefix={testIDPrefix}
                        />
                      );
                    }
                  : undefined
              }
              testIDPrefix={testIDPrefix}
            />
          ) : null}

          {block.kind === 'action' ? (
            <WorkflowActionBlockEditor
              referenceLabels={row.actionPresentation?.referenceLabels}
              nameEditor={nameEditorFor(block)}
              composerScope={composerScope}
              block={block}
              {...(focusRegistration === undefined
                ? {}
                : { focusRegistration })}
              {...(fieldIssues === undefined ? {} : { fieldIssues })}
              {...(editable
                ? {
                    onOpenOptions: (anchorRef: React.RefObject<View | null>) =>
                      customizeBlock(block, anchorRef),
                  }
                : {})}
              draft={draft}
              ordinal={ordinal}
              visibleOrdinal={row.visibleOrdinal}
              selected={selected}
              total={blocks.length}
              actions={actions}
              onSelect={() => onSelect(block.id)}
              onChangeBlock={(next) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'action' ? next : current,
                  ),
                )
              }
              {...(row.resolveActionFieldOptions === undefined
                ? {}
                : { resolveFieldOptions: row.resolveActionFieldOptions })}
              editable={editable}
              slots={slots}
              testIDPrefix={testIDPrefix}
            />
          ) : null}

          {block.kind === 'workflow' ? (
            <WorkflowNestedWorkflowBlockEditor
              nameEditor={nameEditorFor(block)}
              {...(focusRegistration === undefined
                ? {}
                : { focusRegistration })}
              {...(fieldIssues === undefined ? {} : { fieldIssues })}
              block={block}
              {...(editable
                ? {
                    onOpenOptions: (anchorRef: React.RefObject<View | null>) =>
                      customizeBlock(block, anchorRef),
                  }
                : {})}
              draft={draft}
              ordinal={ordinal}
              visibleOrdinal={row.visibleOrdinal}
              selected={selected}
              total={blocks.length}
              actions={actions}
              onSelect={() => onSelect(block.id)}
              onChangeBlock={(next) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'workflow' ? next : current,
                  ),
                )
              }
              editable={editable}
              slots={slots}
              testIDPrefix={testIDPrefix}
            />
          ) : null}

          {block.kind === 'wait' && row.summary === null ? (
            <WorkflowWaitBlockEditor
              nameEditor={nameEditorFor(block)}
              {...(focusRegistration === undefined
                ? {}
                : { focusRegistration })}
              inLane={list.kind !== 'root'}
              block={block}
              {...(editable
                ? {
                    onOpenOptions: (anchorRef: React.RefObject<View | null>) =>
                      customizeBlock(block, anchorRef),
                  }
                : {})}
              ordinal={ordinal}
              visibleOrdinal={row.visibleOrdinal}
              selected={selected}
              total={blocks.length}
              actions={actions}
              composerScope={composerScope}
              composerCustody={props.composerCustody}
              issue={row.waitIssue}
              onSelect={() => onSelect(block.id)}
              onChangeBlock={(next) =>
                onChange(
                  updateWorkflowBlock(readDraft(), block.id, (current) =>
                    current.kind === 'wait' ? next : current,
                  ),
                )
              }
              editing={row.editing}
              {...(requestEdit === undefined
                ? {}
                : { onRequestEdit: () => requestEdit(block.id) })}
              editable={editable}
              slots={slots}
              testIDPrefix={testIDPrefix}
            />
          ) : null}

          {block.kind === 'if' && ifHeadline !== null ? (
            <View
              testID={`${testIDPrefix}-if-${block.id}`}
              style={workflowEditorStyles.blockBody}
            >
              <WorkflowBlockHeading
                nameEditor={nameEditorFor(block)}
                kindMark={
                  <Icon
                    name={WORKFLOW_BLOCK_KIND_GLYPH.if}
                    size={ICON_SIZE.xxs}
                  />
                }
                ordinal={ordinal}
                selected={selected}
                unnamed={resolveWorkflowUnnamedHeading(block)}
                displayName={workflowBlockReferenceLabel(block)}
                {...(focusRegistration === undefined
                  ? {}
                  : { focusRegistration })}
                {...(ifConditionOnLane ? {} : { meta: ifSentence })}
                // A bare chevron has no words to wrap with: it stays beside the row's menu, whatever the sentence does.
                accessory={
                  <>
                    {slots?.state}
                    <WorkflowContainerOptionsControl
                      optionsLabel={t('workflows.page.inspector.options')}
                      {...(editable
                        ? {
                            onOpenOptions: (
                              anchorRef: React.RefObject<View | null>,
                            ) => customizeBlock(block, anchorRef),
                          }
                        : {})}
                      testID={`${testIDPrefix}-if-${block.id}-summary`}
                    />
                  </>
                }
                actions={
                  editable && block.otherwise.length === 0
                    ? [
                        ...actions.filter((action) => action.id !== 'remove'),
                        {
                          id: 'addOtherwise',
                          label: t('workflows.editor.addOtherwise'),
                          onSelect: () => {
                            const insertion = insertWorkflowEditorBlock(
                              readDraft(),
                              {
                                request: { kind: 'step' },
                                list: { kind: 'ifOtherwise', ifId: block.id },
                              },
                            );
                            onChange(insertion.draft);
                            onSelect(insertion.block.id);
                            requestPromptFocus?.(insertion.block.id);
                          },
                        },
                        ...actions.filter((action) => action.id === 'remove'),
                      ]
                    : actions
                }
                onSelect={() => onSelect(block.id)}
                testID={`${testIDPrefix}-if-${block.id}-label`}
                actionsTestID={`${testIDPrefix}-if-${block.id}-actions`}
              />
              <WorkflowContainerBody>
                <WorkflowContainerLane
                  label={t('workflows.editor.ifTrue')}
                  {...(ifConditionOnLane
                    ? {
                        content: ifSentence,
                        labelAccessibilityLabel: `${t('workflows.page.inspector.options')}: ${formatWorkflowConditionSentence(draft, block.when)}`,
                        ...(editable
                          ? {
                              onPressLabel: (
                                anchorRef: React.RefObject<View | null>,
                              ) => customizeBlock(block, anchorRef),
                            }
                          : {}),
                      }
                    : {})}
                  labelTestID={`${testIDPrefix}-if-${block.id}-then-label`}
                >
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
                  <WorkflowContainerLane
                      label={t('workflows.editor.otherwise')}
                    labelTestID={`${testIDPrefix}-if-${block.id}-otherwise-label`}
                  >
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
              {onlyWhenHeadline?.unconditional === true ? onlyWhenHeadline.sentence : t('workflows.page.inspector.onlyWhenSentence', {
                condition: row.actionPresentation?.condition ?? formatWorkflowConditionSentence(
                  draft,
                  block.onlyWhen,
                ),
              })}
            </Text>
          ) : null}
        </View>
        {row.highlighted ? (
          <WorkflowAgentChangeTint blockId={block.id} />
        ) : null}
      </View>
      {/* A nested list's last gap appends there; the root's end row adds after its last block. */}
      {editable && index === blocks.length - 1 && list.kind !== 'root' ? (
        <View style={grid.laneEndInserter}>
        <WorkflowAddBlockMenu
          composerScope={composerScope}
          variant="inserter"
          revealed={revealInserters}
          onAdd={(request) => addBlock(request, block.id)}
          {...(props.currentWorkflowRef === undefined
            ? {}
            : { currentWorkflowRef: props.currentWorkflowRef })}
          scopeLabel={scopeLabel}
          testID={`${testIDPrefix}-add-${list.kind}`}
        />
        </View>
      ) : null}
    </React.Fragment>
  );
});
