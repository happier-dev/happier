import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { findWorkflowBlock, setWorkflowFinalOutput } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import type { SessionPlacementChipTrigger } from '@/components/sessions/new/placement/SessionPlacementChips';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { t } from '@/text';

import { addWorkflowEditorBlock } from '../editor/WorkflowBlockListEditor';
import { WorkflowAddBlockMenu } from '../editor/WorkflowAddBlockMenu';
import { WorkflowFinalOutputEditor } from '../editor/WorkflowFinalOutputEditor';
import { WorkflowProjectTargetControl } from '../editor/WorkflowProjectTargetControl';
import {
  useWorkflowEditorSelector,
  type WorkflowEditorDraftStore,
} from '../editor/workflowEditorDraftStore';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '../presentation/workflowBlockKindGlyph';
import { formatWorkflowSummaryStepName } from '../presentation/workflowSummaryLine';
import { formatWorkflowConditionSentence } from '../presentation/workflowConditionPresentation';
import {
  WorkflowSentenceChip,
  WorkflowSentenceWord,
  WorkflowSentenceUnit,
} from './WorkflowSentenceChip';
import { workflowSentenceStyles } from './workflowSentenceStyles';

/** What the sentence's one card shows: a step's own card, or the How card (Workflow options). */
type WorkflowSentenceCard = 'step' | 'options';

export type WorkflowSentenceViewProps = Readonly<{
  draftStore: WorkflowEditorDraftStore;
  onChange: (
    next: WorkflowEditorDraft,
    label?: string,
    committed?: boolean,
  ) => void;
  documentEditable: boolean;
  /** The editor's one selection, shared with Steps and Flow. */
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string | null) => void;
  requestPromptFocus?: (blockId: string) => void;
  /** The trigger owner's When clause (`WorkflowTriggerSection` presentation `sentence`). */
  whenClause?: React.ReactNode;
  /** Where it runs: the How card's Machine and folder owner. */
  place: Readonly<{
    target: WorkflowAuthoringTarget | null | undefined;
    machineName: string | null;
    machines?: readonly Machine[];
    accountLifetime?: ServerAccountScopeLifetime | null;
    onChange?: (target: WorkflowAuthoringTarget) => void;
  }>;
  composerScope?: AuthoringComposerScope;
  currentWorkflowRef?: string | null;
  /** The selected step's own card: the block list's row for that block. */
  renderStepCard: (blockId: string) => React.ReactNode;
  /** The How card as the one card. Absent (an "Automate this…" host): no Workflow options chip. */
  renderOptionsCard?: () => React.ReactNode;
  /**
   * A one-step host ("Automate this…", D10): what the workflow does, as one verb chip. It leads the line
   * its Machine and folder finish ("run a command on ⟨Machine⟩ in ⟨folder⟩") and replaces the step list
   * and the Result clause, which belong to the editor.
   */
  verbClause?: React.ReactNode;
  testIDPrefix: string;
}>;

const readBlocks = (draft: WorkflowEditorDraft) => draft.blocks;
const readDefaultAgent = (draft: WorkflowEditorDraft) =>
  draft.defaults.agentTarget;

/**
 * The Sentence view (round 1116c): the whole workflow as one sentence, one clause per line, and one card
 * under it. It holds no workflow state: each chip opens the picker its row opens in the When or How card,
 * each step chip selects the editor's one selection, and the card is the step's own card from the block
 * list. Hosts: the editor's third view, and "Automate this…" on a new draft.
 */
export function WorkflowSentenceView(
  props: WorkflowSentenceViewProps,
): React.ReactElement {
  const blocks = useWorkflowEditorSelector(props.draftStore, readBlocks);
  // One identity for the page's writer, so the memoized clauses stay still when a step is selected.
  const onChange = useEventCallback(props.onChange);
  const [card, setCard] = React.useState<WorkflowSentenceCard>('step');
  // A nested selection keeps its containing card shown; the editor's selection stays on the child.
  const selectedBlockId = props.selectedBlockId;
  const shownBlockId = (selectedBlockId === null ? undefined : blocks.find(
    (block) => findWorkflowBlock({ blocks: [block] }, selectedBlockId) !== null,
  ))?.id ?? blocks[0]?.id ?? null;
  const { onSelectBlock } = props;
  // Opening the view (or removing the selected step) selects the step it shows, in the editor's one selection:
  // its card is then the live selected row, and Steps and Flow show the same step.
  const selectionShown = selectedBlockId !== null
    && blocks.some((block) => findWorkflowBlock({ blocks: [block] }, selectedBlockId) !== null);
  const firstBlockId = blocks[0]?.id ?? null;
  React.useEffect(() => {
    if (!selectionShown && firstBlockId !== null) onSelectBlock(firstBlockId);
  }, [selectionShown, firstBlockId, onSelectBlock]);
  const selectStep = React.useCallback(
    (blockId: string) => {
      setCard('step');
      onSelectBlock(blockId);
    },
    [onSelectBlock],
  );
  const optionsShown =
    card === 'options' && props.renderOptionsCard !== undefined;
  const cardKey = optionsShown ? 'options' : shownBlockId;
  // Workflow options trails the sentence's final clause: the Result, or "Add a first step" before there is one.
  const optionsChip = props.renderOptionsCard === undefined ? null : (
    <WorkflowSentenceChip
      key="options"
      kind="add"
      icon="sliders-horizontal"
      label={t('workflows.sentence.workflowOptions')}
      selected={optionsShown}
      onPress={() => setCard(optionsShown ? 'step' : 'options')}
      testID={`${props.testIDPrefix}-sentence-options`}
    />
  );
  return (
    <View testID={`${props.testIDPrefix}-sentence`}>
      <View
        accessibilityRole="none"
        accessibilityLabel={t('workflows.sentence.a11y')}
        style={workflowSentenceStyles.sentence}
      >
        {props.whenClause ?? (
          <View style={workflowSentenceStyles.line}>
            <WorkflowSentenceWord>{t('workflows.triggers.card.manualSentence')}</WorkflowSentenceWord>
          </View>
        )}
        <View
          style={workflowSentenceStyles.line}
          testID={`${props.testIDPrefix}-sentence-where`}
        >
          {props.verbClause}
          <WorkflowSentencePlace
            {...props.place}
            testIDPrefix={props.testIDPrefix}
          />
        </View>
        {props.verbClause !== undefined ? null : <WorkflowSentenceSteps
          blocks={blocks}
          shownBlockId={optionsShown ? null : shownBlockId}
          onSelectStep={selectStep}
          {...props}
          trailing={blocks.length === 0 ? optionsChip : null}
        />}
        {blocks.length === 0 || props.verbClause !== undefined ? null : (
          <View
            style={workflowSentenceStyles.line}
            testID={`${props.testIDPrefix}-sentence-result`}
          >
            <WorkflowSentenceUnit word={t('workflows.sentence.reports')}>
              <WorkflowSentenceResult
                draftStore={props.draftStore}
                onChange={onChange}
                editable={props.documentEditable}
                testIDPrefix={props.testIDPrefix}
              />
            </WorkflowSentenceUnit>
            {optionsChip}
          </View>
        )}
      </View>
      {cardKey === null ? null : (
        <WorkflowSentenceCardRegion
          key={cardKey}
          testID={`${props.testIDPrefix}-sentence-selection`}
        >
          {optionsShown
            ? props.renderOptionsCard?.()
            : shownBlockId === null
              ? null
              : props.renderStepCard(shownBlockId)}
        </WorkflowSentenceCardRegion>
      )}
    </View>
  );
}

/**
 * "on ⟨Machine⟩ in ⟨folder⟩": the How card's Where owner, drawing its two triggers as sentence chips.
 * Memoized, so selecting another step re-renders the card, never the placement chips.
 */
const WorkflowSentencePlace = React.memo(function WorkflowSentencePlace(
  props: WorkflowSentenceViewProps['place'] &
    Readonly<{ testIDPrefix: string }>,
) {
  const renderChip = React.useCallback(
    (chip: SessionPlacementChipTrigger) => (
      <WorkflowSentenceUnit
        key={chip.field}
        word={
          chip.field === 'machine'
            ? t('workflows.sentence.on')
            : t('workflows.sentence.in')
        }
        rowLabel={
          chip.field === 'machine'
            ? t('workflows.sentence.rows.machine')
            : t('workflows.sentence.rows.folder')
        }
      >
        <WorkflowSentenceChip
          anchorRef={chip.anchorRef}
          kind={chip.value === null ? 'placeholder' : 'option'}
          icon={chip.field === 'machine' ? 'laptop' : 'folder'}
          mono={chip.field === 'folder' && chip.value !== null}
          title={chip.title}
          label={
            chip.value ??
            (chip.field === 'machine'
              ? t('workflows.sentence.chooseMachine')
              : t('workflows.sentence.aFolder'))
          }
          open={chip.open}
          disabled={chip.disabled}
          hasPopup="dialog"
          onPress={chip.onPress}
          testID={`${props.testIDPrefix}-sentence-${chip.field}`}
        />
      </WorkflowSentenceUnit>
    ),
    [props.testIDPrefix],
  );
  return (
    <WorkflowProjectTargetControl
      accountLifetime={props.accountLifetime}
      purpose="workflow"
      presentation="sentence"
      renderChip={renderChip}
      target={props.target}
      machineName={props.machineName}
      {...(props.machines === undefined ? {} : { machines: props.machines })}
      {...(props.onChange === undefined ? {} : { onChange: props.onChange })}
      testIDPrefix={`${props.testIDPrefix}-sentence`}
    />
  );
});

/**
 * "⟨step⟩ then ⟨step⟩ ⟨+ Add another step⟩": one chip per top-level block, named as the summary line names it.
 * An `if` block is a clause of its own, "if ⟨condition⟩ → ⟨then steps⟩" and "otherwise → ⟨otherwise steps⟩":
 * its condition chip opens the If block's own card (where its condition is edited once), each branch chip selects its step.
 */
function WorkflowSentenceSteps(
  props: WorkflowSentenceViewProps &
    Readonly<{
      blocks: readonly WorkflowBlock[];
      shownBlockId: string | null;
      onSelectStep: (blockId: string) => void;
      /** What closes the steps clause when it is the sentence's last (Workflow options before any step). */
      trailing: React.ReactNode;
    }>,
) {
  const presentEngine = useRoleEnginePresentation(
    props.place.accountLifetime?.scope.serverId,
  );
  const defaultAgent = useWorkflowEditorSelector(
    props.draftStore,
    readDefaultAgent,
  );
  const { draftStore, onChange, onSelectBlock, requestPromptFocus, blocks } =
    props;
  const add = React.useCallback(
    (request: Parameters<typeof addWorkflowEditorBlock>[0]['request']) => {
      addWorkflowEditorBlock({
        draft: draftStore.get(),
        list: { kind: 'root' },
        request,
        ...(blocks.length === 0
          ? {}
          : { afterBlockId: blocks[blocks.length - 1]!.id }),
        onChange,
        onSelect: onSelectBlock,
        ...(requestPromptFocus === undefined ? {} : { requestPromptFocus }),
      });
    },
    [blocks, draftStore, onChange, onSelectBlock, requestPromptFocus],
  );
  // A conditional reads as its own clause (Reviews lab prauto-sentence): "if ⟨condition⟩ → ⟨then…⟩", then
  // "otherwise → ⟨otherwise…⟩" on the next line. Only a draft with an `if` reads the whole draft for its words.
  const conditionalDraft = useWorkflowEditorSelector(props.draftStore, readConditionalDraft);
  const stepChip = (block: WorkflowBlock, selected: boolean) => {
    const agentTarget =
      block.kind === 'step' ? (block.agentTarget ?? defaultAgent) : undefined;
    const mark =
      agentTarget == null
        ? null
        : presentEngine(
            { agentTargetKey: resolveBackendTargetKeyV2(agentTarget) },
            ICON_SIZE.xs,
          ).icon;
    return (
      <WorkflowSentenceChip
        kind="step"
        label={formatWorkflowSummaryStepName(block)}
        {...(mark === null
          ? { icon: WORKFLOW_BLOCK_KIND_GLYPH[block.kind] }
          : { mark })}
        selected={selected}
        onPress={() => props.onSelectStep(block.id)}
        testID={`${props.testIDPrefix}-sentence-step:${block.id}`}
      />
    );
  };
  // A branch's own steps: the first follows its lead word, the rest read "then". The editor's one selection
  // marks the step it names; the card under the sentence stays the containing step's own card.
  const branch = (steps: readonly WorkflowBlock[], lead: string) =>
    steps.map((step, index) => (
      <WorkflowSentenceUnit
        key={step.id}
        word={index === 0 ? lead : t('workflows.sentence.then')}
      >
        {stepChip(step, props.shownBlockId !== null && props.selectedBlockId === step.id)}
      </WorkflowSentenceUnit>
    ));
  const lines: React.ReactNode[][] = [[]];
  blocks.forEach((block, index) => {
    if (block.kind !== 'if' || conditionalDraft === null) {
      const line = lines[lines.length - 1]!;
      const chip = stepChip(block, block.id === props.shownBlockId);
      line.push(
        index === 0 ? (
          <React.Fragment key={block.id}>{chip}</React.Fragment>
        ) : (
          <WorkflowSentenceUnit key={block.id} word={t('workflows.sentence.then')}>
            {chip}
          </WorkflowSentenceUnit>
        ),
      );
      return;
    }
    if (lines[lines.length - 1]!.length > 0) lines.push([]);
    const shown = block.id === props.shownBlockId;
    lines[lines.length - 1]!.push(
      <WorkflowSentenceUnit key={block.id} word={t('workflows.sentence.if')}>
        <WorkflowSentenceChip
          // It selects the If's own card, so it carries the step chips' selection.
          kind="step"
          icon={WORKFLOW_BLOCK_KIND_GLYPH.if}
          title={t('workflows.editor.unnamedIf')}
          label={formatWorkflowConditionSentence(conditionalDraft, block.when)}
          selected={shown && (props.selectedBlockId === null || props.selectedBlockId === block.id)}
          onPress={() => props.onSelectStep(block.id)}
          testID={`${props.testIDPrefix}-sentence-if:${block.id}`}
        />
      </WorkflowSentenceUnit>,
      ...branch(block.then, t('workflows.sentence.leadsTo')),
    );
    if (block.otherwise.length > 0) {
      lines.push(branch(block.otherwise, t('workflows.sentence.otherwise')));
    }
    // What follows the conditional starts its own line.
    lines.push([]);
  });
  const addStep = props.documentEditable ? (
    <WorkflowAddBlockMenu
      key="add-step"
      onAdd={add}
      scopeLabel={t('workflows.a11y.blockList')}
      {...(props.composerScope === undefined
        ? {}
        : { composerScope: props.composerScope })}
      {...(props.currentWorkflowRef === undefined
        ? {}
        : { currentWorkflowRef: props.currentWorkflowRef })}
      renderTrigger={({ open, toggle, anchorRef }) => (
        <WorkflowSentenceChip
          anchorRef={anchorRef}
          kind="add"
          icon="plus"
          selected={open}
          hasPopup="menu"
          label={
            blocks.length === 0
              ? t('workflows.sentence.addFirstStep')
              : t('workflows.sentence.addAnotherStep')
          }
          onPress={toggle}
          testID={`${props.testIDPrefix}-sentence-add-step`}
        />
      )}
      testID={`${props.testIDPrefix}-sentence-add-step-menu`}
    />
  ) : null;
  // Add another step closes the last clause (lab: after the otherwise branch), never a line of its own.
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  if (addStep !== null) lines[lines.length - 1]!.push(addStep);
  if (props.trailing !== null) lines[lines.length - 1]!.push(props.trailing);
  if (lines.length === 1) {
    return (
      <View
        style={workflowSentenceStyles.line}
        testID={`${props.testIDPrefix}-sentence-steps`}
      >
        {lines[0]}
      </View>
    );
  }
  return (
    <View
      style={workflowSentenceStyles.sentence}
      testID={`${props.testIDPrefix}-sentence-steps`}
    >
      {lines.map((line, index) => (
        <View key={index} style={workflowSentenceStyles.line}>
          {line}
        </View>
      ))}
    </View>
  );
}

const readConditionalDraft = (draft: WorkflowEditorDraft) =>
  draft.blocks.some((block) => block.kind === 'if') ? draft : null;

/** "→ reports ⟨…⟩": the page-foot Result's owner, as a chip. */
const WorkflowSentenceResult = React.memo(function WorkflowSentenceResult(
  props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    onChange: (next: WorkflowEditorDraft) => void;
    editable: boolean;
    testIDPrefix: string;
  }>,
) {
  const draft = useWorkflowEditorSelector(props.draftStore, readWholeDraft);
  const { draftStore, onChange } = props;
  return (
    <WorkflowFinalOutputEditor
      draft={draft}
      editable={props.editable}
      presentation="chip"
      onChange={(finalOutput) =>
        onChange(setWorkflowFinalOutput(draftStore.get(), finalOutput))
      }
      testIDPrefix={`${props.testIDPrefix}-sentence-result`}
    />
  );
});
const readWholeDraft = (draft: WorkflowEditorDraft) => draft;

const CARD_FADE_MS = 120;

/**
 * The one card: on each new subject it fades in with a short rise (lab 1116c "Motion"), on the compositor;
 * reduced motion shows it at once. A new subject remounts the region (its `key`), which interrupts any fade.
 */
function WorkflowSentenceCardRegion(
  props: Readonly<{ children: React.ReactNode; testID: string }>,
) {
  const reducedMotion = useReducedMotionPreference();
  const { theme } = useUnistyles();
  const shown = useSharedValue(reducedMotion ? 1 : 0);
  React.useEffect(() => {
    if (!reducedMotion) shown.value = withTiming(1, { duration: CARD_FADE_MS });
  }, [reducedMotion, shown]);
  const rise = theme.space.s6;
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * rise }],
  }));
  return (
    <Animated.View testID={props.testID} style={[styles.card, style]}>
      {props.children}
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.space.s24,
  },
}));
