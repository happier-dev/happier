import { randomUUID } from 'node:crypto';

import {
  applyWorkflowInvocationFactV1,
  sameStrictJsonValue,
  classifyWorkflowHoldV1,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  StrictJsonValueSchema,
  AutomationStoredContentEnvelopeV1Schema,
  AutomationStoredWorkflowDefinitionV2Schema,
  WorkflowAcceptedSnapshotV1Schema,
  WorkflowAuthoredInputV1Schema,
  WorkflowCheckpointEnvelopeV1Schema,
  WorkflowProgressEnvelopeV1Schema,
  WorkflowInvocationFactV1Schema,
  WorkflowInvocationFactResultV1Schema,
  WorkflowRunInvocationIndexV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowOperationErrorCodeV1Schema,
  WorkflowResolvedInputsV1Schema,
  materializeWorkflowAcceptedSnapshotV1,
  renderSessionRoleBlockV1,
  resolveWorkflowDefinitionRefV1,
  readTriggerTargetV1,
  ReviewStartTerminalValueV1Schema,
  openAccountScopedBlobCiphertext,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  sameAutomationAccountCurrentnessWitnessV1,
  sameAutomationAccountContentIdentityV1,
  WorkflowRunRecipientCensusResponseV1Schema,
  WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema,
  prepareWorkflowRunDataKeyV1,
  resolveWorkflowRunDataKeyV1,
  runWorkflowRecipientKeyPreparationV1,
  type WorkflowRunEncryptionV1,
  type WorkflowRunRecipientCensusResponseV1,
  type WorkflowCheckpointEnvelopeV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowRunSummaryV1,
  type WorkflowRunStepProgressV1,
  type TriggerTargetV1,
  type WorkflowDefinitionV1,
  type MaterializeWorkflowAcceptedSnapshotV1Input,
} from '@happier-dev/protocol';
import { assertControllerDominates, type ActionExecutorContext } from '@happier-dev/protocol/actions';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { createWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';

import { getRandomBytes } from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createWorkflowDefinitionActions } from '@/session/actions/workflowDefinitions';
import { PushNotificationClient } from '@/api/pushNotifications';
import { resolveWorkspaceRefById } from '@/settings/accountSettings/workspaceRefsV1';
import { createWorkflowRunCommittedNotificationHandler, createWorkflowRunReviewEntryNotificationHandler } from '@/notifications/activity/dispatchWorkflowRunUpdateNotification';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import {
  createWorkflowCoordinator,
  WorkflowControlBoundary,
  workflowInvocationKey,
  type WorkflowCoordinatorInvocation,
  type WorkflowCoordinatorResult,
  type WorkflowCoordinatorStore,
  type WorkflowAcceptedAuthorizationCurrentness,
  type WorkflowStepExecutor,
} from './coordinator';
import { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { createCoordinatorWorkspaceResolver } from './resolveWorkflowWorkspace';
import { prepareWorkflowAcceptedWorkspaceTarget } from './resolveWorkflowWorkspace';
import { bindAutomationWorkflowInputs, resolveAutomationWorkflowOccurrenceSeed, WorkflowInputResolutionError } from './input';
import { shouldPublishWorkflowSharedConversation, type WorkflowConversationBinding } from './workflowConversation';
import type { WorkflowProducerBinding, WorkflowInvocationBindingRow } from './workflowScopeBinding';
import { materializeWorkflowContainerResult } from './workflowContainerResult';
import type { WorkflowClaimForCoordination } from './worker';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { StoredCredentials } from '@/persistence';
import type { AgentState } from '@/api/types';
import { createProductionWorkflowSessionContextReader } from './workflowSessionContext';
import {
  AgentStateRequestStore,
  type AgentStateRequestPersistenceTarget,
} from '@/agent/permissions/agentStateRequestStore';
import {
  createProductionWorkflowConversationOwner,
  createProductionFreshWorkflowSessionConversation,
  createProductionWorkflowSessionStepExecutor,
  createWorkflowSessionStepExecutor,
  WorkflowSessionCompositionError,
} from './sessionStepExecutor';
import {
  createWorkflowDetachedExecutionRunStepExecutor,
  createWorkflowStepExecutorDispatcher,
  prepareWorkflowDetachedExecutionRunStep,
  WorkflowExecutionRunCompositionError,
  type WorkflowDetachedExecutionRunStepExecutorDeps,
} from './executionRunStepExecutor';

type StorageClient = ReturnType<typeof createWorkflowRunStorageClient>;
type SealMode =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; runDataKey: Uint8Array; randomBytes: typeof getRandomBytes }>;

type RunStorageSnapshot = Readonly<{
  run: WorkflowRunSummaryV1;
  acceptedEnvelope: string;
  checkpointEnvelope: string | null;
  resultEnvelope: string | null;
  keyCensus: WorkflowRunRecipientCensusResponseV1;
}>;

export function projectWorkflowRootSettlementLifecycle(
  resultState: WorkflowCoordinatorResult['state'],
  currentLifecycle: WorkflowRunInvocationIndexV1['lifecycle'],
): WorkflowRunInvocationIndexV1['lifecycle'] {
  if (resultState === 'succeeded') return 'completed';
  if (resultState === 'cancelled') return 'cancelled';
  if (resultState === 'outcome_uncertain') return 'outcome_uncertain';
  if (resultState === 'failed') return 'failed';
  return currentLifecycle;
}

export function projectWorkflowTerminalCustodySettlement(
  resultState: WorkflowCoordinatorResult['state'],
): 'settled' | undefined {
  if (resultState === 'paused' || resultState === 'interrupted' || resultState === 'waiting_for_review') return undefined;
  return 'settled';
}

function parseAutomationStoredEnvelope(serialized: string) {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const parsed = AutomationStoredContentEnvelopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function openAutomationStoredContent(params: Readonly<{
  serialized: string;
  kind: 'automation_template_payload' | 'automation_trigger_evidence';
  encryption: AvailableAutomationAccountEncryptionV1;
}>): unknown | null {
  const envelope = parseAutomationStoredEnvelope(params.serialized);
  if (!envelope) return null;
  if (params.encryption.witness.mode === 'plain') return envelope.t === 'plain' ? envelope.v : null;
  if (envelope.t !== 'encrypted' || !isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)) return null;
  try {
    return openAccountScopedBlobCiphertext({
      kind: params.kind,
      material: params.encryption.material.material,
      ciphertext: envelope.c,
    })?.value ?? null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_storage_response_invalid');
  return value as Readonly<Record<string, unknown>>;
}

function parseRunSnapshot(value: unknown): RunStorageSnapshot {
  const record = asRecord(value);
  const run = WorkflowRunSummaryV1Schema.parse(record.run);
  if (typeof record.acceptedEnvelope !== 'string'
    || (record.checkpointEnvelope !== null && typeof record.checkpointEnvelope !== 'string')
    || (record.resultEnvelope !== null && typeof record.resultEnvelope !== 'string')) {
    throw new Error('workflow_storage_response_invalid');
  }
  return {
    run,
    acceptedEnvelope: record.acceptedEnvelope,
    checkpointEnvelope: record.checkpointEnvelope,
    resultEnvelope: record.resultEnvelope,
    keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse(record.keyCensus),
  };
}

function sealMode(encryption: WorkflowRunEncryptionV1): SealMode {
  return encryption.runCrypto.mode === 'plain' ? encryption.runCrypto : { ...encryption.runCrypto, randomBytes: getRandomBytes };
}

function openMode(encryption: WorkflowRunEncryptionV1) {
  return encryption.runCrypto;
}

type PersistedInvocation = Readonly<{
  index: WorkflowRunInvocationIndexV1;
  progress: WorkflowProgressEnvelopeV1;
}>;

/** Internal durable row owner, exported only so its persistence concurrency contract can be tested at the real boundary. */
export class DurableWorkflowCoordinatorStore implements WorkflowCoordinatorStore {
  private readonly records = new Map<string, WorkflowCoordinatorInvocation>();
  private readonly recordsById = new Map<string, WorkflowCoordinatorInvocation>();
  private readonly currentSlots = new Map<string, WorkflowCoordinatorInvocation>();
  private readonly persisted = new Map<string, PersistedInvocation>();
  private readonly materializedContainers = new Map<string, import('./input').WorkflowJsonValue>();
  private readonly loadedParentSlots = new Set<string>();
  private readonly progressMembers = new Map<string, {
    members: Map<string, WorkflowRunInvocationIndexV1>; completed: number;
  }>();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly invocationMutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly params: {
      accountId: string;
      runId: string;
      parentAttempt: number;
      storage: Pick<StorageClient, 'execute'>;
      encryption: WorkflowRunEncryptionV1;
      rootRecordId: string;
      checkpoint: WorkflowCheckpointEnvelopeV1;
      revision: number;
      authoredDefinition?: WorkflowDefinitionV1;
      definition?: WorkflowDefinitionV1;
      projectionExpectedRevision?: number;
    },
  ) {}

  static async load(params: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]): Promise<DurableWorkflowCoordinatorStore> {
    const store = new DurableWorkflowCoordinatorStore(params);
    await store.loadInvocation(params.rootRecordId);
    return store;
  }

  private async loadInvocation(invocationId: string): Promise<void> {
    const detailResponse = asRecord(await this.params.storage.execute({ operation: 'invocations.get', runId: this.params.runId, invocationId }));
    const invocation = asRecord(detailResponse.invocation);
    const detailIndex = asRecord(invocation.index);
    const index = WorkflowRunInvocationIndexV1Schema.parse(detailIndex);
    const contentEnvelope = invocation.contentEnvelope;
    if (typeof contentEnvelope !== 'string') throw new Error('workflow_storage_response_invalid');
    const opened = openWorkflowProgressStoredEnvelopeV1({
      ...openMode(this.params.encryption),
      binding: {
        v: 1, purpose: 'invocation_progress', accountId: this.params.accountId, runId: this.params.runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt,
      },
      envelope: parseWorkflowStoredContentEnvelopeV1(contentEnvelope),
    });
    if (opened.kind !== 'available') throw new Error('workflow_invocation_content_unavailable');
    if (index.parentRecordId && !this.recordsById.has(index.parentRecordId)) {
      await this.loadInvocation(index.parentRecordId);
    }
    this.remember(index, WorkflowProgressEnvelopeV1Schema.parse(opened.content));
    if (invocation.parentRevision !== undefined) {
      this.params.revision = Math.max(this.params.revision, WorkflowRunSummaryV1Schema.shape.revision.parse(invocation.parentRevision));
    }
  }

  private async loadParentSlot(parentRecordId: string, memberOrdinal: string): Promise<void> {
    const slotKey = `${parentRecordId}:${memberOrdinal}`;
    if (this.loadedParentSlots.has(slotKey)) return;
    const response = asRecord(await this.params.storage.execute({
      operation: 'invocations.current', runId: this.params.runId, parentRecordId, memberOrdinal,
    }));
    if (response.invocation !== null && response.invocation !== undefined) {
      const invocation = asRecord(response.invocation);
      const index = WorkflowRunInvocationIndexV1Schema.parse(asRecord(invocation.index));
      if (index.runId !== this.params.runId
        || index.parentRecordId !== parentRecordId
        || index.memberOrdinal !== memberOrdinal) {
        throw new Error('workflow_storage_response_invalid');
      }
      const contentEnvelope = invocation.contentEnvelope;
      if (typeof contentEnvelope !== 'string') throw new Error('workflow_storage_response_invalid');
      const opened = openWorkflowProgressStoredEnvelopeV1({
        ...openMode(this.params.encryption),
        binding: {
          v: 1, purpose: 'invocation_progress', accountId: this.params.accountId, runId: this.params.runId,
          recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
          memberOrdinal: index.memberOrdinal, attempt: index.attempt,
        },
        envelope: parseWorkflowStoredContentEnvelopeV1(contentEnvelope),
      });
      if (opened.kind !== 'available') throw new Error('workflow_invocation_content_unavailable');
      this.remember(index, WorkflowProgressEnvelopeV1Schema.parse(opened.content));
    }
    // An exact empty read is reusable for the lifetime of this claimed store:
    // admission remains CAS-owned by the server and this process records every
    // successful admission below before another local read can observe it.
    this.loadedParentSlots.add(slotKey);
  }

  private remember(index: WorkflowRunInvocationIndexV1, progress: WorkflowProgressEnvelopeV1): WorkflowCoordinatorInvocation {
    const cached = this.recordsById.get(index.id);
    if (cached?.contentRevision !== undefined && BigInt(cached.contentRevision) > BigInt(index.contentRevision)) return cached;
    const attempt = Number(index.attempt);
    const key = workflowInvocationKey({ runId: this.params.runId, blockId: progress.invocationPath.blockId, scope: progress.invocationPath.scope, attempt });
    const record: WorkflowCoordinatorInvocation = {
      key, recordId: index.id, sequence: index.sequence, contentRevision: index.contentRevision, blockKind: progress.blockKind,
      ...(progress.review ? { review: progress.review } : {}), logicalInvocationRecordId: progress.logicalInvocationRecordId,
      runId: index.runId, blockId: progress.invocationPath.blockId,
      memberOrdinal: index.memberOrdinal,
      ...(index.parentRecordId ? { parentKey: this.recordsById.get(index.parentRecordId)?.key } : {}),
      path: progress.invocationPath, attempt, acceptedAtMs: Date.parse(index.createdAt), lifecycle: index.lifecycle,
      ...(progress.result === undefined ? {} : { result: progress.result }),
      ...(progress.resultContract === undefined ? {} : { resultContract: progress.resultContract }),
      ...(progress.usage === undefined ? {} : { usage: progress.usage }),
      ...(progress.reason ? { reason: progress.reason.code } : {}),
      ...(progress.reason?.message !== undefined ? { reasonMessage: progress.reason.message } : {}),
      ...(progress.validationIssues ? { validationIssues: progress.validationIssues } : {}),
      ...(progress.execution ? { execution: progress.execution } : {}),
      ...(progress.sharedConversationInvocationRecordId ? { sharedConversationInvocationRecordId: progress.sharedConversationInvocationRecordId } : {}),
      ...(progress.observationDeadline ? { observationDeadline: progress.observationDeadline } : {}),
      ...(progress.input === undefined ? {} : { input: WorkflowAuthoredInputV1Schema.parse(progress.input) }),
      ...(progress.previousAttemptRecordId ? { previousAttemptRecordId: progress.previousAttemptRecordId } : {}),
      ...(progress.recovery ? { recovery: progress.recovery } : {}),
      ...(progress.workspace ? { workspace: progress.workspace } : {}),
      ...(progress.frame ? { frame: progress.frame } : {}),
      ...(progress.container ? { container: progress.container } : {}),
      ...(progress.containerResult ? { containerResult: progress.containerResult } : {}),
    };
    this.records.set(key, record);
    this.recordsById.set(index.id, record);
    const slot = `${index.parentRecordId}:${index.memberOrdinal}`;
    const current = this.currentSlots.get(slot);
    if (!current || current.recordId === record.recordId || record.attempt > current.attempt) this.currentSlots.set(slot, record);
    this.persisted.set(key, { index, progress });
    if (index.parentRecordId) {
      const parent = this.recordsById.get(index.parentRecordId);
      for (const [parentKey, projection] of this.progressMembers) {
        const previous = projection.members.get(index.memberOrdinal);
        const ownSlot = parent?.key === parentKey && (!previous || previous.parentRecordId !== index.parentRecordId
          || BigInt(index.attempt) >= BigInt(previous.attempt));
        const inheritedRow = previous?.id === index.id
          && BigInt(index.contentRevision) >= BigInt(previous.contentRevision);
        if (ownSlot || inheritedRow) {
          projection.completed += Number(index.lifecycle === 'completed') - Number(previous?.lifecycle === 'completed');
          projection.members.set(index.memberOrdinal, index);
        }
      }
    }
    return record;
  }

  read = (key: string) => this.records.get(key);
  readByLogicalInvocation = async (id: string) => {
    const cached = this.recordsById.get(id);
    if (cached) return cached;
    await this.loadInvocation(id);
    return this.recordsById.get(id);
  };
  readInvocationBindingRow = async (id: string): Promise<WorkflowInvocationBindingRow | undefined> => {
    const record = await this.readByLogicalInvocation(id);
    return record ? this.persisted.get(record.key) : undefined;
  };
  readCurrent = async ({ runId, blockId, parentKey, memberOrdinal }: Parameters<WorkflowCoordinatorStore['readCurrent']>[0]) => {
    let parent = parentKey ? this.records.get(parentKey) : undefined;
    if (parentKey && !parent) return undefined;
    for (;;) {
      const parentRecordId = parent?.recordId ?? this.params.rootRecordId;
      if (memberOrdinal !== undefined) await this.loadParentSlot(parentRecordId, memberOrdinal);
      const selected = this.currentSlots.get(`${parentRecordId}:${memberOrdinal}`);
      if (selected?.runId === runId && selected.blockId === blockId) return selected;
      // Like current-member enumeration, exact lookup inherits the nearest
      // unreplaced slot across every recorded structural recovery.
      if (!parent?.previousAttemptRecordId) return undefined;
      parent = await this.readByLogicalInvocation(parent.previousAttemptRecordId);
      if (!parent) return undefined;
    }
  };

  listCurrentMembers = async (parentKey: string): Promise<readonly WorkflowRunInvocationIndexV1[]> => {
    let parent = this.records.get(parentKey);
    if (!parent) throw new Error('workflow_parent_invocation_missing');
    const members = new Map<string, WorkflowRunInvocationIndexV1>();
    // A recovered structural frame inherits only slots not replaced under its
    // new parent identity. Enumerating indices does not open their content.
    while (parent) {
      let cursor: string | undefined;
      do {
        const page = asRecord(await this.params.storage.execute({ operation: 'invocations.list', runId: this.params.runId,
          parentRecordId: parent.recordId, ...(cursor ? { cursor } : {}), pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }));
        const indices = Array.isArray(page.invocations) ? page.invocations.map((value) => WorkflowRunInvocationIndexV1Schema.parse(value)) : [];
        for (const index of indices) if (!members.has(index.memberOrdinal)) members.set(index.memberOrdinal, index);
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      } while (cursor);
      parent = parent.previousAttemptRecordId ? await this.readByLogicalInvocation(parent.previousAttemptRecordId) : undefined;
    }
    return [...members.values()].sort((left, right) => BigInt(left.memberOrdinal) < BigInt(right.memberOrdinal) ? -1
      : BigInt(left.memberOrdinal) > BigInt(right.memberOrdinal) ? 1 : 0);
  };

  private serializeProgress(binding: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['binding'], progress: WorkflowProgressEnvelopeV1): string {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      ...sealMode(this.params.encryption), binding, progress,
    }));
  }

  private serializeCheckpoint(checkpoint: WorkflowCheckpointEnvelopeV1): string {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      ...sealMode(this.params.encryption),
      binding: { v: 1, purpose: 'checkpoint', accountId: this.params.accountId, runId: this.params.runId },
      checkpoint,
    }));
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializedInvocation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.invocationMutationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.invocationMutationTails.set(key, tail);
    void tail.finally(() => {
      if (this.invocationMutationTails.get(key) === tail) this.invocationMutationTails.delete(key);
    });
    return result;
  }

  ensureIntent = async (invocation: WorkflowCoordinatorInvocation & Readonly<{ blockKind: WorkflowProgressEnvelopeV1['blockKind'] }>): Promise<WorkflowCoordinatorInvocation> => await this.serialized(async () => {
    const parentRecordId = invocation.parentKey
      ? this.records.get(invocation.parentKey)?.recordId
      : this.params.rootRecordId;
    if (!parentRecordId) throw new Error('workflow_parent_invocation_missing');
    await this.loadParentSlot(parentRecordId, invocation.memberOrdinal ?? '0');
    const existing = this.records.get(invocation.key);
    if (existing) return existing;
    const sequence = this.params.checkpoint.nextSequence;
    if (invocation.memberOrdinal === undefined) throw new Error('workflow_member_ordinal_missing');
    const memberOrdinal = invocation.memberOrdinal;
    const progress: WorkflowProgressEnvelopeV1 = {
      kind: 'happier.workflow-progress.v1', invocationPath: invocation.path,
      blockKind: invocation.blockKind, attempt: '0',
      logicalInvocationRecordId: invocation.logicalInvocationRecordId ?? invocation.recordId,
      ...(invocation.execution ? { execution: invocation.execution } : {}),
      ...(invocation.observationDeadline ? { observationDeadline: invocation.observationDeadline } : {}),
      ...(invocation.input ? { input: StrictJsonValueSchema.parse(invocation.input) } : {}),
      ...(invocation.resultContract === undefined ? {} : { resultContract: invocation.resultContract }),
      ...(invocation.workspace ? { workspace: invocation.workspace } : {}),
      ...(invocation.frame ? { frame: invocation.frame } : {}),
      ...(invocation.container ? { container: invocation.container } : {}),
      ...(invocation.containerResult ? { containerResult: invocation.containerResult } : {}),
    };
    const binding = {
      v: 1 as const, purpose: 'invocation_progress' as const, accountId: this.params.accountId, runId: this.params.runId,
      recordId: invocation.recordId, sequence, parentRecordId, memberOrdinal, attempt: '0',
    };
    const checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({
      ...this.params.checkpoint,
      nextSequence: (BigInt(sequence) + 1n).toString(),
    });
    const admission = {
      operation: 'invocations.admit', runId: this.params.runId, parentAttempt: this.params.parentAttempt,
      accountCurrentness: this.params.encryption.witness,
      checkpointEnvelope: this.serializeCheckpoint(checkpoint),
      invocations: [{ id: invocation.recordId, sequence, parentRecordId, memberOrdinal, contentEnvelope: this.serializeProgress(binding, progress) }],
    } as const;
    let response: Readonly<Record<string, unknown>>;
    for (;;) {
      const expectedRevision = this.params.revision;
      try {
        response = asRecord(await this.params.storage.execute({ ...admission, expectedRevision }));
        break;
      } catch (error) {
        const failure = error !== null && typeof error === 'object' && 'response' in error ? error.response : undefined;
        const data = failure !== null && typeof failure === 'object' && 'data' in failure ? failure.data : undefined;
        if (data === null || typeof data !== 'object' || !('error' in data) || data.error !== 'currentness_conflict') throw error;
        const snapshot = parseRunSnapshot(await this.params.storage.execute({ operation: 'get', runId: this.params.runId }));
        if (snapshot.run.state === 'cancelled') throw new WorkflowControlBoundary('cancelled');
        if (snapshot.run.state === 'pause_requested' || snapshot.run.state === 'paused') throw new WorkflowControlBoundary('paused');
        if ((snapshot.run.state !== 'running' && snapshot.run.state !== 'claimed') || snapshot.run.revision <= expectedRevision) throw error;
        // An independently committed sibling hold may precede its HTTP acknowledgement.
        // Retry only an observed advancing parent token, retaining the exact row and sealed bytes.
        this.params.revision = Math.max(this.params.revision, snapshot.run.revision);
      }
    }
    const admitted = Array.isArray(response.invocations) ? WorkflowRunInvocationIndexV1Schema.parse(response.invocations[0]) : null;
    if (!admitted || typeof response.parentRevision !== 'number') throw new Error('workflow_storage_response_invalid');
    this.params.revision = Math.max(this.params.revision, response.parentRevision);
    this.params.checkpoint = checkpoint;
    const pending = this.remember(admitted, progress);
    this.loadedParentSlots.add(`${parentRecordId}:${memberOrdinal}`);
    if (invocation.lifecycle === 'pending') return pending;
    return await this.commitFact({ key: pending.key, lifecycle: invocation.lifecycle });
  });

  private async commitFactNow(
    fact: Parameters<WorkflowCoordinatorStore['commitFact']>[0],
    stepProgress?: WorkflowRunStepProgressV1,
  ): Promise<WorkflowCoordinatorInvocation> {
    const current = this.records.get(fact.key);
    const persisted = this.persisted.get(fact.key);
    if (!current || !persisted) throw new Error('workflow_invocation_intent_missing');
    if (current.lifecycle === 'waiting_for_review' && fact.interaction !== undefined) return current;
    const { key: _key, lifecycle: _lifecycle, review, ...ownedFact } = fact;
    const { reason: _reason, reasonMessage: _reasonMessage, ...withoutInvalidResultReason } = ownedFact;
    const publishedResultWins = fact.lifecycle === 'waiting_for_review' && fact.reason === 'invalid_result_contract'
      && persisted.progress.review?.resultSource?.kind === 'published' && persisted.progress.result !== undefined;
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ ...applyWorkflowInvocationFactV1(persisted.progress,
      WorkflowInvocationFactV1Schema.parse(publishedResultWins ? withoutInvalidResultReason : ownedFact)),
      ...(review ? { review: { ...review, ...(persisted.progress.review?.resultSource ? { resultSource: persisted.progress.review.resultSource } : {}) } } : {}),
      ...(stepProgress ? { stepProgress } : {}) });
    const index = persisted.index;
    const binding = {
      v: 1 as const, purpose: 'invocation_progress' as const, accountId: this.params.accountId, runId: this.params.runId,
      recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
      memberOrdinal: index.memberOrdinal, attempt: index.attempt,
    };
    let updatedIndex: WorkflowRunInvocationIndexV1;
    try {
      const { parentRevision, ...updated } = WorkflowInvocationFactResultV1Schema.parse(await this.params.storage.execute({
        operation: 'invocations.fact', runId: this.params.runId,
        ...(stepProgress && this.params.projectionExpectedRevision !== undefined
          ? { expectedRevision: this.params.projectionExpectedRevision, resolution: 'root_list_progress' }
          : { parentAttempt: this.params.parentAttempt }),
        accountCurrentness: this.params.encryption.witness,
        invocationId: index.id, invocationAttempt: index.attempt, expectedLifecycle: index.lifecycle, expectedContentRevision: index.contentRevision,
        lifecycle: fact.lifecycle, contentEnvelope: this.serializeProgress(binding, progress),
      }));
      this.params.revision = Math.max(this.params.revision, parentRevision);
      updatedIndex = updated;
    } catch (error) {
      // Cancellation changes the exact row lifecycle at the server. Reload the
      // row once so that this CAS loser cannot overwrite or hide that control.
      await this.loadInvocation(index.id);
      const refreshed = this.records.get(fact.key);
      if (fact.lifecycle === 'admitting') {
        // A lost admission acknowledgement is ambiguous, and a repeated
        // admitting fact may have lost its exact parent/control predicate.
        // Reloading the same row cannot authorize either input release.
        throw error;
      }
      const workspaceMatches = fact.workspace === undefined
        || ((fact.workspace.creationIntent === undefined
          || sameStrictJsonValue(refreshed?.workspace?.creationIntent, fact.workspace.creationIntent))
          && (fact.workspace.descriptor === undefined
            || sameStrictJsonValue(refreshed?.workspace?.descriptor, fact.workspace.descriptor)));
      const sharedConversation = fact.sharedConversationInvocationRecordId;
      const sharedConversationMatches = sharedConversation === undefined
        || (['session', 'detached_run'] as const).every((targetClass) => (
          sharedConversation[targetClass] === undefined
          || refreshed?.sharedConversationInvocationRecordId?.[targetClass] === sharedConversation[targetClass]
        ));
      if (refreshed?.lifecycle === fact.lifecycle
        && (fact.result === undefined || sameStrictJsonValue(refreshed.result, fact.result))
        && (fact.resultContract === undefined || sameStrictJsonValue(refreshed.resultContract, fact.resultContract))
        && (fact.usage === undefined || sameStrictJsonValue(refreshed.usage, fact.usage))
        && (fact.reason === undefined || refreshed.reason === fact.reason)
        && (fact.reasonMessage === undefined || refreshed.reasonMessage === fact.reasonMessage)
        && (fact.execution === undefined || sameStrictJsonValue(refreshed.execution, fact.execution))
        && (fact.observationDeadline === undefined || sameStrictJsonValue(refreshed.observationDeadline, fact.observationDeadline))
        && (fact.input === undefined || sameStrictJsonValue(refreshed.input, fact.input))
        && (fact.container === undefined || sameStrictJsonValue(refreshed.container, fact.container))
        && (fact.containerResult === undefined || sameStrictJsonValue(refreshed.containerResult, fact.containerResult))
        && (stepProgress === undefined || sameStrictJsonValue(this.persisted.get(fact.key)?.progress.stepProgress, stepProgress))
        && workspaceMatches
        && sharedConversationMatches) {
        return refreshed;
      }
      const actionLaunch = fact.execution?.kind === 'action' ? fact.execution : undefined;
      const matchesActionRequest = (execution: WorkflowCoordinatorInvocation['execution']) => actionLaunch
        && execution?.kind === 'action' && execution.actionId === actionLaunch.actionId
        && execution.actionRequestId === actionLaunch.actionRequestId && execution.localInputId === actionLaunch.localInputId
        && sameStrictJsonValue(execution.input, actionLaunch.input);
      const exactAcceptance = fact.execution?.kind === 'session'
        ? sameStrictJsonValue(current.execution, fact.execution) && sameStrictJsonValue(refreshed?.execution, fact.execution)
        : actionLaunch?.output !== undefined && actionLaunch.awaitedRuns !== undefined
          && matchesActionRequest(current.execution) && matchesActionRequest(refreshed?.execution);
      if (current.lifecycle === 'admitting' && fact.lifecycle === 'running'
        && refreshed?.lifecycle === 'cancel_requested' && exactAcceptance) {
        // A positive host acceptance or exact Action launch response arrived
        // while Cancel swept the row. Preserve it in the refreshed content,
        // without releasing input or reopening cancellation custody.
        return await this.commitFactNow({ ...fact, lifecycle: 'cancel_requested' });
      }
      if (refreshed?.lifecycle === 'cancel_requested' || refreshed?.lifecycle === 'cancelled') {
        throw new WorkflowControlBoundary('cancelled');
      }
      if (refreshed?.lifecycle === 'superseded') throw error;
      if (refreshed?.contentRevision !== current.contentRevision && refreshed?.lifecycle === current.lifecycle) {
        if (stepProgress) {
          // An aggregate is not an independent row fact: after a competing
          // publisher wins, recompute from current slots instead of replaying it.
          this.loadedParentSlots.clear();
          this.progressMembers.clear();
          return await this.commitFactNow(fact, await this.projectStepProgress());
        }
        return await this.commitFactNow(fact);
      }
      throw error;
    }
    return this.remember(updatedIndex, progress);
  }

  commitFact = async (
    fact: Parameters<WorkflowCoordinatorStore['commitFact']>[0],
  ): Promise<WorkflowCoordinatorInvocation> => {
    const result = await this.serializedInvocation(fact.key, async () => await this.commitFactNow(fact));
    const parentId = this.persisted.get(result.key)?.index.parentRecordId;
    const parent = parentId ? this.recordsById.get(parentId) : undefined;
    if (parentId === this.params.rootRecordId || (parent?.blockKind === 'loop'
      && this.persisted.get(parent.key)?.index.parentRecordId === this.params.rootRecordId)) await this.refreshStepProgress();
    return result;
  };

  private async projectStepProgress(): Promise<WorkflowRunStepProgressV1> {
    const definition = this.params.authoredDefinition;
    const root = this.recordsById.get(this.params.rootRecordId);
    if (!definition || !root) throw new Error('workflow_root_invocation_missing');
    let completed = 0;
    let currentLoop: WorkflowRunStepProgressV1['currentLoop'];
    for (const [ordinal, block] of definition.blocks.entries()) {
      const invocation = await this.readCurrent({ runId: this.params.runId, blockId: block.id,
        scope: [], parentKey: root.key, memberOrdinal: String(ordinal) });
      if (invocation?.lifecycle === 'completed') completed += 1;
      if (block.kind !== 'loop' || !invocation || invocation.lifecycle === 'completed') continue;
      const loop = invocation.container;
      if (loop?.kind !== 'loop') continue;
      const frozenBlock = this.params.definition?.blocks[ordinal] ?? block;
      const total = loop.mode === 'items' ? Number(loop.itemCount) : loop.mode === 'count' ? Number(loop.count)
        : frozenBlock.kind === 'loop' && frozenBlock.id === block.id && 'maxIterations' in frozenBlock.repetition
          ? frozenBlock.repetition.maxIterations : undefined;
      if (typeof total !== 'number') continue;
      let projection = this.progressMembers.get(invocation.key);
      if (!projection) {
        const members = new Map((await this.listCurrentMembers(invocation.key)).map((index) => [index.memberOrdinal, index]));
        // A local parallel frame may commit while the initial page is in flight.
        for (const row of this.currentSlots.values()) {
          const index = this.persisted.get(row.key)?.index;
          if (index?.parentRecordId === invocation.recordId) {
            const prior = members.get(index.memberOrdinal);
            if (!prior || prior.parentRecordId !== index.parentRecordId
              || BigInt(index.attempt) > BigInt(prior.attempt)
              || (index.attempt === prior.attempt && BigInt(index.contentRevision) >= BigInt(prior.contentRevision))) {
              members.set(index.memberOrdinal, index);
            }
          }
        }
        projection = { members, completed: [...members.values()].filter((index) => index.lifecycle === 'completed').length };
        this.progressMembers.set(invocation.key, projection);
      }
      // nextMemberIndex is the admission frontier, not a completed-item count.
      currentLoop = { completed: projection.completed, total };
    }
    return { completed, total: definition.blocks.length, ...(currentLoop ? { currentLoop } : {}) };
  }

  /** The executing/recovery owner publishes counts; list readers never reconstruct private structure. */
  refreshStepProgress = async (): Promise<void> => {
    const root = this.recordsById.get(this.params.rootRecordId);
    if (!this.params.authoredDefinition || !root) return;
    await this.serializedInvocation(root.key, async () => {
      const stepProgress = await this.projectStepProgress();
      const persisted = this.persisted.get(root.key);
      if (sameStrictJsonValue(persisted?.progress.stepProgress, stepProgress)) return;
      const currentRoot = this.recordsById.get(this.params.rootRecordId);
      if (!currentRoot) throw new Error('workflow_root_invocation_missing');
      await this.commitFactNow({ key: root.key, lifecycle: currentRoot.lifecycle }, stepProgress);
    });
  };

  createInteractionPersistenceTarget(key: string): AgentStateRequestPersistenceTarget {
    const persisted = this.persisted.get(key);
    if (!persisted) throw new Error('workflow_invocation_intent_missing');
    return Object.freeze({
      scopeId: `${this.params.runId}:${persisted.index.id}`,
      readState: () => {
        const interaction = this.persisted.get(key)?.progress.interaction;
        return interaction && typeof interaction === 'object' && !Array.isArray(interaction)
          ? interaction as AgentState
          : null;
      },
      updateState: async (updater: (state: AgentState) => AgentState) => {
        await this.serializedInvocation(key, async () => {
          const current = this.persisted.get(key);
          if (!current) throw new Error('workflow_invocation_intent_missing');
          const interaction = current.progress.interaction;
          const currentState = interaction && typeof interaction === 'object' && !Array.isArray(interaction)
            ? interaction as AgentState
            : {};
          const updated = updater(currentState);
          const nextInteraction = StrictJsonValueSchema.parse(updated);
          const requests = updated.requests;
          const hasOutstandingRequests = requests !== null
            && typeof requests === 'object'
            && !Array.isArray(requests)
            && Object.keys(requests).length > 0;
          const canEnterWaitingForApproval = current.index.lifecycle === 'admitting'
            || current.index.lifecycle === 'running'
            || current.index.lifecycle === 'waiting_for_approval';
          const nextLifecycle = hasOutstandingRequests && canEnterWaitingForApproval
            ? 'waiting_for_approval' as const
            : current.index.lifecycle === 'waiting_for_approval'
              ? 'running' as const
              : current.index.lifecycle;
          const binding = {
            v: 1 as const,
            purpose: 'invocation_progress' as const,
            accountId: this.params.accountId,
            runId: this.params.runId,
            recordId: current.index.id,
            sequence: current.index.sequence,
            parentRecordId: current.index.parentRecordId,
            memberOrdinal: current.index.memberOrdinal,
            attempt: current.index.attempt,
          };
          const candidate = WorkflowProgressEnvelopeV1Schema.parse({
            ...current.progress,
            interaction: nextInteraction,
          });
          let serializedCandidate: string;
          try {
            serializedCandidate = this.serializeProgress(binding, candidate);
          } catch (error) {
            const issues = error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)
              ? (error as { issues: Array<{ message?: unknown }> }).issues
              : [];
            if (!issues.some((issue) => issue.message === 'Stored Automation envelope exceeds its UTF-8 byte limit')) {
              throw error;
            }
            throw createWorkflowInteractionCapacityError();
          }
          if (new TextEncoder().encode(serializedCandidate).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
            throw createWorkflowInteractionCapacityError();
          }
          await this.commitFactNow({
            key,
            lifecycle: nextLifecycle,
            interaction: nextInteraction,
          });
        });
      },
    });
  }

  readContainerResult: WorkflowCoordinatorStore['readContainerResult'] = async (record, resolveWorkflowOutput) => {
    const cached = this.materializedContainers.get(record.key);
    if (cached !== undefined) return cached;
    const result = await materializeWorkflowContainerResult(record, this, resolveWorkflowOutput);
    if (result !== undefined) this.materializedContainers.set(record.key, result);
    return result;
  };

  commitContainerResult = async ({ key }: Readonly<{ key: string }>) => {
    const current = this.records.get(key);
    if (!current) throw new Error('workflow_invocation_intent_missing');
    return await this.commitFact({
      key,
      lifecycle: 'completed',
      containerResult: { kind: 'container', containerRecordId: current.recordId },
    });
  };

  commitSharedConversation = async (params: Parameters<NonNullable<WorkflowCoordinatorStore['commitSharedConversation']>>[0]): Promise<void> => {
    const scopeOwner = await this.readByLogicalInvocation(params.scopeOwnerKey);
    if (!scopeOwner) throw new Error('workflow_conversation_scope_missing');
    await this.serializedInvocation(scopeOwner.key, async () => {
      const owner = this.records.get(scopeOwner.key);
      if (!owner) throw new Error('workflow_conversation_scope_missing');
      const leaf = await this.readByLogicalInvocation(params.invocationRecordId);
      if (!leaf?.execution || leaf.execution.kind !== params.targetClass) throw new Error('workflow_conversation_unavailable');
      const previousId = owner.sharedConversationInvocationRecordId?.[params.targetClass];
      const previous = previousId ? await this.readByLogicalInvocation(previousId) : undefined;
      if (previousId && !previous?.execution) throw new Error('workflow_conversation_unavailable');
      if (!shouldPublishWorkflowSharedConversation({ current: previous?.execution, next: leaf.execution,
        replacesExecution: params.replacesExecution, currentSequence: previous?.sequence, nextSequence: leaf.sequence })) return;
      await this.commitFactNow({
        key: owner.key, lifecycle: owner.lifecycle,
        sharedConversationInvocationRecordId: { [params.targetClass]: params.invocationRecordId },
      });
    });
  };

  listByLifecycle = async ({ lifecycles }: Readonly<{
    runId: string;
    lifecycles: readonly WorkflowRunInvocationIndexV1['lifecycle'][];
  }>) => {
    const selected: WorkflowCoordinatorInvocation[] = [];
    let cursor: string | undefined;
    do {
      const page = asRecord(await this.params.storage.execute({
        operation: 'invocations.list', runId: this.params.runId, lifecycles,
        ...(cursor ? { cursor } : {}),
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
      }));
      const indices = Array.isArray(page.invocations)
        ? page.invocations.map((value) => WorkflowRunInvocationIndexV1Schema.parse(value)) : [];
      for (const index of indices) {
        const cached = this.recordsById.get(index.id);
        if (!cached || cached.contentRevision !== index.contentRevision || cached.lifecycle !== index.lifecycle) await this.loadInvocation(index.id);
        const record = this.recordsById.get(index.id);
        if (record) selected.push(record);
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor);
    return selected;
  };

  async readFinalReviewFingerprint(reviewBlockIds: ReadonlySet<string>): Promise<string | undefined> {
    const records = await this.listByLifecycle({ runId: this.params.runId,
      lifecycles: ['completed', 'failed', 'cancelled', 'skipped', 'outcome_uncertain', 'needs_attention'] });
    const reviews = records.filter((record) => record.execution?.kind === 'action'
      ? record.execution.actionId === 'review.start'
      : record.blockKind === 'action' && reviewBlockIds.has(record.blockId));
    const latest = reviews.reduce<WorkflowCoordinatorInvocation | undefined>((current, record) =>
      !current || BigInt(record.sequence!) > BigInt(current.sequence!) ? record : current, undefined);
    if (!latest) return undefined;
    // Each engine is an item body under the same persisted panel container.
    // A standalone fan-out Action is already one typed panel value.
    const panelOf = (record: WorkflowCoordinatorInvocation): string => {
      let parent = record.parentKey ? this.read(record.parentKey) : undefined;
      while (parent) {
        if (parent.frame?.source.kind === 'item') return parent.parentKey ?? parent.key;
        parent = parent.parentKey ? this.read(parent.parentKey) : undefined;
      }
      return record.key;
    };
    const panel = panelOf(latest);
    let fingerprint: string | undefined;
    for (const record of reviews) {
      if (record.blockId !== latest.blockId || panelOf(record) !== panel) continue;
      if (record.lifecycle !== 'completed') return undefined;
      const result = ReviewStartTerminalValueV1Schema.safeParse(record.result);
      if (!result.success || !result.data.reviewedFingerprint || result.data.perEngineOutcome.length === 0
        || result.data.perEngineOutcome.some((engine) => engine.outcome !== 'completed'
          || engine.materialization?.kind !== 'complete')) return undefined;
      if (fingerprint !== undefined && fingerprint !== result.data.reviewedFingerprint) return undefined;
      fingerprint = result.data.reviewedFingerprint;
    }
    return fingerprint;
  }

  readFrontier = () => this.params.checkpoint.frontier;

  commitFrontier = async ({ nextBlockOrdinal }: Readonly<{ nextBlockOrdinal: number }>): Promise<void> => {
    if (this.params.checkpoint.frontier.nextBlockOrdinal >= nextBlockOrdinal) return;
    await this.serialized(async () => {
      if (this.params.checkpoint.frontier.nextBlockOrdinal >= nextBlockOrdinal) return;
      // A completed leaf may have advanced our parent token after Pause was
      // requested. That fresh token authorizes checkpoint progress, not Resume.
      const control = await this.readControl();
      if (control === 'cancel_requested') throw new WorkflowControlBoundary('cancelled');
      const checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({
        ...this.params.checkpoint,
        frontier: { ...this.params.checkpoint.frontier, nextBlockOrdinal,
          ...(control === 'pause_requested' ? { paused: true } : {}) },
      });
      const checkpointEnvelope = this.serializeCheckpoint(checkpoint);
      try {
        const run = WorkflowRunSummaryV1Schema.parse(await this.params.storage.execute({
          operation: 'transition', runId: this.params.runId, parentAttempt: this.params.parentAttempt,
          accountCurrentness: this.params.encryption.witness,
          expectedRevision: this.params.revision,
          state: control === 'pause_requested' ? 'pause_requested' : 'running', checkpointEnvelope,
        }));
        this.params.revision = Math.max(this.params.revision, run.revision);
        this.params.checkpoint = checkpoint;
      } catch (error) {
        const snapshot = parseRunSnapshot(await this.params.storage.execute({ operation: 'get', runId: this.params.runId }));
        const envelope = snapshot.checkpointEnvelope && parseWorkflowStoredContentEnvelopeV1(snapshot.checkpointEnvelope);
        if (!envelope) throw error;
        const opened = openWorkflowCheckpointStoredEnvelopeV1({
          ...openMode(this.params.encryption),
          binding: { v: 1, purpose: 'checkpoint', accountId: this.params.accountId, runId: this.params.runId },
          envelope,
        });
        if (opened.kind !== 'available') throw error;
        const current = WorkflowCheckpointEnvelopeV1Schema.parse(opened.content);
        this.params.revision = Math.max(this.params.revision, snapshot.run.revision);
        this.params.checkpoint = current;
        if (current.frontier.nextBlockOrdinal >= nextBlockOrdinal) return;
        if (snapshot.run.state === 'cancelled') throw new WorkflowControlBoundary('cancelled');
        if (snapshot.run.state !== 'pause_requested') throw error;
        const pausedCheckpoint = WorkflowCheckpointEnvelopeV1Schema.parse({
          ...current,
          frontier: { ...current.frontier, nextBlockOrdinal, paused: true },
        });
        const run = WorkflowRunSummaryV1Schema.parse(await this.params.storage.execute({
          operation: 'transition', runId: this.params.runId, parentAttempt: this.params.parentAttempt,
          accountCurrentness: this.params.encryption.witness,
          expectedRevision: snapshot.run.revision,
          state: 'pause_requested', checkpointEnvelope: this.serializeCheckpoint(pausedCheckpoint),
        }));
        this.params.revision = Math.max(this.params.revision, run.revision);
        this.params.checkpoint = pausedCheckpoint;
      }
    });
  };

  readControl = async () => {
    const snapshot = parseRunSnapshot(await this.params.storage.execute({ operation: 'get', runId: this.params.runId }));
    this.params.revision = Math.max(this.params.revision, snapshot.run.revision);
    const root = await this.refreshRootIndex();
    if (root?.lifecycle === 'cancel_requested' || root?.lifecycle === 'cancelled') {
      return 'cancel_requested' as const;
    }
    if (snapshot.run.state === 'cancelled') return 'cancel_requested' as const;
    if (snapshot.run.state === 'pause_requested' || snapshot.run.state === 'paused') return 'pause_requested' as const;
    return 'running' as const;
  };

  confirmReviewHolds: WorkflowCoordinatorStore['confirmReviewHolds'] = async ({ recordIds }) => {
    // The parent token precedes every exact row read. Never replace this token
    // with the mutable store revision after confirming the holds.
    const snapshot = parseRunSnapshot(await this.params.storage.execute({ operation: 'get', runId: this.params.runId }));
    const revision = snapshot.run.revision;
    this.params.revision = Math.max(this.params.revision, revision);
    const selected: WorkflowCoordinatorInvocation[] = [];
    for (const id of recordIds) {
      await this.loadInvocation(id);
      const record = this.recordsById.get(id);
      if (!record) throw new Error('workflow_invocation_intent_missing');
      selected.push(record);
    }
    const control = snapshot.run.state === 'cancelled' ? 'cancel_requested'
      : snapshot.run.state === 'pause_requested' || snapshot.run.state === 'paused' ? 'pause_requested' : 'running';
    return { revision, control, rows: selected };
  };

  admitReviewReplacement: WorkflowCoordinatorStore['admitReviewReplacement'] = async ({ prior, recordId, input }) => await this.serialized(async () => {
    for (;;) {
    await this.loadInvocation(prior.recordId);
    const current = this.recordsById.get(prior.recordId);
    if (!current) throw new Error('workflow_invocation_intent_missing');
    const persisted = this.persisted.get(current.key)!;
    if (current.lifecycle === 'completed') return current;
    if (current.lifecycle === 'superseded') {
      const index = persisted.index;
      this.loadedParentSlots.delete(`${index.parentRecordId}:${index.memberOrdinal}`);
      if (!index.parentRecordId) throw new Error('workflow_parent_invocation_missing');
      await this.loadParentSlot(index.parentRecordId, index.memberOrdinal);
      const replacement = this.recordsById.get(recordId);
      if (!replacement || replacement.previousAttemptRecordId !== prior.recordId) throw new Error('workflow_review_intent_conflict');
      return replacement;
    }
    if (classifyWorkflowHoldV1({ isCurrent: true, lifecycle: current.lifecycle,
      progress: persisted.progress }) !== 'generate') throw new Error('workflow_review_intent_conflict');
    if (current.review?.decision?.requestedFromContentRevision !== prior.review?.decision?.requestedFromContentRevision) return current;
    const index = persisted.index;
    const sequence = this.params.checkpoint.nextSequence;
    const attempt = (BigInt(index.attempt) + 1n).toString();
    const { review: _review, result: _result, reason: _reason, execution: _execution,
      observationDeadline: _deadline, usage: _usage, interaction: _interaction, ...retained } = persisted.progress;
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ ...retained, attempt,
      input: StrictJsonValueSchema.parse(input), previousAttemptRecordId: index.id,
      recovery: { conversation: 'same_conversation', input: { kind: 'replacement', value: input } } });
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const,
      accountId: this.params.accountId, runId: this.params.runId, recordId, sequence,
      parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt };
    const checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({ ...this.params.checkpoint,
      nextSequence: (BigInt(sequence) + 1n).toString() });
    let response: Readonly<Record<string, unknown>>;
    try { response = asRecord(await this.params.storage.execute({ operation: 'invocations.admit',
      runId: this.params.runId, parentAttempt: this.params.parentAttempt, accountCurrentness: this.params.encryption.witness,
      expectedRevision: this.params.revision, checkpointEnvelope: this.serializeCheckpoint(checkpoint),
      invocations: [{ id: recordId, sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal,
        replaces: { id: index.id, attempt: index.attempt, contentRevision: index.contentRevision },
        contentEnvelope: this.serializeProgress(binding, progress) }] })); }
    catch (error) {
      const before = this.params.revision;
      const control = await this.readControl();
      if (control !== 'running') throw new WorkflowControlBoundary(control === 'cancel_requested' ? 'cancelled' : 'paused');
      await this.loadInvocation(index.id);
      const refreshed = this.persisted.get(current.key)!;
      if (refreshed.index.contentRevision !== index.contentRevision || this.params.revision !== before) continue;
      throw error;
    }
    const admitted = Array.isArray(response.invocations) ? WorkflowRunInvocationIndexV1Schema.parse(response.invocations[0]) : null;
    if (!admitted || typeof response.parentRevision !== 'number') throw new Error('workflow_storage_response_invalid');
    this.params.revision = Math.max(this.params.revision, response.parentRevision);
    this.params.checkpoint = checkpoint;
    await this.loadInvocation(index.id);
    return this.remember(admitted, progress);
    }
  });

  get checkpoint() { return this.params.checkpoint; }
  get revision() { return this.params.revision; }
  get rootIndex() {
    const root = this.recordsById.get(this.params.rootRecordId);
    return root ? this.persisted.get(root.key)?.index : undefined;
  }
  refreshRootIndex = async (): Promise<WorkflowRunInvocationIndexV1 | undefined> => {
    await this.loadInvocation(this.params.rootRecordId);
    return this.rootIndex;
  };
  applyParentTransition(run: WorkflowRunSummaryV1, rootLifecycle: WorkflowRunInvocationIndexV1['lifecycle']): void {
    this.params.revision = Math.max(this.params.revision, run.revision);
    const root = this.recordsById.get(this.params.rootRecordId);
    const item = root ? this.persisted.get(root.key) : undefined;
    if (!root || !item) throw new Error('workflow_root_invocation_missing');
    const key = root.key;
    const contentRevision = item.index.lifecycle === rootLifecycle ? item.index.contentRevision
      : (BigInt(item.index.contentRevision) + 1n).toString();
    const index = { ...item.index, lifecycle: rootLifecycle, contentRevision };
    this.remember(index, item.progress);
  }

  async resolveSharedInvocation(binding: WorkflowConversationBinding | undefined): Promise<WorkflowCoordinatorInvocation | null> {
    if (binding?.kind !== 'shared') throw new Error('workflow_conversation_binding_missing');
    const owner = await this.readByLogicalInvocation(binding.scopeOwnerKey);
    const pointer = owner?.sharedConversationInvocationRecordId?.[binding.targetClass];
    if (!pointer) return null;
    const leaf = await this.readByLogicalInvocation(pointer);
    if (!leaf?.execution || leaf.execution.kind !== binding.targetClass) throw new Error('workflow_conversation_unavailable');
    return leaf;
  }
}

export type WorkflowProductionExecutionDeps = Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  machineAdmissionTransport: NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;
  resolveTeamCredentialResourceCatalog?: Parameters<typeof createProductionFreshWorkflowSessionConversation>[0]['resolveTeamCredentialResourceCatalog'];
  resolveExistingSessionConversation: Parameters<typeof createProductionWorkflowSessionStepExecutor>[0]['resolveExistingSessionConversation'];
  /** Canonical Session I/O boundary adapter; production uses the incumbent default owner. */
  sessionInput?: Parameters<typeof createProductionWorkflowSessionStepExecutor>[0]['sessionInput'];
  originSessionInput?: Parameters<typeof createWorkflowSessionStepExecutor>[0]['originSessionInput'];
  detachedRun: Omit<WorkflowDetachedExecutionRunStepExecutorDeps, 'resolveSharedRunConversation' | 'resolveProducerConversation' | 'workDepth' | 'resolveRoleInstructions'>;
  action?: import('./coordinator').WorkflowActionExecutor;
}>;

export function createWorkflowRunPushNotificationClient(token: string): PushNotificationClient {
  return new PushNotificationClient(token, resolveServerHttpBaseUrl());
}

export type WorkflowTriggerClaimSource =
  | Readonly<{ kind: 'inline'; definition: WorkflowDefinitionV1 }>
  | Readonly<{ kind: 'catalog'; definition: WorkflowDefinitionV1; ref: string; version: number | string }>
  | Readonly<{ kind: 'saved' } & Awaited<ReturnType<ReturnType<typeof createWorkflowDefinitionActions>['get']>>>;

export type WorkflowTriggerAdmissionRefusal = Readonly<{
  state: 'failed' | 'skipped';
  reason: string;
  blockId?: string;
  /** No accepted snapshot or coordinator effects were committed by this claim. */
  admission: 'refused';
}>;
export type WorkflowClaimCoordinationResult = WorkflowCoordinatorResult | WorkflowTriggerAdmissionRefusal;

function refuseWorkflowTriggerAdmission(reason: string, blockId?: string): WorkflowTriggerAdmissionRefusal {
  return { state: 'failed', reason, ...(blockId === undefined ? {} : { blockId }), admission: 'refused' };
}

/** Resolves current source bytes through the existing Artifact/definition owner; E7 owns materialization. */
export async function resolveWorkflowTriggerClaimSource(params: Readonly<{
  target: TriggerTargetV1;
  credentials: StoredCredentials;
  encryption: AvailableAutomationAccountEncryptionV1;
  signal?: AbortSignal;
}>): Promise<WorkflowTriggerClaimSource | null> {
  params.signal?.throwIfAborted();
  if (params.target.kind === 'inline') return { kind: 'inline', definition: params.target.definition };
  const artifactStore = createAccountArtifactStore({
    credentials: params.credentials,
    getAccountEncryptionMode: async () => params.encryption.witness.mode,
  });
  const definitions = createWorkflowDefinitionActions({ artifactStore });
  return resolveWorkflowDefinitionRefV1(params.target.ref, {
    readPluginWorkflows: definitions.readPluginWorkflows,
    readArtifact: (definitionId, signal) => definitions.get({ definitionId, ...(signal ? { signal } : {}) }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

/**
 * Production Automation-claim composition. The server remains ciphertext-blind;
 * this daemon opens the admitted snapshot/evidence, owns root/checkpoint and
 * row sealing, and delegates every leaf effect to the Session executor.
 */
export function createProductionWorkflowRunCoordinator(params: Readonly<{
  token: string;
  accountId: string;
  machineId: string;
  resolveAccountEncryption: (signal?: AbortSignal) => Promise<AvailableAutomationAccountEncryptionV1>;
  isAcceptedAuthorizationCurrent: WorkflowAcceptedAuthorizationCurrentness;
  /** Fresh host/controller facts; claim-time D3 stays at the shared Action owner. */
  resolveControllerContext: (input: Readonly<{
    runId: string; accepted: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>; signal?: AbortSignal;
  }>) => Promise<ActionExecutorContext>;
  execution: WorkflowProductionExecutionDeps;
  resolveMaterializationHost?: (input: Readonly<{
    runId: string; workDepth: number; directory: string; originSessionId?: string; signal?: AbortSignal;
  }>) => Promise<Pick<MaterializeWorkflowAcceptedSnapshotV1Input, 'roleSelection' | 'effects'> & Readonly<{
    admitLeaf: Extract<MaterializeWorkflowAcceptedSnapshotV1Input['admission'], { kind: 'trigger' }>['admitLeaf'];
  }>>;
  prepareAcceptedWorkspaceTarget?: typeof prepareWorkflowAcceptedWorkspaceTarget;
  /**
   * The SCM/worktree boundary reached through the daemon-applied plugin
   * runtime. Production omits it and uses the canonical owners; composed tests
   * that run outside a loaded daemon supply it, exactly as
   * `prepareAcceptedWorkspaceTarget` already allows for accepted targets.
   */
  workspaceScm?: Parameters<typeof createCoordinatorWorkspaceResolver>[0]['scm'];
  resolveCurrentWorkspaceRefs?: (signal?: AbortSignal) => Promise<readonly import('@happier-dev/protocol').WorkspaceRefV1[]>;
  onCommittedTransition?: (transition: Readonly<{ run: WorkflowRunSummaryV1; result: WorkflowCoordinatorResult }>) => Promise<void> | void;
  onReviewEntered?: (entry: Readonly<{ runId: string }>) => Promise<void> | void;
  storage?: StorageClient;
}>): (claim: WorkflowClaimForCoordination) => Promise<WorkflowClaimCoordinationResult> {
  const storage = params.storage ?? createWorkflowRunStorageClient({ token: params.token, machineId: params.machineId });
  const onCommittedTransition = params.onCommittedTransition
    ?? createWorkflowRunCommittedNotificationHandler({
      expoPushSender: createWorkflowRunPushNotificationClient(params.token),
    });
  const onReviewEntered = params.onReviewEntered ?? createWorkflowRunReviewEntryNotificationHandler({
    expoPushSender: createWorkflowRunPushNotificationClient(params.token),
  });
  return async (claim) => {
    const accountEncryption = await params.resolveAccountEncryption(claim.signal);
    if (!sameAutomationAccountCurrentnessWitnessV1(accountEncryption.witness, claim.accountCurrentness)) {
      return claim.definitionEnvelope === undefined
        ? { state: 'failed', reason: 'content_unavailable' }
        : refuseWorkflowTriggerAdmission('content_unavailable');
    }
    let resolvedAcceptedEnvelope = claim.acceptedEnvelope;
    if (claim.definitionEnvelope !== undefined) {
      if (!claim.automationId || !claim.automationCause) return refuseWorkflowTriggerAdmission('content_unavailable');
      const definitionContent = openAutomationStoredContent({
        serialized: claim.definitionEnvelope,
        kind: 'automation_template_payload',
        encryption: accountEncryption,
      });
      const storedDefinition = AutomationStoredWorkflowDefinitionV2Schema.safeParse(definitionContent);
      const target = readTriggerTargetV1(claim, definitionContent);
      if (!storedDefinition.success || target.kind !== 'available') return refuseWorkflowTriggerAdmission('source_unavailable');
      const source = await resolveWorkflowTriggerClaimSource({
        target: target.target, credentials: params.execution.credentials, encryption: accountEncryption,
        ...(claim.signal ? { signal: claim.signal } : {}),
      });
      if (!source || claim.causeWorkDepth === undefined
        || !Number.isSafeInteger(claim.causeWorkDepth) || claim.causeWorkDepth < 0) {
        return refuseWorkflowTriggerAdmission('source_unavailable');
      }
      const evidenceContent = claim.automationEvidenceEnvelope === null
        ? null
        : claim.automationEvidenceEnvelope === undefined
          ? null
          : openAutomationStoredContent({
            serialized: claim.automationEvidenceEnvelope,
            kind: 'automation_trigger_evidence',
            encryption: accountEncryption,
          });
      const prepareClaimWorkspace = async () => {
        let workspaceRefs: readonly import('@happier-dev/protocol').WorkspaceRefV1[] = [];
        if (storedDefinition.data.workspace.workspaceRefId) {
          try {
            workspaceRefs = await params.resolveCurrentWorkspaceRefs?.(claim.signal) ?? [];
          } catch {
            claim.signal?.throwIfAborted();
            return { ok: false, code: 'workspace_unavailable' } as const;
          }
        }
        return (params.prepareAcceptedWorkspaceTarget ?? prepareWorkflowAcceptedWorkspaceTarget)({
          projectTarget: { machineId: params.machineId, ...storedDefinition.data.workspace },
          definition: source.definition,
          currentServerId: params.execution.serverId,
          resolveWorkspaceRef: (workspaceRefId) => resolveWorkspaceRefById(workspaceRefs, workspaceRefId),
        });
      };
      // The signed project may use a home alias. Fingerprint the same canonical
      // project that execution receives, without creating any Run-owned worktree.
      const fingerprintWorkspace = claim.scopeSessionId && source.definition.inputs.some((input) => input.name === 'diffFingerprint')
        ? await prepareClaimWorkspace() : undefined;
      if (fingerprintWorkspace?.ok === false) return refuseWorkflowTriggerAdmission(fingerprintWorkspace.code);
      const fingerprint = fingerprintWorkspace?.ok
        ? await readWorktreeChangeFingerprint(fingerprintWorkspace.workspaceTarget.project.directory)
        : undefined;
      claim.signal?.throwIfAborted();
      const diffFingerprint = fingerprint?.kind === 'available' ? fingerprint.fingerprint : undefined;
      let inputs: ReturnType<typeof bindAutomationWorkflowInputs>;
      try {
        const occurrenceSeed = WorkflowResolvedInputsV1Schema.parse(resolveAutomationWorkflowOccurrenceSeed({
          cause: claim.automationCause, openedEvidence: evidenceContent,
          ...(diffFingerprint === undefined ? {} : { diffFingerprint }),
        }));
        inputs = bindAutomationWorkflowInputs({ definition: source.definition, evidence: occurrenceSeed,
          constants: storedDefinition.data.inputs });
      } catch (error) {
        return refuseWorkflowTriggerAdmission(error instanceof WorkflowInputResolutionError ? error.code : 'content_unavailable');
      }
      const workspace = fingerprintWorkspace ?? await prepareClaimWorkspace();
      if (!workspace.ok) return refuseWorkflowTriggerAdmission(workspace.code);
      if (!params.resolveMaterializationHost) return refuseWorkflowTriggerAdmission('target_unavailable');
      const originSessionId = claim.scopeSessionId ?? undefined;
      let host: Awaited<ReturnType<NonNullable<typeof params.resolveMaterializationHost>>>;
      try {
        host = await params.resolveMaterializationHost({
          runId: claim.runId, workDepth: claim.causeWorkDepth,
          directory: workspace.workspaceTarget.project.directory,
          ...(originSessionId ? { originSessionId } : {}),
          ...(claim.signal ? { signal: claim.signal } : {}),
        });
      } catch (error) {
        claim.signal?.throwIfAborted();
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'source_unavailable' || code === 'content_unavailable' || code === 'target_unavailable') {
          return refuseWorkflowTriggerAdmission(code);
        }
        throw error;
      }
      const created = await materializeWorkflowAcceptedSnapshotV1({
        definition: source.definition,
        ...host,
        roleOverrides: storedDefinition.data.roleOverrides,
        admission: { kind: 'trigger', workDepth: claim.causeWorkDepth, admitLeaf: host.admitLeaf },
        context: {
          actionCaller: { kind: 'automationRun', runId: claim.runId, automationId: claim.automationId, cause: claim.automationCause },
          inputs, machineId: params.machineId,
          executionTarget: storedDefinition.data.executionTarget,
          workspaceTarget: workspace.workspaceTarget,
          authorization: { principal: { kind: 'host' } },
          source: source.kind === 'catalog' ? { kind: 'catalog', ref: source.ref, version: source.version }
            : { kind: 'automation', automationId: claim.automationId,
              ...(source.kind === 'saved' ? { definitionId: source.definitionId, revision: source.revision,
                savedBy: source.savedBy ?? null } : {}) },
          ...(source.kind === 'saved' ? { metadata: source.metadata } : {}),
          ...(originSessionId ? { origin: { kind: 'direct', originSessionId } } : {}),
          ...(storedDefinition.data.onComplete?.kind === 'originating_session' && originSessionId ? {
            resultDelivery: { kind: 'originating_session', originSessionId },
          } : {}),
        },
      });
      if (!created.ok) return refuseWorkflowTriggerAdmission(created.error.code, created.error.blockId);
      const sourceSessionId = claim.automationCause.kind === 'trigger' && claim.automationCause.triggerKind === 'sessionLifecycle'
        ? claim.automationCause.evidence.sourceSessionId : originSessionId;
      const selfTarget = sourceSessionId ? created.snapshot.materializedLeaves.find((leaf) =>
        leaf.selection.conversation?.kind === 'existing_session' && leaf.selection.conversation.sessionId === sourceSessionId) : undefined;
      if (selfTarget) return refuseWorkflowTriggerAdmission('self_target', selfTarget.blockId);
      if (diffFingerprint !== undefined && claim.lastSucceededRun) {
        // Use the previous Run's canonical key census. Checkpoints are bound to
        // their Run and cannot be opened with the new occurrence's key.
        let endFingerprint: string | undefined;
        try {
          const previous = claim.lastSucceededRun;
          const census = WorkflowRunRecipientCensusResponseV1Schema.parse(await storage.execute({
            operation: 'run-key.census', runId: previous.runId,
          }, claim.signal ? { signal: claim.signal } : {}));
          const key = resolveWorkflowRunDataKeyV1({ encryption: accountEncryption, census });
          if (key.kind === 'available' && census.runId === previous.runId && census.ownerAccountId === params.accountId) {
            const opened = openWorkflowCheckpointStoredEnvelopeV1({ ...openMode(key.encryption),
              binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: previous.runId },
              envelope: parseWorkflowStoredContentEnvelopeV1(previous.checkpointEnvelope) });
            if (opened.kind === 'available') endFingerprint = opened.content.endFingerprint;
          }
        } catch {
          claim.signal?.throwIfAborted();
          // Unreadable historical evidence never suppresses a fresh review.
        }
        if (endFingerprint === diffFingerprint) return { state: 'skipped', reason: 'diff_unchanged', admission: 'refused' };
      }
      const sourceArtifactId = 'definitionId' in created.snapshot.source ? created.snapshot.source.definitionId ?? null : null;
      const visibility = storedDefinition.data.visibleTeamId === undefined ? {} : { visibleTeamId: storedDefinition.data.visibleTeamId };
      const census = accountEncryption.witness.mode === 'e2ee'
        ? WorkflowRunRecipientCensusResponseV1Schema.parse(await storage.execute({ operation: 'run-key.census', runId: claim.runId, sourceArtifactId, ...visibility }, claim.signal ? { signal: claim.signal } : {}))
        : undefined;
      const prepared = prepareWorkflowRunDataKeyV1({ accountId: params.accountId, encryption: accountEncryption,
        ...(census ? { census } : {}), randomBytes: getRandomBytes });
      const candidate = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        ...sealMode({ witness: accountEncryption.witness, runCrypto: prepared.runCrypto }),
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: params.accountId, runId: claim.runId },
        acceptedSnapshot: created.snapshot,
      }));
      const resolution = asRecord(await storage.execute({
        operation: 'accepted-snapshot.resolve',
        accountCurrentness: accountEncryption.witness,
        runId: claim.runId,
        automationId: claim.automationId,
        expectedAttempt: claim.attempt,
        expectedRevision: claim.expectedRevision,
        definitionEnvelope: claim.definitionEnvelope,
        acceptedEnvelope: candidate,
        sourceArtifactId,
        ...(created.snapshot.origin?.originSessionId ? { originSessionId: created.snapshot.origin.originSessionId } : {}),
        ...(created.snapshot.resultDelivery ? { resultDelivery: { kind: created.snapshot.resultDelivery.kind } } : {}),
        recipientKeyEnvelopes: prepared.recipientKeyEnvelopes,
        ...(census ? { visibleTeamId: census.visibleTeamId } : visibility),
      }, { ...(claim.signal ? { signal: claim.signal } : {}) }));
      if (typeof resolution.acceptedEnvelope !== 'string') throw new Error('workflow_storage_response_invalid');
      resolvedAcceptedEnvelope = resolution.acceptedEnvelope;
    }
    const initial = parseRunSnapshot(await storage.execute({ operation: 'get', runId: claim.runId }, { ...(claim.signal ? { signal: claim.signal } : {}) }));
    const resolved = resolveWorkflowRunDataKeyV1({ encryption: accountEncryption, census: initial.keyCensus });
    if (resolved.kind !== 'available' || initial.keyCensus.ownerAccountId !== params.accountId) return { state: 'failed', reason: 'content_unavailable' };
    const encryption = resolved.encryption;
    const prepareRecipients = async (signal?: AbortSignal) => await runWorkflowRecipientKeyPreparationV1({
      runId: claim.runId, runCrypto: encryption.runCrypto, openedDataEncryptionKey: initial.keyCensus.callerDataEncryptionKey,
      randomBytes: getRandomBytes,
      readCensus: async () => WorkflowRunRecipientCensusResponseV1Schema.parse(await storage.execute({ operation: 'run-key.census', runId: claim.runId }, signal ? { signal } : {})),
      commit: async input => WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema.parse(await storage.execute({ operation: 'run-key.commit', ...input }, signal ? { signal } : {})),
      ...(signal ? { signal } : {}),
    });
    if (resolvedAcceptedEnvelope !== undefined && initial.acceptedEnvelope !== resolvedAcceptedEnvelope) {
      return { state: 'failed', reason: 'content_unavailable' };
    }
    const acceptedEnvelope = parseWorkflowStoredContentEnvelopeV1(resolvedAcceptedEnvelope ?? initial.acceptedEnvelope);
    if (!acceptedEnvelope) return { state: 'failed', reason: 'content_unavailable' };
    const openedAccepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...openMode(encryption),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: params.accountId, runId: claim.runId },
      envelope: acceptedEnvelope,
    });
    if (openedAccepted.kind !== 'available') return { state: 'failed', reason: 'content_unavailable' };
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse(openedAccepted.content);
    const inputs = accepted.inputs;
    if (initial.run.machineId !== params.machineId
      || accepted.machineId !== params.machineId
      || accepted.workspaceTarget.project.machineId !== params.machineId) {
      return { state: 'failed', reason: 'workspace_conflict' };
    }
    const isOpenedAuthorizationCurrent = async (signal?: AbortSignal): Promise<boolean> => {
      const current = await params.resolveAccountEncryption(signal);
      return sameAutomationAccountContentIdentityV1(current.witness, accountEncryption.witness)
        && await params.isAcceptedAuthorizationCurrent({
          authorization: accepted.authorization,
          ...(signal ? { signal } : {}),
        });
    };
    claim.registerAuthorizationCurrentnessCheck?.(isOpenedAuthorizationCurrent);

    const checkControllerDominance = async (signal?: AbortSignal) => {
      try {
        const context = await params.resolveControllerContext({ runId: claim.runId, accepted,
          ...(signal ? { signal } : {}) });
        await assertControllerDominates({ actionId: 'workflow.run.resume',
          input: { mode: 'boundary', runId: claim.runId, expectedRevision: initial.run.revision },
          context: { ...context, ...(signal ? { signal } : {}) } },
          accepted, undefined, input => isOpenedAuthorizationCurrent(input.signal),
          { normalizeAbsolutePath: directory => resolveCanonicalAbsolutePath(directory)?.path ?? null });
        return undefined;
      } catch (error) {
        signal?.throwIfAborted();
        const code = WorkflowOperationErrorCodeV1Schema.safeParse(error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined);
        if (!code.success) throw error;
        return code.data;
      }
    };
    const controllerFailure = claim.workflowResumeRequestedRevision === undefined
      ? undefined
      : await checkControllerDominance(claim.signal);

    let checkpoint: WorkflowCheckpointEnvelopeV1;
    let rootRecordId: string;
    let revision = initial.run.revision;
    if (initial.checkpointEnvelope === null) {
      rootRecordId = randomUUID();
      checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({
        kind: 'happier.workflow-checkpoint.v1', rootRecordId, nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false },
      });
      const rootProgress = WorkflowProgressEnvelopeV1Schema.parse({
        stepProgress: { completed: 0, total: accepted.authoredDefinition.blocks.length },
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootRecordId,
      });
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId }, checkpoint,
      }));
      const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...sealMode(encryption),
        binding: { v: 1, purpose: 'invocation_progress', accountId: params.accountId, runId: claim.runId,
          recordId: rootRecordId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: rootProgress,
      }));
      const initialized = asRecord(await storage.execute({ operation: 'initialize', runId: claim.runId,
        parentAttempt: claim.attempt, accountCurrentness: encryption.witness,
        expectedRevision: revision, checkpointEnvelope,
        rootInvocation: { id: rootRecordId, contentEnvelope: rootEnvelope } }));
      const run = WorkflowRunSummaryV1Schema.parse(initialized.run);
      revision = run.revision;
    } else {
      const envelope = parseWorkflowStoredContentEnvelopeV1(initial.checkpointEnvelope);
      const opened = openWorkflowCheckpointStoredEnvelopeV1({
        ...openMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId }, envelope,
      });
      if (opened.kind !== 'available') return { state: 'failed', reason: 'content_unavailable' };
      checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse(opened.content);
      rootRecordId = checkpoint.rootRecordId;
    }

    if (!controllerFailure && checkpoint.frontier.paused) {
      checkpoint = { ...checkpoint, frontier: { ...checkpoint.frontier, paused: false } };
    }
    const durableStore = await DurableWorkflowCoordinatorStore.load({
      accountId: params.accountId, runId: claim.runId, parentAttempt: claim.attempt,
      storage, encryption, rootRecordId, checkpoint, revision,
      authoredDefinition: accepted.authoredDefinition,
      definition: accepted.definition,
    });
    await durableStore.refreshStepProgress();
    claim.registerControlCheck?.(async () => await durableStore.readControl());
    const rootAtStart = durableStore.rootIndex;
    if (!rootAtStart) throw new Error('workflow_root_invocation_missing');
    if (controllerFailure) {
      const root = await durableStore.readByLogicalInvocation(rootRecordId);
      if (!root) throw new Error('workflow_root_invocation_missing');
      await durableStore.commitFact({ key: root.key, lifecycle: root.lifecycle,
        reason: controllerFailure, reasonMessage: `Couldn't resume: ${controllerFailure}` });
      const active = await durableStore.listByLifecycle({ runId: claim.runId,
        lifecycles: ['admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain'] });
      const hasInputCustody = active.some(row => (row.blockKind === 'step' || row.blockKind === 'action')
        && (row.execution !== undefined || row.lifecycle === 'admitting' || row.lifecycle === 'cancel_requested' || row.lifecycle === 'outcome_uncertain'));
      const control = await durableStore.readControl();
      const state = control === 'cancel_requested' ? 'cancelled' : hasInputCustody ? 'interrupted' : 'paused';
      // A denied resumed boundary owns no input. Reclaimed active custody must
      // remain recoverable rather than being mislabeled a quiescent pause.
      if (state === 'cancelled' && hasInputCustody) return { state: 'interrupted', reason: controllerFailure };
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId },
        checkpoint: { ...durableStore.checkpoint, frontier: { ...durableStore.checkpoint.frontier, paused: state === 'paused' } },
      }));
      await storage.execute({ operation: 'transition', runId: claim.runId, parentAttempt: claim.attempt,
        accountCurrentness: encryption.witness, expectedRevision: durableStore.revision, state, checkpointEnvelope });
      return { state, reason: controllerFailure };
    }
    await prepareRecipients(claim.signal);
    if (rootAtStart.lifecycle === 'pending') {
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId },
        checkpoint: durableStore.checkpoint,
      }));
      const started = WorkflowRunSummaryV1Schema.parse(await storage.execute({
        operation: 'transition', runId: claim.runId, parentAttempt: claim.attempt,
        accountCurrentness: encryption.witness,
        expectedRevision: durableStore.revision,
        state: 'running', checkpointEnvelope,
        invocationTransitions: [{ id: rootAtStart.id, expectedLifecycle: 'pending', expectedContentRevision: rootAtStart.contentRevision, lifecycle: 'running' }],
      }));
      durableStore.applyParentTransition(started, 'running');
    }
    const resolveSharedSessionConversation = async ({ conversationBinding }: Readonly<{ conversationBinding?: WorkflowConversationBinding }>) => {
      const record = await durableStore.resolveSharedInvocation(conversationBinding);
      return record?.execution?.kind === 'session' && record.workspace?.descriptor
        ? { sessionId: record.execution.sessionId, machineId: record.workspace.descriptor.machineId,
            directory: record.workspace.descriptor.directory }
        : null;
    };
    const resolveProducerSessionConversation = async ({ producer, producerBinding }: Readonly<{
      producer: import('@happier-dev/protocol').WorkflowAuthoredProducerRef;
      producerBinding?: WorkflowProducerBinding;
    }>) => {
      if (!producerBinding) throw new Error('workflow_producer_binding_missing');
      const record = await producerBinding.resolve(producer);
      return record?.execution?.kind === 'session' && record.workspace?.descriptor
        ? { sessionId: record.execution.sessionId, machineId: record.workspace.descriptor.machineId,
            directory: record.workspace.descriptor.directory }
        : null;
    };
    const freshConversation = createProductionFreshWorkflowSessionConversation({
      credentials: params.execution.credentials,
      serverId: params.execution.serverId,
      machineId: params.machineId,
      workDepth: accepted.workDepth,
      originRunId: claim.runId,
      machineAdmissionTransport: params.execution.machineAdmissionTransport,
      visibleTeamId: initial.keyCensus.visibleTeamId,
      ...(params.execution.resolveTeamCredentialResourceCatalog
        ? { resolveTeamCredentialResourceCatalog: params.execution.resolveTeamCredentialResourceCatalog }
        : {}),
    });
    const resolveFrozenRole = (executionParams: Pick<Parameters<WorkflowStepExecutor>[0], 'role'>) => executionParams.role;
    const conversations = createProductionWorkflowConversationOwner({
      machineId: params.machineId,
      createFreshConversation: freshConversation,
      resolveSharedRunConversation: resolveSharedSessionConversation,
      resolveProducerConversation: resolveProducerSessionConversation,
      resolveExistingSessionConversation: params.execution.resolveExistingSessionConversation,
      resolveFrozenRole,
    });
    const resolveRoleInstructions = (executionParams: Parameters<WorkflowStepExecutor>[0]) => {
      const role = resolveFrozenRole(executionParams);
      return role ? renderSessionRoleBlockV1({ role, source: 'workflow_step', originKind: 'run_step' }) : undefined;
    };
    const detachedRunDeps: WorkflowDetachedExecutionRunStepExecutorDeps = {
      ...params.execution.detachedRun,
      workDepth: accepted.workDepth,
      resolveRoleInstructions,
      buildActionContext: (executionParams) => {
        const role = resolveFrozenRole(executionParams);
        const context = params.execution.detachedRun.buildActionContext(executionParams);
        return {
          ...context,
          ...(role ? { agentStartWorkspaceWrites: context.agentStartWorkspaceWrites === 'deny' ? 'deny' : role.workspaceWrites } : {}),
          executionRunPermissionRequestStore: new AgentStateRequestStore({
            target: durableStore.createInteractionPersistenceTarget(workflowInvocationKey({
              runId: executionParams.runId,
              blockId: executionParams.invocation.invocationPath.blockId,
              scope: executionParams.invocation.invocationPath.scope,
              attempt: Number(executionParams.invocation.attempt),
            })),
            logPrefix: `[WORKFLOW ${executionParams.runId}]`,
          }),
        };
      },
      resolveSharedRunConversation: async ({ conversationBinding }) => {
        const record = await durableStore.resolveSharedInvocation(conversationBinding);
        return record?.execution?.kind === 'detached_run' && record.workspace?.descriptor
          ? {
              runId: record.execution.runId,
              machineId: record.workspace.descriptor.machineId,
              directory: record.workspace.descriptor.directory,
              ...(record.execution.runtimeSelection
                ? { runtimeSelection: record.execution.runtimeSelection }
                : {}),
              ...(record.execution.providerResumeIdentity
                ? { providerResumeIdentity: record.execution.providerResumeIdentity }
                : {}),
            }
          : null;
      },
      resolveProducerConversation: async ({ producer, producerBinding }) => {
        if (!producerBinding) throw new Error('workflow_producer_binding_missing');
        const record = await producerBinding.resolve(producer);
        return record?.execution?.kind === 'detached_run' && record.workspace?.descriptor
          ? {
              runId: record.execution.runId,
              machineId: record.workspace.descriptor.machineId,
              directory: record.workspace.descriptor.directory,
              ...(record.execution.runtimeSelection
                ? { runtimeSelection: record.execution.runtimeSelection }
                : {}),
              ...(record.execution.providerResumeIdentity
                ? { providerResumeIdentity: record.execution.providerResumeIdentity }
                : {}),
            }
          : null;
      },
    };
    const rootInvocation = await durableStore.readByLogicalInvocation(rootRecordId);
    if (!rootInvocation) throw new Error('workflow_root_invocation_missing');
    const coordinator = createWorkflowCoordinator({
      store: durableStore,
      ...(params.execution.action ? { action: params.execution.action } : {}),
      onReviewEntered: async ({ runId }) => await onReviewEntered({ runId }),
      sessionContext: createProductionWorkflowSessionContextReader({
        credentials: params.execution.credentials,
        machineId: params.machineId,
        originSessionId: accepted.origin?.originSessionId,
        ...(claim.signal ? { signal: claim.signal } : {}),
      }),
      rootInvocationRecordId: rootInvocation.recordId,
      isAcceptedAuthorizationCurrent: async (currentness) =>
        await isOpenedAuthorizationCurrent(currentness.signal),
      checkReviewGenerationAuthority: async ({ signal }) => await checkControllerDominance(signal),
      prepareStep: async (executionParams) => {
        try {
          if (executionParams.executionTarget.kind === 'detached_run') {
            const preparedStep = await prepareWorkflowDetachedExecutionRunStep(
              detachedRunDeps,
              executionParams,
            );
            const retainedConversation = preparedStep.retainedConversation;
            const directory = retainedConversation?.directory;
            return {
              preparedStep,
              ...(directory
                ? {
                    conversationWorkspace: {
                      machineId: retainedConversation.machineId,
                      directory,
                    },
                  }
                : {}),
            };
          }
          const preparedStep = await conversations.prepare(executionParams);
          return {
            preparedStep,
            ...(preparedStep.existing
              ? {
                  conversationWorkspace: {
                    machineId: preparedStep.existing.machineId,
                    directory: preparedStep.existing.directory,
                  },
                }
              : {}),
          };
        } catch (error) {
          if (error instanceof WorkflowSessionCompositionError) {
            return { failure: { kind: 'failed', code: error.code } };
          }
          if (error instanceof WorkflowExecutionRunCompositionError) {
            return {
              failure: {
                kind: error.code === 'workflow_permission_escalation_denied' ? 'failed' : 'needs_attention',
                code: error.code,
              },
            };
          }
          throw error;
        }
      },
      executeStep: createWorkflowStepExecutorDispatcher({
        session: createWorkflowSessionStepExecutor({
          credentials: params.execution.credentials,
          workDepth: accepted.workDepth,
          resolveRoleInstructions,
          ...(params.execution.sessionInput ? { sessionInput: params.execution.sessionInput } : {}),
          ...(params.execution.originSessionInput ? { originSessionInput: params.execution.originSessionInput } : {}),
          prepareConversation: async (executionParams) => await conversations.prepare(executionParams),
          materializeConversation: async (prepared, executionParams) => {
            await prepareRecipients(claim.signal);
            const conversation = await conversations.materialize(prepared, executionParams);
            return {
              sessionId: conversation.sessionId,
              machineAdmissionTransport: params.execution.machineAdmissionTransport,
            };
          },
        }),
        detachedRun: createWorkflowDetachedExecutionRunStepExecutor(detachedRunDeps),
      }),
      resolveWorkspace: createCoordinatorWorkspaceResolver({
        store: durableStore,
        projectWorkspace: accepted.workspaceTarget.project,
        ...(accepted.workspaceTarget.originalCommittedRevision
          ? { originalCommittedRevision: accepted.workspaceTarget.originalCommittedRevision }
          : {}),
        ...(params.workspaceScm ? { scm: params.workspaceScm } : {}),
      }),
    });
    claim.registerReviewHoldRefresh?.(coordinator.refreshReviewHolds);
    const runCoordinator = () => coordinator.run({ runId: claim.runId, definition: accepted.definition, inputs,
      authoredDefinition: accepted.authoredDefinition,
      executionTarget: accepted.executionTarget,
      materializedLeaves: accepted.materializedLeaves,
      frozenChildren: accepted.frozenChildren,
      workDepth: accepted.workDepth,
      authorization: accepted.authorization,
      ...(initial.run.origin.kind === 'automation' && initial.run.origin.cause
        ? { automationCause: initial.run.origin.cause } : {}),
      ...(accepted.origin?.originSessionId ? { originSessionId: accepted.origin.originSessionId } : {}),
      ...(claim.signal ? { signal: claim.signal } : {}) });
    let result = await runCoordinator();
    while (result.state === 'waiting_for_review') {
      if (result.parkRevision === undefined) throw new Error('workflow_review_park_token_missing');
      try {
        const parked = WorkflowRunSummaryV1Schema.parse(await storage.execute({ operation: 'transition',
          runId: claim.runId, parentAttempt: claim.attempt, accountCurrentness: encryption.witness,
          expectedRevision: result.parkRevision, state: 'waiting_for_review',
          checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
            ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId },
            checkpoint: durableStore.checkpoint })) }));
        durableStore.applyParentTransition(parked, durableStore.rootIndex!.lifecycle);
        return result;
      } catch (error) {
        const snapshot = parseRunSnapshot(await storage.execute({ operation: 'get', runId: claim.runId }));
        if (snapshot.run.state === 'waiting_for_review') return result;
        if (snapshot.run.revision === result.parkRevision) throw error;
        const control = await durableStore.readControl();
        if (control === 'cancel_requested') { result = { state: 'cancelled' }; break; }
        if (control === 'pause_requested') { result = { state: 'paused' }; break; }
        if (snapshot.run.state !== 'running' && snapshot.run.state !== 'claimed') throw error;
        // Human resolution invalidated R. Re-enter the same claim and exact
        // held pipelines; refreshing the store cannot authorize parking.
        result = await runCoordinator();
      }
    }
    // Cancellation is the terminal authority even when it races the last
    // admitted leaf. A pause that arrives after all authored work completed is
    // intentionally allowed to settle that completed work normally.
    const control = await durableStore.readControl();
    if (control === 'cancel_requested') {
      const pendingStops = await durableStore.listByLifecycle({
        runId: claim.runId,
        lifecycles: ['cancel_requested'],
      });
      const hasPendingChildStop = pendingStops.some(
        (record) => record.recordId !== durableStore.rootIndex?.id,
      );
      // A native stop acknowledgement is not terminal evidence. The exact
      // child remains `cancel_requested`, so retain the already-running parent
      // and pending custody for observation/recovery to close.
      if (result.state === 'interrupted' || hasPendingChildStop) {
        return result.state === 'interrupted'
          ? result
          : { state: 'interrupted', ...(result.reason ? { reason: result.reason } : {}) };
      }
      result = { state: 'cancelled' };
    }
    let terminalState = result.state === 'succeeded' ? 'succeeded' : result.state;
    const rootBeforeSettlement = durableStore.rootIndex;
    if (!rootBeforeSettlement) throw new Error('workflow_root_invocation_missing');
    let rootTerminal = projectWorkflowRootSettlementLifecycle(result.state, rootBeforeSettlement.lifecycle);
    const endFingerprint = result.state === 'succeeded' && accepted.definition.inputs.some((input) => input.name === 'diffFingerprint')
      ? await durableStore.readFinalReviewFingerprint(new Set(accepted.materializedLeaves
        ?.filter((leaf) => leaf.kind === 'action' && leaf.actionId === 'review.start').map((leaf) => leaf.blockId)))
      : undefined;
    const { endFingerprint: _priorFingerprint, ...closingCheckpoint } = durableStore.checkpoint;
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId },
      checkpoint: { ...closingCheckpoint, ...(endFingerprint === undefined ? {} : { endFingerprint }) },
    }));
    const resultEnvelope = result.finalResult
      ? serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
        ...sealMode(encryption),
        binding: { v: 1, purpose: 'final_result', accountId: params.accountId, runId: claim.runId },
        finalResult: result.finalResult,
      }))
      : undefined;
    const custodyState = projectWorkflowTerminalCustodySettlement(result.state);
    const transition = {
      operation: 'transition', runId: claim.runId, parentAttempt: claim.attempt,
      accountCurrentness: encryption.witness,
      expectedRevision: durableStore.revision,
      state: terminalState, checkpointEnvelope,
      ...(resultEnvelope ? { resultEnvelope } : {}),
      ...(custodyState ? { custodyState } : {}),
      ...(rootTerminal === rootBeforeSettlement.lifecycle ? {} : {
        invocationTransitions: [{ id: rootBeforeSettlement.id, expectedLifecycle: rootBeforeSettlement.lifecycle, expectedContentRevision: rootBeforeSettlement.contentRevision, lifecycle: rootTerminal }],
      }),
    } as const;
    let committed: WorkflowRunSummaryV1;
    try {
      committed = WorkflowRunSummaryV1Schema.parse(await storage.execute(transition));
    } catch (error) {
      const snapshot = parseRunSnapshot(await storage.execute({ operation: 'get', runId: claim.runId }));
      if (snapshot.run.state === 'cancelled') {
        result = { state: 'cancelled' };
        terminalState = 'cancelled';
        rootTerminal = 'cancelled';
        committed = snapshot.run;
      } else {
        const persistedRoot = await durableStore.refreshRootIndex();
        const custodyMatches = snapshot.run.workflowCustodyState === (custodyState ?? 'pending');
        const exactCommittedSettlement = snapshot.run.state === terminalState
          && snapshot.checkpointEnvelope === checkpointEnvelope
          && snapshot.resultEnvelope === (resultEnvelope ?? null)
          && custodyMatches
          && persistedRoot?.lifecycle === rootTerminal;
        if (exactCommittedSettlement) {
          // The transition committed and only its response was lost. Rejoin
          // the exact durable bytes; never replay the mutation.
          committed = snapshot.run;
        } else if (snapshot.run.state === 'pause_requested') {
          // One control-aware CAS reconciliation is sufficient: either all
          // authored work completed and succeeds, or the paused boundary is
          // durably settled. A second conflict remains visible to recovery.
          committed = WorkflowRunSummaryV1Schema.parse(await storage.execute({
            ...transition,
            expectedRevision: snapshot.run.revision,
          }));
        } else {
          throw error;
        }
      }
    }
    durableStore.applyParentTransition(committed, rootTerminal);
    await onCommittedTransition({ run: committed, result });
    return result;
  };
}
