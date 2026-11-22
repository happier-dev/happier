import { REVIEW_START_ACTION_ID_V1 } from '../actions/actionIds.js';
import { ReviewScopeSchema, type ReviewScope } from '../reviews/scope.js';
import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowStep } from './workflowV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { walkWorkflowBlocks } from './workflowV1.js';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { resolveWorkflowStepSelectionV1 } from './workflowStepSelectionV1.js';
import type { TriggerTargetV1 } from './triggers/triggerTargetV1.js';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '../machines/managed/actionIdsV1.js';

/** Executable trigger sets retain this storage label; it is never an authored display name. */
export const WORKFLOW_TRIGGER_SET_STORAGE_NAME = 'Workflow triggers';

const DEFAULT_TRIGGER_THEN_LABELS = { runWorkflow: 'Run a workflow', sendPrompt: 'Send a prompt', notifyMe: 'Notify me', doAction: 'Do an action' };

function workflowExecutableLeafDefaultLabel(kind: 'step' | 'wait' | 'action' | 'workflow', labels = DEFAULT_TRIGGER_THEN_LABELS): string {
  switch (kind) {
    case 'step': return 'Agent step';
    case 'wait': return 'Wait for you';
    case 'action': return labels.doAction;
    case 'workflow': return labels.runWorkflow;
  }
}

/** One name rule for the Account Library projection, its presenters and trigger-started Runs. */
export function workflowTriggerDisplayNameV1(input: Readonly<{ name?: string; target?: TriggerTargetV1 }>, presentation?: Readonly<{
  then: Readonly<Record<'runWorkflow' | 'sendPrompt' | 'notifyMe' | 'doAction', string>>;
  block: (block: WorkflowBlock) => string;
  empty: string;
  resolveWorkflowTitle: (ref: string) => string | null;
}>): string | undefined {
  if (input.name !== undefined && input.name !== WORKFLOW_TRIGGER_SET_STORAGE_NAME) return input.name;
  const target = input.target;
  if (target === undefined) return undefined;
  const labels = presentation?.then ?? DEFAULT_TRIGGER_THEN_LABELS;
  if (target.kind === 'workflow') return presentation?.resolveWorkflowTitle(target.ref) ?? labels.runWorkflow;
  const definition = target.definition;
  const first = definition.blocks[0];
  const only = definition.blocks.length === 1 ? first : undefined;
  if (definition.inputs.length === 0) {
    if (only?.kind === 'step' && only.inputMode !== 'none') return only.name?.trim() || labels.sendPrompt;
    if (only?.kind === 'action') {
      const message = only.input.message;
      if (only.actionId === 'notifications.notify_me' && message?.kind === 'literal' && typeof message.value === 'string') return labels.notifyMe;
      if (Object.values(only.input).every(binding => binding.kind === 'literal')) return labels.doAction;
    }
  }
  if (first === undefined) return presentation?.empty ?? '0 steps';
  if (presentation) return presentation.block(first);
  if (first.name?.trim()) return first.name.trim();
  switch (first.kind) {
    case 'step':
    case 'wait':
    case 'action':
    case 'workflow': return workflowExecutableLeafDefaultLabel(first.kind, labels);
    case 'parallel': return 'Side by side';
    case 'if': return 'If';
    case 'loop': return first.repetition.kind === 'items' ? 'Once for each item'
      : first.repetition.kind === 'until' ? 'Until a result says stop' : 'Repeat';
  }
}

/** Authored labels for a static Artifact preview; containers and runtime occurrences are omitted. */
export function workflowDefinitionPreviewStepsV1(blocks: readonly WorkflowBlock[]): readonly string[] {
  return walkWorkflowBlocks(blocks).flatMap((block) => {
    if (block.kind === 'step' || block.kind === 'wait' || block.kind === 'action' || block.kind === 'workflow') return [workflowBlockReferenceLabel(block)];
    return [];
  });
}

/** Explicit authored Review scopes only; dynamic inputs and nested Workflow references stay unknown. */
export function workflowDefinitionPreviewReviewScopesV1(blocks: readonly WorkflowBlock[]): readonly ReviewScope[] {
  const scopes = new Set<ReviewScope>();
  for (const block of walkWorkflowBlocks(blocks)) {
    if (block.kind !== 'action' || block.actionId !== REVIEW_START_ACTION_ID_V1 || block.input.scope?.kind !== 'literal') continue;
    const scope = ReviewScopeSchema.safeParse(block.input.scope.value);
    if (scope.success) scopes.add(scope.data);
  }
  return [...scopes];
}

/** Bounded by the Workflow's authored leaf steps. Uses literal targets and never opens nested Workflows. */
export function workflowDefinitionPreviewAgentsV1(definition: Pick<WorkflowDefinitionV1, 'defaults' | 'blocks'>): readonly PluginContributionIdentityV1[] {
  const agents = new Map<string, PluginContributionIdentityV1>();
  for (const block of walkWorkflowBlocks(definition.blocks)) {
    if (block.kind !== 'step') continue;
    const { agentTarget } = resolveWorkflowStepSelectionV1({
      defaults: definition.defaults, step: block.execution, purpose: 'authoring',
    }).selection;
    if (agentTarget?.kind === 'agent') agents.set(buildQualifiedPluginContributionKey(agentTarget.identity), agentTarget.identity);
  }
  return [...agents.values()];
}

/** Exact ids remain the fallback for reference pickers, where identity matters. */
export function workflowBlockReferenceLabel(block: WorkflowBlock): string {
  if (block.name?.trim()) return block.name.trim();
  if (block.kind === 'step' || block.kind === 'wait') return workflowStepPromptLabel(block) ?? block.id;
  return block.id;
}

/** Prompt-derived fallback for private authoring and Run detail when no name is authored. */
export function workflowStepPromptLabel(step: Pick<WorkflowStep, 'document'>): string | null {
  return workflowPromptTextLabel(step.document.text);
}

function workflowPromptTextLabel(text: string): string | null {
  const firstNonemptyLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstNonemptyLine === undefined) return null;
  // Preserve the existing visual bound without changing the authored prompt.
  return firstNonemptyLine.length > 60
    ? `${firstNonemptyLine.slice(0, 60)}…`
    : firstNonemptyLine;
}

/** An unnamed Run names its first executable leaf and the remaining authored steps. */
export function workflowDefinitionDisplayTitleV1(blocks: readonly unknown[]): string | null {
  let title: string | null = null;
  let steps = 0;
  for (const candidate of walkWorkflowBlocks(blocks)) {
    const block = readJsonRecord(candidate);
    if (block === null || (block.kind !== 'step' && block.kind !== 'wait' && block.kind !== 'action' && block.kind !== 'workflow')) continue;
    steps += 1;
    if (title !== null) continue;
    const name = typeof block.name === 'string' ? block.name.trim() : '';
    const text = readJsonRecord(block.document)?.text;
    title = name || ((block.kind === 'step' || block.kind === 'wait') && typeof text === 'string'
      ? workflowPromptTextLabel(text) : block.kind === 'action' ? workflowSetupInstallTitle(block) : null)
      || workflowExecutableLeafDefaultLabel(block.kind);
  }
  return title !== null && steps > 1 ? `${title} and ${steps - 1} more` : title;
}

/** A Setup Run's title names its software: "Install sl", or "Install 3 packages" when there are several. */
function workflowSetupInstallTitle(block: unknown): string | null {
  const packages = readWorkflowSetupInstallPackagesV1(block)?.requested;
  if (packages === undefined) return null;
  return packages.length === 1 ? `Install ${packages[0]}` : `Install ${packages.length} packages`;
}

function readJsonRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readJsonArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The software a frozen Machine setup leaf is for, as `name` or `name version`, from the reviewed Plans its
 * literal input carries; `null` unless every pending change is a package install (the Plan stays the
 * authority for what runs). `requested` names every package the Setup asks for (what the Run is about);
 * `installs` leaves out those the Plan already found satisfied (what it changes). A package source only
 * says where packages come from, so it is neither an install nor another kind of change.
 */
export function readWorkflowSetupInstallPackagesV1(block: unknown): Readonly<{
  requested: readonly string[];
  installs: readonly string[];
}> | null {
  const action = readJsonRecord(block);
  if (action?.kind !== 'action' || action.actionId !== MACHINE_SETUP_APPLY_ACTION_ID_V1) return null;
  const binding = readJsonRecord(readJsonRecord(action.input)?.targets);
  if (binding?.kind !== 'literal') return null;
  const requested: string[] = [];
  const installs: string[] = [];
  for (const rawTarget of readJsonArray(binding.value)) {
    const target = readJsonRecord(rawTarget);
    if (target === null || readJsonArray(target.removalPlans).length > 0 || readJsonArray(target.appChildren).length > 0) return null;
    for (const source of readJsonArray(target.sources)) {
      const setup = readJsonRecord(readJsonRecord(source)?.setup);
      if (setup?.toolchain !== undefined || readJsonArray(setup?.scripts).length > 0) return null;
    }
    for (const recipe of readJsonArray(target.recipePlans)) {
      const plan = readJsonRecord(readJsonRecord(recipe)?.plan);
      const facts = readJsonArray(plan?.nativeFacts);
      for (const [index, rawStep] of readJsonArray(plan?.steps).entries()) {
        const step = readJsonRecord(rawStep);
        const satisfied = readJsonRecord(facts[index])?.status === 'satisfied';
        if (satisfied && step?.kind !== 'script' && step?.kind !== 'package') continue;
        if (step?.kind === 'packageSource') continue;
        if (step?.kind !== 'package' || step.state === 'absent') return null;
        for (const rawItem of readJsonArray(step.packages)) {
          const item = readJsonRecord(rawItem);
          if (typeof item?.name !== 'string') return null;
          const label = typeof item.version === 'string' && item.version ? `${item.name} ${item.version}` : item.name;
          if (!requested.includes(label)) requested.push(label);
          if (!satisfied && !installs.includes(label)) installs.push(label);
        }
      }
    }
  }
  return requested.length > 0 ? { requested, installs } : null;
}

/**
 * The one visible numbering of a workflow's blocks (lab `editor-E1`): every leaf — an Agent step, a
 * Wait for you, an Action, a Run a workflow, a loop's deciding step — is numbered 1, 2, 3 … in authored
 * execution order across lanes and bodies; containers (Side by side, Repeat, If) are unnumbered and show
 * their kind mark instead. The editor heading, the Flow/Run map, Activity rows and a step Session's title
 * all read this owner, so one step has one number everywhere. A nested workflow numbers its own blocks.
 *
 * Presentation only: the persisted invocation index (`memberOrdinal`, a sibling position) is unchanged.
 */
export function listWorkflowBlockOrdinalsV1(blocks: readonly WorkflowBlock[]): ReadonlyMap<string, string> {
  const ordinals = new Map<string, string>();
  const pending = [...blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    switch (block.kind) {
      case 'step':
      case 'wait':
      case 'action':
      case 'workflow':
        ordinals.set(block.id, String(ordinals.size + 1));
        break;
      case 'parallel':
        for (let branchIndex = block.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const list = block.branches[branchIndex]!.blocks;
          for (let index = list.length - 1; index >= 0; index -= 1) pending.push(list[index]!);
        }
        break;
      case 'loop':
        // LIFO: the body precedes its deciding step in visible execution order.
        if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
        for (let index = block.body.length - 1; index >= 0; index -= 1) pending.push(block.body[index]!);
        break;
      case 'if':
        for (let index = block.otherwise.length - 1; index >= 0; index -= 1) pending.push(block.otherwise[index]!);
        for (let index = block.then.length - 1; index >= 0; index -= 1) pending.push(block.then[index]!);
        break;
    }
  }
  return ordinals;
}

/** One block's visible ordinal (see {@link listWorkflowBlockOrdinalsV1}); `null` for a container. */
export function workflowBlockOrdinalV1(blocks: readonly WorkflowBlock[], blockId: string): string | null {
  return listWorkflowBlockOrdinalsV1(blocks).get(blockId) ?? null;
}

/** Fresh step Sessions keep the step's name or prompt and its visible ordinal. */
export function formatWorkflowStepSessionTitle(params: Readonly<{
  step: WorkflowStep;
  /** The step's visible ordinal from `workflowBlockOrdinalV1`, exactly as its heading and map node show it. */
  stepOrdinal: string;
  item?: Readonly<{ value: JsonValue; position: number }>;
}>): string | null {
  const name = params.step.name?.trim() || workflowStepPromptLabel(params.step);
  if (!name) return null;
  const title = `${params.stepOrdinal} · ${name}`;
  if (!params.item) return title;
  const value = params.item.value;
  const itemLabel = typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : String(params.item.position);
  return `${title} · ${itemLabel}`;
}
