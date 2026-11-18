import type {
  WorkflowBlock,
  WorkflowResultContract,
  WorkflowDefinitionV1,
  WorkflowMaxIterationsV1,
  WorkflowRepetition,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowInvocationLifecycleV1, WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SessionWorkflowAgentStatusV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';
import { listWorkflowBlockOrdinalsV1, workflowStepPromptLabel } from '@happier-dev/protocol/workflows/workflowStepLabel';
import { t } from '@/text';
import { formatWorkflowConditionSentence, resolveWorkflowConditionHeadline } from '@/components/workflows/presentation/workflowConditionPresentation';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { buildHappierWorkMap, type HappierWorkMap, type HappierWorkMapPlaced } from '@happier-dev/plugin-ui/presentation';

/**
 * The one derived Flow projection.
 *
 * Flow is a reading mode over structure that already exists: an executable
 * definition, or an observed native-activity snapshot. It is not persisted, is
 * not an engine input, and has no independently editable edges, node positions
 * or inferred dependencies. Structure is carried by parent/ordinal rails, so a
 * renderer never needs a directional edge it cannot justify.
 *
 * This is the workflow producer of the neutral Work map: it owns the grammar
 * and labels and declares each node's parent; placement (depth, ordinal,
 * children) comes from the map contract.
 */

export type WorkflowFlowNodeKind =
  | 'step'
  | 'action'
  | 'workflow'
  | 'wait'
  | 'parallel'
  | 'branch'
  | 'loop'
  | 'if'
  | 'thenBranch'
  | 'otherwiseBranch'
  | 'evaluator'
  | 'observedPhase'
  | 'observedAgent';

export type WorkflowFlowRepetitionSummary = Readonly<{
  kind: WorkflowRepetition['kind'];
  /** Present only when the author set it; omission means no workflow limit. */
  maxConcurrent?: number;
  itemExecution?: 'sequential' | 'parallel';
  failurePolicy?: 'fail_stop' | 'collect_outcomes';
  maxIterations?: WorkflowMaxIterationsV1;
}>;

/**
 * What Flow's Edit action reveals for a node.
 *
 * `blockId` is always a real authored `WorkflowBlock` the editor can find and
 * select. A step or evaluator is a `prompt`: its composer takes focus. A
 * container is a `block`: it is revealed and selected, and so is a branch or
 * conditional frame, which is not a block of its own and therefore resolves to
 * the group that owns it. Observed activity has no edit target at all.
 */
export type WorkflowFlowEditTarget = Readonly<{
  kind: 'prompt' | 'block';
  blockId: string;
}>;

export type WorkflowFlowNodeDeclaration = Readonly<{
  /** Stable join key across Steps, Flow, Activity and the inspector. */
  nodeId: string;
  /** The authored block or branch this node presents; branches carry their own id. */
  blockId: string;
  kind: WorkflowFlowNodeKind;
  editTarget: WorkflowFlowEditTarget | null;
  label: string;
  /** The quiet fact after the name, in the regular face (a fork's "2 lanes"). */
  labelDetail?: string;
  parentNodeId: string | null;
  /** Opening a Flow node selects it in the workflow surface that shows it. */
  open: Readonly<{ kind: 'workflow-step'; nodeId: string }>;
  /** Authored container policy shown compactly on collapsed groups. */
  failurePolicy?: 'fail_stop' | 'collect_outcomes';
  maxConcurrent?: number;
  repetition?: WorkflowFlowRepetitionSummary;
  /** True when the node came from an observed snapshot rather than a definition. */
  observed: boolean;
  /** Authoritative observed state; distinct from managed invocation lifecycle. */
  observedStatus?: SessionWorkflowAgentStatusV1;
  /** The named results this step declares, in authored order (its title, else its name). */
  returns?: readonly string[];
  /** This block produces the workflow's final output. */
  finalOutput?: boolean;
  /** A leaf's visible number in its own definition (`workflowBlockOrdinalV1`); containers have none. */
  stepOrdinal?: string;
}>;

/** A Flow node placed on the Work map: `depth`, 1-based rail `ordinal`, `childNodeIds`. */
export type WorkflowFlowNode = HappierWorkMapPlaced<WorkflowFlowNodeDeclaration>;

/**
 * `relationships` says whether executable relationships between nodes are
 * known. An observed snapshot records phases and agents but not dataflow, so
 * its relationships stay explicitly unknown rather than being inferred from
 * order or timing.
 */
export type WorkflowFlowProjection = HappierWorkMap<WorkflowFlowNode> & Readonly<{
  source: 'definition' | 'observed';
}>;

type WorkflowFlowNodeInput = Omit<WorkflowFlowNodeDeclaration, 'open'>;

function declareFlowNode(node: WorkflowFlowNodeInput): WorkflowFlowNodeDeclaration {
  return { ...node, open: { kind: 'workflow-step', nodeId: node.nodeId } };
}

/** Child definitions may reuse ids; the call path, not the invocation occurrence, identifies a node. */
export function resolveWorkflowFlowScopedNodeId(blockId: string, workflowPath: readonly string[] = []): string {
  return workflowPath.length === 0 ? blockId : JSON.stringify([...workflowPath, blockId]);
}

/** A declared result's named fields, as the person reads them. Text and decision results name none. */
export function listWorkflowDeclaredResultFields(result: WorkflowResultContract | undefined): readonly string[] | undefined {
  if (result?.kind !== 'json' || result.schema.type !== 'object' || !result.schema.properties) return undefined;
  const fields = Object.entries(result.schema.properties).map(([name, field]) => field?.title ?? name);
  return fields.length > 0 ? fields : undefined;
}

function summarizeRepetition(repetition: WorkflowRepetition): WorkflowFlowRepetitionSummary {
  switch (repetition.kind) {
    case 'count':
      return { kind: 'count' };
    case 'items':
      return {
        kind: 'items',
        itemExecution: repetition.execution,
        failurePolicy: repetition.failurePolicy,
        ...(repetition.maxConcurrent === undefined ? {} : { maxConcurrent: repetition.maxConcurrent }),
      };
    case 'until':
      return { kind: 'until', maxIterations: repetition.maxIterations };
    case 'evaluate':
      return { kind: 'evaluate', maxIterations: repetition.maxIterations };
  }
}

/**
 * Projects a definition's real structure: ordered steps, parallel branches,
 * conditional branches, loop body and continuation. Nothing is added that the
 * author did not write.
 */
export function projectWorkflowFlow(
  definition: WorkflowDefinitionV1,
  frozenChildren: Readonly<Record<string, WorkflowDefinitionV1>> = {},
  /** Catalog-authored presentation; never inferred from prompt text or persisted in the definition. */
  blockLabels: Readonly<Record<string, string>> = {},
  /**
   * `run`: the map of a Run reads a condition as the Run's Steps do (an unset one is "Always"), through the
   * one headline owner. Omitted, the editor's authoring sentence.
   */
  options: Readonly<{ presentation?: 'authoring' | 'run' }> = {},
): WorkflowFlowProjection {
  const declarations: WorkflowFlowNodeDeclaration[] = [];
  const pushNode = (node: WorkflowFlowNodeInput): void => {
    declarations.push(declareFlowNode(node));
  };
  const finalOutputBlockId = definition.finalOutput?.producer.blockId ?? null;
  const rootOrdinals = listWorkflowBlockOrdinalsV1(definition.blocks);
  const resultFacts = (block: WorkflowBlock, workflowPath: readonly string[], ordinals: ReadonlyMap<string, string>) => {
    const stepOrdinal = ordinals.get(block.id);
    const returns = block.kind === 'step' || block.kind === 'wait' ? listWorkflowDeclaredResultFields(block.result) : undefined;
    return {
      ...(stepOrdinal === undefined ? {} : { stepOrdinal }),
      ...(returns === undefined ? {} : { returns }),
      // A Discussion outcomes read supplies typed round facts, not a human-authored
      // final answer. Keep its plain name without promoting plumbing to "Final output".
      ...(workflowPath.length === 0 && block.id === finalOutputBlockId
        && !(block.kind === 'action' && block.actionId === 'workflow.discussion.round.project') ? { finalOutput: true } : {}),
    };
  };

  const visitList = (
    list: readonly WorkflowBlock[],
    parentNodeId: string | null,
    workflowPath: readonly string[] = [],
    childEditTarget: WorkflowFlowEditTarget | null = null,
    refs: readonly string[] = [],
    // The visible ordinals of the definition this list belongs to (a nested workflow numbers its own).
    ordinals: ReadonlyMap<string, string> = rootOrdinals,
    referenceContext: Pick<WorkflowDefinitionV1, 'blocks'> = definition,
  ): void => {
    list.forEach((block) => {
      const nodeId = resolveWorkflowFlowScopedNodeId(block.id, workflowPath);
      const editTarget = childEditTarget ?? { kind: 'block' as const, blockId: block.id };
      switch (block.kind) {
        case 'action':
        case 'wait':
        case 'workflow': {
          pushNode({
            nodeId,
            blockId: block.id,
            kind: block.kind,
            editTarget,
            label: workflowBlockReferenceLabel(block, blockLabels[nodeId]),
            parentNodeId,
            observed: false,
            ...resultFacts(block, workflowPath, ordinals),
          });
          if (block.kind === 'workflow') {
            const child = frozenChildren[block.workflowRef];
            // Drafts may contain cycles; accepted definitions are admission-validated.
            if (child !== undefined && !refs.includes(block.workflowRef)) {
              visitList(child.blocks, nodeId, [...workflowPath, block.id], editTarget, [...refs, block.workflowRef],
                listWorkflowBlockOrdinalsV1(child.blocks), child);
            }
          }
          break;
        }
        case 'step':
          pushNode({
            nodeId,
            blockId: block.id,
            kind: 'step',
            editTarget: childEditTarget ?? { kind: 'prompt', blockId: block.id },
            label: workflowBlockReferenceLabel(block, blockLabels[nodeId]
              ?? (options.presentation === 'run' ? workflowStepPromptLabel(block) ?? undefined : undefined)),
            parentNodeId,
            observed: false,
            ...resultFacts(block, workflowPath, ordinals),
          });
          break;
        case 'parallel': {
          pushNode({
            nodeId,
            blockId: block.id,
            kind: 'parallel',
            editTarget,
            // 07 S14 / 05 §4.4: the fork reads as its sentence, not a structural name: its authored name
            // (else "Side by side"), then its lane count as the quiet detail ("Side by side · 2 lanes",
            // lab nav-N3 `.wm-forkhd`: the name bold, the count regular).
            label: block.name?.trim() ? workflowBlockReferenceLabel(block) : t('workflows.editor.addParallel'),
            labelDetail: t('workflows.page.inspector.laneCount', { count: block.branches.length }),
            parentNodeId,
            failurePolicy: block.failurePolicy,
            ...(block.maxConcurrent === undefined ? {} : { maxConcurrent: block.maxConcurrent }),
            observed: false,
          });
          block.branches.forEach((branch, branchIndex) => {
            const branchNodeId = resolveWorkflowFlowScopedNodeId(`${block.id}#${branch.id}`, workflowPath);
            pushNode({
              nodeId: branchNodeId,
              blockId: branch.id,
              kind: 'branch',
              // A branch is a frame inside its group, not a block: the group is
              // the editor that can be revealed for it.
              editTarget,
              // A lane carries its authored name, else "Lane {n}" (07).
              label: branch.name ?? t('workflows.page.inspector.lane', { position: branchIndex + 1 }),
              parentNodeId: nodeId,
              observed: false,
            });
            visitList(branch.blocks, branchNodeId, workflowPath, childEditTarget, refs, ordinals, referenceContext);
          });
          break;
        }
        case 'loop': {
          pushNode({
            nodeId,
            blockId: block.id,
            kind: 'loop',
            editTarget,
            label: workflowBlockReferenceLabel(block),
            parentNodeId,
            repetition: summarizeRepetition(block.repetition),
            ...(block.repetition.kind === 'items'
              ? {
                failurePolicy: block.repetition.failurePolicy,
                ...(block.repetition.maxConcurrent === undefined
                  ? {}
                  : { maxConcurrent: block.repetition.maxConcurrent }),
              }
              : {}),
            observed: false,
          });
          visitList(block.body, nodeId, workflowPath, childEditTarget, refs, ordinals, referenceContext);
          if (block.repetition.kind === 'evaluate') {
            const evaluator = block.repetition.evaluator;
            pushNode({
              nodeId: resolveWorkflowFlowScopedNodeId(evaluator.id, workflowPath),
              blockId: evaluator.id,
              kind: 'evaluator',
              editTarget: childEditTarget ?? { kind: evaluator.kind === 'step' ? 'prompt' : 'block', blockId: evaluator.id },
              label: workflowBlockReferenceLabel(evaluator, options.presentation === 'run' && evaluator.kind === 'step'
                ? workflowStepPromptLabel(evaluator) ?? t('workflows.editor.evaluator') : t('workflows.editor.evaluator')),
              parentNodeId: nodeId,
              observed: false,
              ...(ordinals.get(evaluator.id) === undefined ? {} : { stepOrdinal: ordinals.get(evaluator.id)! }),
            });
          }
          break;
        }
        case 'if': {
          const condition = options.presentation === 'run'
            ? resolveWorkflowConditionHeadline(referenceContext, block.when, 'run').sentence
            : formatWorkflowConditionSentence(referenceContext, block.when);
          pushNode({
            nodeId,
            blockId: block.id,
            kind: 'if',
            editTarget,
            label: workflowBlockReferenceLabel(block),
            // Unnamed, the kind's own word leads ("**If** · … is No"); a named condition keeps its If so
            // the map reads as a condition, as the editor's heading does (lab run-A).
            labelDetail: block.name?.trim() ? t('workflows.page.inspector.ifSentence', { condition }) : condition,
            parentNodeId,
            observed: false,
          });
          const thenNodeId = resolveWorkflowFlowScopedNodeId(`${block.id}#then`, workflowPath);
          pushNode({
            nodeId: thenNodeId,
            blockId: block.id,
            kind: 'thenBranch',
            editTarget,
            // 07 S14: the map names an If's alternatives Yes / Otherwise.
            label: t('workflows.map.yes'),
            parentNodeId: nodeId,
            observed: false,
          });
          visitList(block.then, thenNodeId, workflowPath, childEditTarget, refs, ordinals, referenceContext);
          if (block.otherwise.length > 0) {
            const otherwiseNodeId = resolveWorkflowFlowScopedNodeId(`${block.id}#otherwise`, workflowPath);
            pushNode({
              nodeId: otherwiseNodeId,
              blockId: block.id,
              kind: 'otherwiseBranch',
              editTarget,
              label: t('workflows.editor.otherwise'),
              parentNodeId: nodeId,
              observed: false,
            });
            visitList(block.otherwise, otherwiseNodeId, workflowPath, childEditTarget, refs, ordinals, referenceContext);
          }
          break;
        }
      }
    });
  };

  visitList(definition.blocks, null);

  return { source: 'definition', ...buildHappierWorkMap({ relationships: 'authored', nodes: declarations }) };
}

/**
 * Projects an observed native-activity snapshot.
 *
 * Phases and agents are the only structure the snapshot proves. Phase order,
 * shared workspaces, timing overlap and parent identifiers do not establish
 * executable dependencies, so this projection records `relationships: 'unknown'`
 * and produces no edges the observation cannot support.
 */
export function projectObservedWorkflowFlow(
  snapshot: SessionWorkflowRunSnapshotV1,
): WorkflowFlowProjection {
  const declarations: WorkflowFlowNodeDeclaration[] = [];
  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const placed = new Set<string>();

  const pushNode = (node: WorkflowFlowNodeInput): void => {
    declarations.push(declareFlowNode(node));
  };

  const orderedPhases = [...snapshot.phases].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  orderedPhases.forEach((phase) => {
    const phaseNodeId = `phase:${phase.id}`;
    pushNode({
      nodeId: phaseNodeId,
      blockId: phase.id,
      kind: 'observedPhase',
      editTarget: null,
      label: phase.title ?? phase.id,
      parentNodeId: null,
      observed: true,
    });
    phase.agentIds.forEach((agentId) => {
      const agent = agentById.get(agentId);
      if (agent === undefined) return;
      placed.add(agentId);
      pushNode({
        nodeId: `agent:${agentId}`,
        blockId: agentId,
        kind: 'observedAgent',
        editTarget: null,
        label: agent.title,
        parentNodeId: phaseNodeId,
        observed: true,
        observedStatus: agent.status,
      });
    });
  });

  // Agents the snapshot never assigned to a phase stay visible at the root
  // rather than being attached to a phase by guesswork.
  for (const agent of snapshot.agents) {
    if (placed.has(agent.id)) continue;
    pushNode({
      nodeId: `agent:${agent.id}`,
      blockId: agent.id,
      kind: 'observedAgent',
      editTarget: null,
      label: agent.title,
      parentNodeId: null,
      observed: true,
      observedStatus: agent.status,
    });
  }

  return { source: 'observed', ...buildHappierWorkMap({ relationships: 'unknown', nodes: declarations }) };
}

/** One loop an occurrence sits in: which item it ran for, and that item's name. */
export type WorkflowFlowRunStateRepetition = Readonly<{ loopNodeId: string; index: number; label: string }>;

/**
 * Run state supplied by the canonical invocation owner. Flow renders exactly
 * what it is handed; it never derives a lifecycle from structure or timing.
 */
export type WorkflowFlowNodeRunState = Readonly<{
  nodeId: string;
  /** Exact physical invocation row selected by Run detail. */
  invocationId: string;
  lifecycle: WorkflowInvocationLifecycleV1;
  /** Scoped occurrence identity, e.g. the current item or iteration. */
  occurrenceLabel?: string;
  /** The loops this occurrence sits in, outermost first: the coordinates the item selector groups by. */
  repetitions?: readonly WorkflowFlowRunStateRepetition[];
  attempt?: string;
  /** Worker-recorded timing of this exact physical attempt, absent for unopened/older rows. */
  timing?: WorkflowProgressEnvelopeV1['timing'];
  /** Exact completed item pipelines; concurrency is the frozen author's choice. */
  loopProgress?: Readonly<{ completed: number; total: number; maxConcurrent?: number }>;
}>;

export function indexWorkflowFlowRunStates(
  states: readonly WorkflowFlowNodeRunState[],
): ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]> {
  const byNode = new Map<string, WorkflowFlowNodeRunState[]>();
  for (const state of states) {
    const occurrences = byNode.get(state.nodeId);
    if (occurrences === undefined) byNode.set(state.nodeId, [state]);
    else occurrences.push(state);
  }
  return byNode;
}

/**
 * The If alternatives a Run did not take, with everything inside them (07 S14 "Not taken").
 *
 * Only what the Run recorded decides it: an alternative is not taken when its sibling ran something
 * and it ran nothing, or when the If itself was skipped because its condition was false and it had
 * no Otherwise. An If that has not been decided yet takes nothing away.
 */
export function listWorkflowFlowNotTakenNodeIds(
  projection: WorkflowFlowProjection,
  runStates: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]> | undefined,
): ReadonlySet<string> {
  const notTaken = new Set<string>();
  if (runStates === undefined || runStates.size === 0) return notTaken;
  const ran = (nodeId: string): boolean => {
    if ((runStates.get(nodeId)?.length ?? 0) > 0) return true;
    return projection.nodesById.get(nodeId)?.childNodeIds.some(ran) === true;
  };
  const markAll = (nodeId: string): void => {
    notTaken.add(nodeId);
    projection.nodesById.get(nodeId)?.childNodeIds.forEach(markAll);
  };
  for (const node of projection.nodes) {
    if (node.kind !== 'if') continue;
    const branches = node.childNodeIds.filter((childNodeId) => {
      const kind = projection.nodesById.get(childNodeId)?.kind;
      return kind === 'thenBranch' || kind === 'otherwiseBranch';
    });
    const taken = branches.filter(ran);
    if (taken.length > 0) {
      branches.filter((branch) => !taken.includes(branch)).forEach(markAll);
    } else if (runStates.get(node.nodeId)?.some((state) => state.lifecycle === 'skipped') === true) {
      branches.forEach(markAll);
    }
  }
  return notTaken;
}

/**
 * Flow selection joins Steps, Activity and the inspector on the same authored
 * identity. Edit resolves every node to a real editor: a step or evaluator to
 * its prompt, a container to itself, and a branch or conditional frame — which
 * is not a block — to the group that owns it. This is the one owner of that
 * decision; a renderer never reads `blockId` for it.
 */
export function resolveWorkflowFlowEditTarget(
  projection: WorkflowFlowProjection,
  nodeId: string,
): WorkflowFlowEditTarget | null {
  return projection.nodesById.get(nodeId)?.editTarget ?? null;
}
