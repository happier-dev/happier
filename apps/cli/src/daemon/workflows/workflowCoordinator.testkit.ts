import type { WorkflowInvocationLifecycleV1 } from '@happier-dev/protocol/workflows';
import { mergeWorkflowResultProvenanceV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createWorkflowCoordinator, workflowInvocationKey, type WorkflowCoordinatorInvocation, type WorkflowCoordinatorStore } from './coordinator';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { freezeActionCompletionContractV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { WorkflowJsonValue } from './input';
import { shouldPublishWorkflowSharedConversation } from './workflowConversation';
import { materializeWorkflowContainerResult } from './workflowContainerResult';

type FrozenCoordinatorFields = 'authoredDefinition' | 'materializedLeaves' | 'frozenChildren' | 'workDepth';
type CoordinatorRunInput = Parameters<ReturnType<typeof createWorkflowCoordinator>['run']>[0];

/** Unit fixtures enter the real coordinator with the same frozen fields as production admission. */
export function createTestWorkflowCoordinator(deps: Parameters<typeof createWorkflowCoordinator>[0]) {
  const coordinator = createWorkflowCoordinator(deps);
  return { ...coordinator, run: async (input: Omit<CoordinatorRunInput, FrozenCoordinatorFields>
    & Partial<Pick<CoordinatorRunInput, FrozenCoordinatorFields>>) => {
    if (input.materializedLeaves !== undefined) return coordinator.run({ ...input,
      authoredDefinition: input.authoredDefinition ?? input.definition,
      frozenChildren: input.frozenChildren ?? {}, workDepth: input.workDepth ?? 0,
      materializedLeaves: input.materializedLeaves });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: input.definition,
      context: { source: { kind: 'inline' }, inputs: { ...input.inputs }, machineId: 'machine-1',
        executionTarget: input.executionTarget,
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}) },
        authorization: input.authorization },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readActionContract: async (id) => {
          const spec = getActionSpec(ActionIdSchema.parse(id));
          if (!spec.outputSchema) return null;
          return { inputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
            outputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.outputSchema, { target: 'draft-7' })),
            ...(spec.completion ? { completion: freezeActionCompletionContractV1(spec.completion) } : {}) };
        } } });
    if (!accepted.ok) throw new Error(`workflow_fixture_not_materialized:${accepted.error.code}`);
    return coordinator.run({ ...accepted.snapshot, ...input,
      authoredDefinition: input.authoredDefinition ?? accepted.snapshot.authoredDefinition,
      materializedLeaves: accepted.snapshot.materializedLeaves,
      frozenChildren: input.frozenChildren ?? accepted.snapshot.frozenChildren,
      workDepth: input.workDepth ?? accepted.snapshot.workDepth });
  } };
}

export type InMemoryWorkflowCoordinatorStore = Omit<
  WorkflowCoordinatorStore,
  'read' | 'readCurrent' | 'readByLogicalInvocation' | 'listByLifecycle'
> & Readonly<{
  records: Map<string, WorkflowCoordinatorInvocation>;
  list: () => readonly WorkflowCoordinatorInvocation[];
  read: (key: string) => WorkflowCoordinatorInvocation | undefined;
  readCurrent: (params: Parameters<WorkflowCoordinatorStore['readCurrent']>[0]) => WorkflowCoordinatorInvocation | undefined;
  readByLogicalInvocation: (logicalInvocationRecordId: string) => WorkflowCoordinatorInvocation | undefined;
  listByLifecycle: (params: Readonly<{
    runId: string;
    lifecycles: readonly WorkflowInvocationLifecycleV1[];
  }>) => readonly WorkflowCoordinatorInvocation[];
}>;

export function createInMemoryWorkflowCoordinatorStore(): InMemoryWorkflowCoordinatorStore {
  const records = new Map<string, WorkflowCoordinatorInvocation>();
  let nextSequence = 0n;
  let frontier = { nextBlockOrdinal: 0, paused: false };
  const store: InMemoryWorkflowCoordinatorStore = {
    records,
    list: () => [...records.values()],
    readFrontier: () => frontier,
    commitFrontier: async ({ nextBlockOrdinal }) => { frontier = { ...frontier, nextBlockOrdinal }; },
    readControl: async () => 'running',
    confirmReviewHolds: async ({ recordIds }) => ({ revision: 0, control: 'running',
      rows: [...records.values()].filter((record) => recordIds.includes(record.recordId)) }),
    admitReviewReplacement: async ({ prior, recordId, input }) => {
      const current = records.get(prior.key);
      if (!current || current.lifecycle !== 'waiting_for_review' || current.contentRevision !== prior.contentRevision) {
        throw new Error('workflow_invocation_fact_conflict');
      }
      records.set(prior.key, { ...current, lifecycle: 'superseded', contentRevision: String(BigInt(current.contentRevision ?? '0') + 1n) });
      const replacement: WorkflowCoordinatorInvocation = {
        key: workflowInvocationKey({ runId: prior.runId, blockId: prior.blockId, scope: prior.path.scope, attempt: prior.attempt + 1 }),
        recordId, runId: prior.runId, blockId: prior.blockId, parentKey: prior.parentKey, memberOrdinal: prior.memberOrdinal,
        path: prior.path, attempt: prior.attempt + 1, acceptedAtMs: Date.now(), contentRevision: '0',
        logicalInvocationRecordId: prior.logicalInvocationRecordId ?? prior.recordId, lifecycle: 'pending',
        previousAttemptRecordId: prior.recordId, recovery: { conversation: 'same_conversation', input: { kind: 'replacement', value: input } },
        ...(prior.workspace ? { workspace: prior.workspace } : {}), input,
      };
      records.set(replacement.key, replacement);
      return replacement;
    },
    read: (key) => records.get(key),
    readCurrent: ({ runId, blockId, parentKey, memberOrdinal }) => {
      let parent = parentKey === undefined ? undefined : records.get(parentKey);
      if (parentKey !== undefined && !parent) return undefined;
      for (;;) {
        const key = parent?.key;
        const current = [...records.values()]
          .filter((record) => record.runId === runId && record.blockId === blockId
            && record.parentKey === key && record.memberOrdinal === memberOrdinal)
          .sort((left, right) => right.attempt - left.attempt)[0];
        if (current || !parent?.previousAttemptRecordId) return current;
        const previousId = parent.previousAttemptRecordId;
        parent = [...records.values()].find((record) => record.recordId === previousId);
        if (!parent) return undefined;
      }
    },
    readByLogicalInvocation: (id) => [...records.values()].find((record) => record.recordId === id),
    readInvocationBindingRow: async (id) => {
      let record = [...records.values()].find((row) => row.recordId === id);
      if (!record) {
        // Standalone unit fixtures have an implicit root; the durable owner
        // always reads a real sealed root row instead.
        const child = [...records.values()].find((row) => id === workflowInvocationKey({
          runId: row.runId, blockId: '$root', scope: [], attempt: 0,
        }));
        if (!child) return undefined;
        record = { key: id, recordId: id, runId: child.runId, blockId: '$root', memberOrdinal: '0',
          path: { blockId: '$root', scope: [] }, attempt: 0, acceptedAtMs: child.acceptedAtMs, lifecycle: 'running' };
      }
      const rootId = [...records.values()].find((row) => row.runId === record.runId && row.blockId === '$root')?.recordId
        ?? workflowInvocationKey({ runId: record.runId, blockId: '$root', scope: [], attempt: 0 });
      const parentRecordId = record.blockId === '$root' ? null
        : record.parentKey ? records.get(record.parentKey)?.recordId : rootId;
      if (parentRecordId === undefined || record.memberOrdinal === undefined) return undefined;
      const blockKind = record.blockKind ?? (record.blockId === '$root' ? 'root' : record.frame
        ? record.frame.source.kind === 'branch' ? 'parallel' : 'loop'
        : record.container?.kind === 'parallel' || record.container?.kind === 'loop' || record.container?.kind === 'if'
          ? record.container.kind : 'step');
      const timestamp = new Date(record.acceptedAtMs).toISOString();
      return { index: { id: record.recordId, runId: record.runId, parentRecordId,
        memberOrdinal: record.memberOrdinal, sequence: record.sequence ?? '0', attempt: String(record.attempt),
        contentRevision: record.contentRevision ?? '0',
        lifecycle: record.lifecycle, createdAt: timestamp, updatedAt: timestamp },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: record.path, blockKind,
          attempt: String(record.attempt), logicalInvocationRecordId: record.logicalInvocationRecordId ?? record.recordId,
          ...(record.execution ? { execution: record.execution } : {}),
          ...(record.previousAttemptRecordId ? { previousAttemptRecordId: record.previousAttemptRecordId } : {}),
          ...(record.recovery ? { recovery: record.recovery } : {}),
          ...(record.frame ? { frame: record.frame } : {}), ...(record.container ? { container: record.container } : {}) } };
    },
    listByLifecycle: ({ runId, lifecycles }) => [...records.values()].filter(
      (record) => record.runId === runId && lifecycles.includes(record.lifecycle),
    ),
    listCurrentMembers: async (parentKey) => {
      const selected = new Map<string, WorkflowCoordinatorInvocation>();
      let parent = records.get(parentKey);
      while (parent) {
        const parentId = parent.recordId;
        const candidates = [...records.values()].filter((record) => record.parentKey === parent!.key)
          .sort((left, right) => right.attempt - left.attempt);
        for (const record of candidates) if (record.memberOrdinal !== undefined && !selected.has(record.memberOrdinal)) selected.set(record.memberOrdinal, record);
        parent = parent.previousAttemptRecordId ? [...records.values()].find((record) => record.recordId === parent!.previousAttemptRecordId) : undefined;
        if (parent?.recordId === parentId) throw new Error('workflow_parent_invocation_cycle');
      }
      const indices = await Promise.all([...selected.values()].map(async (record) => (await store.readInvocationBindingRow(record.recordId))!.index));
      return indices.sort((left, right) => Number(left.memberOrdinal) - Number(right.memberOrdinal));
    },
    ensureIntent: async (invocation) => {
      const existing = records.get(invocation.key);
      if (existing) return existing;
      const admitted = { ...invocation, contentRevision: '0', sequence: invocation.sequence ?? String(nextSequence++) };
      records.set(invocation.key, admitted);
      return admitted;
    },
    readContainerResult: async (record, resolveWorkflowOutput) => await materializeWorkflowContainerResult(record, store, resolveWorkflowOutput),
    commitContainerResult: async ({ key }) => {
      const existing = records.get(key);
      if (!existing) throw new Error('workflow_invocation_intent_missing');
      const committed = { ...existing, lifecycle: 'completed' as const,
        containerResult: { kind: 'container' as const, containerRecordId: existing.recordId } };
      records.set(key, committed);
      return committed;
    },
    commitSharedConversation: async ({ scopeOwnerKey, targetClass, invocationRecordId, replacesExecution }) => {
      const leaf = [...records.values()].find((record) => record.recordId === invocationRecordId);
      if (!leaf?.execution || leaf.execution.kind !== targetClass) throw new Error('workflow_conversation_unavailable');
      let owner = [...records.values()].find((record) => record.recordId === scopeOwnerKey);
      if (!owner) {
        if (scopeOwnerKey !== workflowInvocationKey({ runId: leaf.runId, blockId: '$root', scope: [], attempt: 0 })) {
          throw new Error('workflow_conversation_scope_missing');
        }
        owner = { key: scopeOwnerKey, recordId: scopeOwnerKey, runId: leaf.runId, blockId: '$root', memberOrdinal: '0',
          path: { blockId: '$root', scope: [] }, attempt: 0, acceptedAtMs: leaf.acceptedAtMs, lifecycle: 'running' };
      }
      const previousId = owner.sharedConversationInvocationRecordId?.[targetClass];
      const previous = previousId ? [...records.values()].find((record) => record.recordId === previousId) : undefined;
      if (previousId && !previous?.execution) throw new Error('workflow_conversation_unavailable');
      if (shouldPublishWorkflowSharedConversation({ current: previous?.execution, next: leaf.execution, replacesExecution,
        currentSequence: previous?.sequence, nextSequence: leaf.sequence })) {
        records.set(owner.key, { ...owner, sharedConversationInvocationRecordId: {
          ...owner.sharedConversationInvocationRecordId, [targetClass]: invocationRecordId,
        } });
      }
    },
    commitFact: async ({ key, lifecycle, result, usage, reason, reasonMessage, validationIssues, review, execution, sharedConversationInvocationRecordId, observationDeadline, input, resultContract, workspace, container, containerResult, resultProvenance }) => {
      const existing = records.get(key);
      if (!existing) throw new Error('workflow_invocation_intent_missing');
      if (existing.lifecycle === 'completed' || existing.lifecycle === 'failed'
        || existing.lifecycle === 'skipped' || existing.lifecycle === 'cancelled'
        || existing.lifecycle === 'outcome_uncertain') {
        if (existing.lifecycle !== lifecycle
          || !sameOptionalJson(existing.result, result)
          || JSON.stringify(existing.usage) !== JSON.stringify(usage)) {
          throw new Error('workflow_invocation_fact_conflict');
        }
        return existing;
      }
      const committed = { ...existing, lifecycle, contentRevision: String(BigInt(existing.contentRevision ?? '0') + 1n),
        ...(resultProvenance ? { resultProvenance: mergeWorkflowResultProvenanceV1(existing.resultProvenance, resultProvenance) } : {}),
        ...(review ? { review } : {}), ...(result === undefined ? {} : { result }), ...(usage === undefined ? {} : { usage }), ...(reason ? { reason } : {}), ...(execution ? { execution } : {}), ...(sharedConversationInvocationRecordId ? { sharedConversationInvocationRecordId: { ...existing.sharedConversationInvocationRecordId, ...sharedConversationInvocationRecordId } } : {}), ...(observationDeadline ? { observationDeadline } : {}), ...(input ? { input } : {}), ...(workspace ? { workspace: { ...existing.workspace, ...workspace } } : {}), ...(container ? { container } : {}), ...(containerResult ? { containerResult } : {}) };
      const withContract = resultContract === undefined ? committed : { ...committed, resultContract };
      const withMessage = { ...withContract, ...(reasonMessage === undefined ? {} : { reasonMessage }),
        ...(validationIssues === undefined ? {} : { validationIssues }) };
      records.set(key, withMessage);
      return withMessage;
    },
  };
  return store;
}

function sameOptionalJson(left: WorkflowJsonValue | undefined, right: WorkflowJsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
