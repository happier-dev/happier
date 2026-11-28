import { collectWorkflowLeavesV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1, WorkflowRunStepProgressV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowCoordinatorInvocation } from './coordinator';

type Observation = NonNullable<NonNullable<WorkflowRunStepProgressV1['destinations']>[number]['observation']>;
type Stage = {
  total: number;
  completedLeaves: number;
  skippedLeaves: number;
  completed: number;
  skipped: number;
  lifecycle?: WorkflowCoordinatorInvocation['lifecycle'];
};

/** The durable coordinator's aggregate: authored structure is indexed once;
 * admitted invocation facts replace only their stage and destination entries. */
export class WorkflowStepProgress {
  private readonly observations = new Map<string, Observation>();
  private readonly stages = new Map<string, Stage>();
  private readonly leafStages = new Map<string, Stage>();
  private readonly workflowsBySource = new Map<string, Map<string, string>>();
  private readonly destinationIndices = new Map<string, number[]>();
  private destinations: WorkflowRunStepProgressV1['destinations'];
  private completed = 0;
  private skipped = 0;
  private readonly total: number;
  private readonly loops = new Map<number, WorkflowCoordinatorInvocation>();

  constructor(params: Readonly<{
    definition?: WorkflowDefinitionV1;
    frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
    destinations?: WorkflowRunStepProgressV1['destinations'];
  }>) {
    this.total = params.definition ? countWorkflowStepsV1(params.definition.blocks) : 0;
    for (const block of params.definition?.blocks ?? []) {
      const leaves = collectWorkflowLeavesV1({ ...params.definition!, blocks: [block] });
      const stage: Stage = { total: countWorkflowStepsV1([block]), completedLeaves: 0, skippedLeaves: leaves.length, completed: 0, skipped: 0 };
      this.stages.set(block.id, stage);
      for (const leaf of leaves) this.leafStages.set(leaf.id, stage);
    }
    const definitions = { ...params.frozenChildren, ...(params.definition ? { $root: params.definition } : {}) };
    for (const [sourceKey, definition] of Object.entries(definitions)) {
      this.workflowsBySource.set(sourceKey, new Map(collectWorkflowLeavesV1(definition)
        .flatMap(leaf => leaf.kind === 'workflow' ? [[leaf.id, leaf.workflowRef] as const] : [])));
    }
    this.destinations = params.destinations?.map(leaf => ({ ...leaf }));
    this.destinations?.forEach((leaf, index) => {
      const key = JSON.stringify([leaf.sourceKey, leaf.blockId]);
      const indices = this.destinationIndices.get(key) ?? [];
      indices.push(index);
      this.destinationIndices.set(key, indices);
    });
  }

  private updateStage(stage: Stage): void {
    const completed = stage.lifecycle === 'completed' ? stage.completedLeaves : 0;
    const skipped = stage.lifecycle === 'skipped' ? stage.total : stage.lifecycle === 'completed' ? stage.skippedLeaves : 0;
    this.completed += completed - stage.completed;
    this.skipped += skipped - stage.skipped;
    stage.completed = completed;
    stage.skipped = skipped;
  }

  rememberTopLevel(record: WorkflowCoordinatorInvocation): void {
    const stage = this.stages.get(record.blockId);
    if (!stage) return;
    stage.lifecycle = record.lifecycle;
    this.updateStage(stage);
    const ordinal = Number(record.memberOrdinal);
    if (record.container?.kind === 'loop' && record.lifecycle !== 'completed') this.loops.set(ordinal, record);
    else this.loops.delete(ordinal);
  }

  private rememberObservation(sourceKey: string, blockId: string, observation: Observation): void {
    const key = JSON.stringify([sourceKey, blockId]);
    const previous = this.observations.get(key);
    // The existing globally allocated sequence orders retries; revisions order
    // observations of the same physical row. Equal reads retain their entry.
    if (previous && (BigInt(observation.sequence) < BigInt(previous.sequence)
      || (observation.recordId === previous.recordId && BigInt(observation.contentRevision) <= BigInt(previous.contentRevision)))) return;
    this.observations.set(key, observation);
    const stage = sourceKey === '$root' ? this.leafStages.get(blockId) : undefined;
    if (stage) {
      stage.completedLeaves += Number(observation.lifecycle === 'completed') - Number(previous?.lifecycle === 'completed');
      stage.skippedLeaves += Number(observation.lifecycle === 'skipped') - Number(!previous || previous.lifecycle === 'skipped');
      this.updateStage(stage);
    }
    // A destination carries slot identity and lifecycle. Preparation facts on a
    // new pending row and newer detail on the same lifecycle stay on that row.
    // Keep the source revision above even when there is no destination change.
    if ((!previous && observation.lifecycle === 'pending')
      || (previous?.recordId === observation.recordId && previous.lifecycle === observation.lifecycle
        && previous.blockKind === observation.blockKind)) return;
    const indices = this.destinationIndices.get(key);
    if (indices && this.destinations) {
      const destinations = [...this.destinations];
      for (const index of indices) destinations[index] = { ...destinations[index], observation };
      this.destinations = destinations;
    }
  }

  remember(index: WorkflowRunInvocationIndexV1, progress: WorkflowProgressEnvelopeV1,
    record: WorkflowCoordinatorInvocation, topLevel: boolean, firstRead: boolean): void {
    if (progress.blockKind === 'root') {
      // Our own root writes already contain this aggregate. Only newly opened
      // durable roots seed observations (including inherited restart roots).
      if (firstRead) for (const leaf of progress.stepProgress?.destinations ?? []) {
        if (leaf.observation) this.rememberObservation(leaf.sourceKey, leaf.blockId, leaf.observation);
      }
      return;
    }
    let sourceKey = '$root';
    for (const scope of progress.invocationPath.scope) {
      if (scope.kind !== 'workflow') continue;
      const ref = this.workflowsBySource.get(sourceKey)?.get(scope.blockId);
      if (!ref) return;
      sourceKey = ref;
    }
    this.rememberObservation(sourceKey, record.blockId, {
      recordId: index.id, sequence: index.sequence, attempt: index.attempt, contentRevision: index.contentRevision,
      lifecycle: index.lifecycle, blockKind: progress.blockKind,
    });
    if (topLevel) this.rememberTopLevel(record);
  }

  currentLoops(): readonly WorkflowCoordinatorInvocation[] {
    return [...this.loops.entries()].sort(([left], [right]) => left - right).map(([, record]) => record);
  }

  project(currentLoop?: WorkflowRunStepProgressV1['currentLoop']): WorkflowRunStepProgressV1 {
    return { completed: this.completed, skipped: this.skipped, total: this.total,
      ...(currentLoop ? { currentLoop } : {}), ...(this.destinations ? { destinations: this.destinations } : {}) };
  }
}
