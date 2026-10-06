import type {
  WorkflowBlock,
  WorkflowResultContract,
  WorkflowDefinitionV1,
  WorkflowMaxIterationsV1,
  WorkflowRepetition,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowInvocationLifecycleV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SessionWorkflowAgentStatusV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import { t } from '@/text';
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
function declaredResultFields(result: WorkflowResultContract | undefined): readonly string[] | undefined {
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
): WorkflowFlowProjection {
  const declarations: WorkflowFlowNodeDeclaration[] = [];
  const pushNode = (node: WorkflowFlowNodeInput): void => {
    declarations.push(declareFlowNode(node));
  };
  const finalOutputBlockId = definition.finalOutput?.producer.blockId ?? null;
  const resultFacts = (block: WorkflowBlock, workflowPath: readonly string[]) => {
    const returns = block.kind === 'step' || block.kind === 'wait' ? declaredResultFields(block.result) : undefined;
    return {
      ...(returns === undefined ? {} : { returns }),
      // Only the root definition's own producer is this Run's final output.
      ...(workflowPath.length === 0 && block.id === finalOutputBlockId ? { finalOutput: true } : {}),
    };
  };

  const visitList = (
    list: readonly WorkflowBlock[],
    parentNodeId: string | null,
    workflowPath: readonly string[] = [],
    childEditTarget: WorkflowFlowEditTarget | null = null,
    refs: readonly string[] = [],
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
            label: blockLabels[nodeId] ?? workflowBlockReferenceLabel(block),
            parentNodeId,
            observed: false,
            ...resultFacts(block, workflowPath),
          });
          if (block.kind === 'workflow') {
            const child = frozenChildren[block.workflowRef];
            // Drafts may contain cycles; accepted definitions are admission-validated.
            if (child !== undefined && !refs.includes(block.workflowRef)) {
              visitList(child.blocks, nodeId, [...workflowPath, block.id], editTarget, [...refs, block.workflowRef]);
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
            label: blockLabels[nodeId] ?? workflowBlockReferenceLabel(block),
            parentNodeId,
            observed: false,
            ...resultFacts(block, workflowPath),
          });
          break;
        case 'parallel': {
          pushNode({
            nodeId,
            blockId: block.id,
            kind: 'parallel',
            editTarget,
            // 07 S14 / 05 §4.4: the fork reads as its sentence, not a structural name.
            label: t('workflows.page.inspector.lanes', { count: block.branches.length }),
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
              label: t('workflows.page.inspector.lane', { position: branchIndex + 1 }),
              parentNodeId: nodeId,
              observed: false,
            });
            visitList(branch.blocks, branchNodeId, workflowPath, childEditTarget, refs);
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
          visitList(block.body, nodeId, workflowPath, childEditTarget, refs);
          if (block.repetition.kind === 'evaluate') {
            const evaluator = block.repetition.evaluator;
            pushNode({
              nodeId: resolveWorkflowFlowScopedNodeId(evaluator.id, workflowPath),
              blockId: evaluator.id,
              kind: 'evaluator',
              editTarget: childEditTarget ?? { kind: evaluator.kind === 'step' ? 'prompt' : 'block', blockId: evaluator.id },
              label: t('workflows.editor.evaluator'),
              parentNodeId: nodeId,
              observed: false,
            });
          }
          break;
        }
        case 'if': {
          pushNode({
            nodeId,
            blockId: block.id,
            kind: 'if',
            editTarget,
            label: workflowBlockReferenceLabel(block),
            parentNodeId,
            observed: false,
          });
          const thenNodeId = resolveWorkflowFlowScopedNodeId(`${block.id}#then`, workflowPath);
          pushNode({
            nodeId: thenNodeId,
            blockId: block.id,
            kind: 'thenBranch',
            editTarget,
            label: t('workflows.editor.ifTrue'),
            parentNodeId: nodeId,
            observed: false,
          });
          visitList(block.then, thenNodeId, workflowPath, childEditTarget, refs);
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
            visitList(block.otherwise, otherwiseNodeId, workflowPath, childEditTarget, refs);
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
  attempt?: string;
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
 * A node's accessible ancestry, used for the "group / iteration" context a
 * screen-reader user needs and for the linear reading order in wide layouts.
 */
export function resolveWorkflowFlowAncestry(
  projection: WorkflowFlowProjection,
  nodeId: string,
): readonly WorkflowFlowNode[] {
  const ancestry: WorkflowFlowNode[] = [];
  let current = projection.nodesById.get(nodeId) ?? null;
  while (current?.parentNodeId != null) {
    const parent = projection.nodesById.get(current.parentNodeId) ?? null;
    if (parent === null) break;
    ancestry.unshift(parent);
    current = parent;
  }
  return ancestry;
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
