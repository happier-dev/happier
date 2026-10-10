import { collectWorkflowBlockIds, copyWorkflowBlocks, createWorkflowBlock, createWorkflowLeafBlock, findWorkflowBlockListRef, getWorkflowBlockList, insertWorkflowBlock, resolvePreviousResultInputForInsertion, type WorkflowBlockKind, type WorkflowBlockListRef, type WorkflowLeafBlockSeed, type WorkflowDefinitionDraftV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowBlock, WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { WorkflowStarterExampleSelection, WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';

export type WorkflowEditorDraft = WorkflowDefinitionDraftV1 & Readonly<{ draftId: string }>;

/** Every editor Add entry point uses the same scope-aware creation and previous-result default. */
export function insertWorkflowEditorBlock(draft: WorkflowEditorDraft, params: Readonly<{
  request: Readonly<{ kind: WorkflowBlockKind }> | WorkflowLeafBlockSeed;
  list: WorkflowBlockListRef;
  afterBlockId?: string;
}>): Readonly<{ draft: WorkflowEditorDraft; block: WorkflowBlock }> {
  const { request, list, afterBlockId } = params;
  const takenIds = collectWorkflowBlockIds(draft);
  const created = request.kind === 'action' || request.kind === 'workflow' || request.kind === 'wait'
    ? createWorkflowLeafBlock(request, takenIds)
    : createWorkflowBlock(request.kind, takenIds);
  const position = { list, ...(afterBlockId === undefined ? {} : { afterBlockId }) };
  const previousResult = created.kind === 'step' ? resolvePreviousResultInputForInsertion(draft, position) : null;
  const block: WorkflowBlock = previousResult === null || created.kind !== 'step'
    ? created : { ...created, input: [previousResult] };
  return { draft: insertWorkflowBlock(draft, { ...position, block }), block };
}

export type WorkflowEditorViewState = Readonly<{
  /** The one selected block, shared by Steps, Flow and the inspector. */
  selectedBlockId: string | null;
  /** Blocks whose controls or bodies the author collapsed. Collapse never discards values. */
  collapsedBlockIds: ReadonlySet<string>;
  /**
   * Settings groups the person opened or closed themselves (04 §5.2). Absent
   * groups follow the inspector's open rule; a recorded choice lasts for the
   * draft's lifetime and is never written into the definition.
   */
  inspectorGroupDisclosure: ReadonlyMap<string, boolean>;
}>;

export const EMPTY_WORKFLOW_EDITOR_VIEW_STATE: WorkflowEditorViewState = {
  selectedBlockId: null,
  collapsedBlockIds: new Set<string>(),
  inspectorGroupDisclosure: new Map<string, boolean>(),
};

export function createWorkflowEditorDraft(params: Readonly<{
  draftId: string;
  name?: string;
  defaults?: WorkflowStepExecutionSelection;
  blocks?: readonly WorkflowBlock[];
}>): WorkflowEditorDraft {
  const blocks = params.blocks ?? [createWorkflowBlock('step', new Set<string>())];
  return {
    draftId: params.draftId,
    name: params.name ?? '',
    inputs: [],
    defaults: params.defaults ?? {},
    blocks,
  };
}

export type WorkflowStarterExampleInsertion = Readonly<{
  draft: WorkflowEditorDraft;
  before: WorkflowEditorDraft;
  rootIds: readonly string[];
  inputNames: readonly string[];
  replacedPlaceholder: boolean;
  trigger?: AutomationTriggerDefinitionInput;
  sessionTarget?: WorkflowStarterSessionTarget;
}>;

/** J12: an example is one editor change, with its references kept inside its own copied blocks. */
export function insertWorkflowStarterExample(
  draft: WorkflowEditorDraft,
  example: WorkflowStarterExampleSelection,
  title?: string,
): WorkflowStarterExampleInsertion {
  if (example.triggerSeed !== undefined && example.trigger === undefined) throw new Error('workflow_starter_requires_session');
  const definition = example.definition;
  const takenIds = new Set(collectWorkflowBlockIds(draft));
  const takenInputs = new Set(draft.inputs.map((input) => input.name));
  const unique = (name: string, taken: Set<string>, separator: string) => {
    let next = name;
    for (let suffix = 2; taken.has(next); suffix += 1) next = `${name}${separator}${suffix}`;
    taken.add(next);
    return next;
  };
  const inputs = new Map(definition.inputs.map((input) => [input.name, unique(input.name, takenInputs, '_')]));
  const { blocks, remapResult } = copyWorkflowBlocks(definition.blocks, takenIds, inputs);
  const replacedPlaceholder = draft.finalOutput === undefined && draft.blocks.length === 1
    && pluginJsonValuesEqual(draft.blocks[0], createWorkflowBlock('step', new Set<string>()));
  let next = { ...draft, blocks: replacedPlaceholder ? [] : draft.blocks,
    inputs: [...draft.inputs, ...definition.inputs.map((input) => ({ ...input, name: inputs.get(input.name)! }))] };
  for (const block of blocks) next = insertWorkflowBlock(next, { list: { kind: 'root' }, block });
  const projected: WorkflowEditorDraft = { ...next,
    ...(draft.name.length === 0 && title !== undefined ? { name: title } : {}),
    ...(draft.finalOutput === undefined && definition.finalOutput !== undefined ? { finalOutput: remapResult(definition.finalOutput) } : {}),
  };
  return { draft: projected, before: draft, rootIds: blocks.map((block) => block.id), inputNames: [...inputs.values()], replacedPlaceholder,
    ...(example.trigger === undefined ? {} : { trigger: example.trigger }),
    ...(example.sessionTarget === undefined ? {} : { sessionTarget: example.sessionTarget }) };
}

export function selectWorkflowBlock(
  view: WorkflowEditorViewState,
  blockId: string | null,
): WorkflowEditorViewState {
  return view.selectedBlockId === blockId ? view : { ...view, selectedBlockId: blockId };
}

export function toggleWorkflowBlockCollapsed(
  view: WorkflowEditorViewState,
  blockId: string,
): WorkflowEditorViewState {
  const next = new Set(view.collapsedBlockIds);
  if (next.has(blockId)) next.delete(blockId); else next.add(blockId);
  return { ...view, collapsedBlockIds: next };
}

export function setWorkflowInspectorGroupExpanded(
  view: WorkflowEditorViewState,
  groupId: string,
  expanded: boolean,
): WorkflowEditorViewState {
  if (view.inspectorGroupDisclosure.get(groupId) === expanded) return view;
  const next = new Map(view.inspectorGroupDisclosure);
  next.set(groupId, expanded);
  return { ...view, inspectorGroupDisclosure: next };
}

/**
 * After a removal, focus must land on a surviving meaningful control rather
 * than disappearing. Prefer the following sibling, then the previous one, then
 * the enclosing container.
 */
export function resolveSelectionAfterRemoval(params: Readonly<{
  draftBeforeRemoval: WorkflowEditorDraft;
  removedBlockId: string;
}>): string | null {
  const listRef = findWorkflowBlockListRef(params.draftBeforeRemoval, params.removedBlockId);
  if (listRef === null) return null;
  const siblings = getWorkflowBlockList(params.draftBeforeRemoval, listRef) ?? [];
  const index = siblings.findIndex((block) => block.id === params.removedBlockId);
  const next = siblings[index + 1] ?? siblings[index - 1];
  if (next !== undefined) return next.id;
  switch (listRef.kind) {
    case 'root':
      return null;
    case 'loopBody':
      return listRef.loopId;
    case 'ifThen':
    case 'ifOtherwise':
      return listRef.ifId;
    case 'parallelBranch':
      return listRef.parallelId;
  }
}
