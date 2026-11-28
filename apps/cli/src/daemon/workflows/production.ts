import { readTriggerApprovedOperationForRun } from './workflowApprovedOperation';
import { readServerHttpRequestBodyUtf8ByteLengthV1, SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import type { WorkflowTriggerEventIdentityV1 } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { randomUUID } from 'node:crypto';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { WorkflowStepProgress } from './stepProgress';
import { postWorkflowRunSummaryToAuthorizedSource, type WorkflowPostSummaryEventOccurrence } from './postSummaryToSource';

import { WorkflowTargetUnavailableDiagnosticV1Schema, type WorkflowTargetUnavailableDiagnosticV1 } from '@happier-dev/protocol/workflows/workflowTargetUnavailableReasonV1';
import { applyWorkflowInvocationFactV1, classifyWorkflowHoldV1, isTerminalWorkflowInvocationLifecycleV1, WorkflowAuthoredInputV1Schema, WorkflowCheckpointEnvelopeV1Schema, WorkflowProgressEnvelopeV1Schema, WorkflowInvocationFactV1Schema, WorkflowInvocationFactResultV1Schema, WorkflowRunInvocationIndexV1Schema, WorkflowRunSummaryV1Schema, WorkflowOperationErrorCodeV1Schema, WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1, WORKFLOW_INVOCATION_LIFECYCLES_V1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { sameStrictJsonValue, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { getWorkflowActionOutputKindV1, WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { AutomationStoredContentEnvelopeV1ReadSchema } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { AutomationStoredWorkflowDefinitionV2ReadSchema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { AutomationRunExecutionInputV1Schema, toAutomationRunExecutionInputV1Origin } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationRunPluginEventTriggerEvidenceV1Schema, matchesCauseEvidence } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { AutomationPluginEventOccurrenceEvidenceV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { openAutomationTemplateStoredV1 } from '@happier-dev/protocol/automations/automationTemplateStoredV1';
import { convertLegacyAutomationRecipeToInlineWorkflowV1 } from '@happier-dev/protocol/automations/automationLegacyWorkflowV1';
import { WorkflowAcceptedSnapshotV1Schema, WorkflowResolvedInputsV1Schema, type WorkflowDefinitionMetadataV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { materializeWorkflowAcceptedSnapshotV1, workflowRequiresMachineStartCapacityV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { projectWorkflowActionTriggerEventOccurrenceV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import type { WorkflowTargetUnavailableReasonV1 } from '@happier-dev/protocol/workflows/workflowTargetUnavailableReasonV1';
import { readWorkflowInvocationMembersV1, readWorkflowInvocationRootV1 } from '@happier-dev/protocol/workflows';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { deriveWorkflowDestinationsV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { workflowTriggerDisplayNameV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';
import { readTriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowCheckpointStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1, openWorkflowProgressSnapshotV1, prepareWorkflowDestinationPublicationV1, parseWorkflowStoredContentEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowRunAcceptedEnvelopesV1, sealWorkflowFinalResultStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema, WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { prepareWorkflowRunDataKeyV1, resolveWorkflowRunDataKeyV1, runWorkflowRecipientKeyPreparationV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { renderSessionRoleBlockV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameAutomationAccountContentIdentityV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import type { WorkflowRunEncryptionV1, WorkflowRunRecipientCensusResponseV1, WorkflowCheckpointEnvelopeV1, WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1, WorkflowRunSummaryV1, WorkflowRunStepProgressV1, TriggerTargetV1, WorkflowDefinitionV1, MaterializeWorkflowAcceptedSnapshotV1Input } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ReviewRoundBindingV1Schema, type ReviewRunReferenceV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewPreparedRoundV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import type { CliReviewServices } from '@/session/actions/createCliActionExecutor';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { createWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import { runWithWorkspaceSourceDemand } from '@/workspaces/source/workspaceSource';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';
import { readWorkflowRunStorageFailure } from './workflowRunStorageClient';
import { readWorkflowDiscussionRoundBindingV1, WorkflowDiscussionRoundProjectResultV1Schema,
  type WorkflowDiscussionRoundBindingV1, type WorkflowDiscussionRoundProgressV1 } from '@happier-dev/protocol/workflows';

import { getRandomBytes } from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createWorkflowDefinitionActions } from '@/session/actions/workflowDefinitions';
import { PushNotificationClient } from '@/api/pushNotifications';
import { logger } from '@/ui/logger';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
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
import { resolveWorkflowAuthorizedSession } from './invocationRecoveryObserver';
import { materializeWorkflowSessionReview } from './reviewSessionStep';
import { collectWorkflowReviewRoundOutcomes } from './reviewRoundSettlement';
import { createCoordinatorWorkspaceResolver, prepareWorkflowAcceptedWorkspaceTarget, selectManagedWorkflowWorkspaceSource } from './resolveWorkflowWorkspace';
import { bindAutomationWorkflowInputs, resolveAutomationWorkflowOccurrenceSeed, WorkflowInputResolutionError } from './input';
import { resolveDeploymentTriggerOccurrence, admitDeploymentTriggerOccurrence } from './deploymentTrigger';
import { shouldPublishWorkflowSharedConversation, type WorkflowConversationBinding } from './workflowConversation';
import type { WorkflowProducerBinding, WorkflowInvocationBindingRow } from './workflowScopeBinding';
import { materializeWorkflowContainerResult } from './workflowContainerResult';
import type { WorkflowClaimForCoordination } from './worker';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { StoredCredentials } from '@/persistence';
import type { AgentState } from '@/api/types';
import { createProductionWorkflowSessionContextReader } from './workflowSessionContext';
import { createProductionWorkflowDiscussionContextReader, resolveWorkflowDiscussionOrigin } from './workflowDiscussion';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { createWorkflowDiscussionResultPublisher, WorkflowDiscussionPublicationUnavailable } from './workflowDiscussionPublication';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createDiscussionReplyReturnPublisher } from '@/discussions/discussionReplyReturnPublisher';
import { buildWorkflowActionContext } from './workflowActionContext';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
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
  workflowConversationUnavailable,
} from './sessionStepExecutor';
import {
  createWorkflowDetachedExecutionRunStepExecutor,
  createWorkflowStepExecutorDispatcher,
  prepareWorkflowDetachedExecutionRunStep,
  WorkflowExecutionRunCompositionError,
  type WorkflowDetachedExecutionRunStepExecutorDeps,
} from './executionRunStepExecutor';

type StorageClient = ReturnType<typeof createWorkflowRunStorageClient>;

/** Durable correspondence failures keep their original generic-error routing. */
function workflowConversationResolverUnavailable(...args: Parameters<typeof workflowConversationUnavailable>) {
  const refusal = workflowConversationUnavailable(...args);
  return Object.assign(new Error(refusal.message), { details: refusal.details });
}
type SealMode =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; runDataKey: Uint8Array; randomBytes: typeof getRandomBytes }>;

type RunStorageSnapshot = Readonly<{
  run: WorkflowRunSummaryV1;
  acceptedEnvelope: string;
  checkpointEnvelope: string | null;
  resultEnvelope: string | null;
  keyCensus: WorkflowRunRecipientCensusResponseV1;
  rootProgress?: unknown;
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
  const parsed = AutomationStoredContentEnvelopeV1ReadSchema.safeParse(value);
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
    rootProgress: record.rootProgress,
  };
}

function parseRunControl(value: unknown) {
  const record = asRecord(value);
  const run = asRecord(record.run);
  return { run: {
    state: WorkflowRunSummaryV1Schema.shape.state.parse(run.state),
    revision: WorkflowRunSummaryV1Schema.shape.revision.parse(run.revision),
  }, rootProgress: record.rootProgress };
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

type WorkflowInvocationIntent = Parameters<WorkflowCoordinatorStore['ensureIntent']>[0];

/** Internal durable row owner, exported only so its persistence concurrency contract can be tested at the real boundary. */
export class DurableWorkflowCoordinatorStore implements WorkflowCoordinatorStore {
  private lastDiscussionRoundProgress: WorkflowDiscussionRoundProgressV1 | undefined;
  private readonly records = new Map<string, WorkflowCoordinatorInvocation>();
  private readonly recordsById = new Map<string, WorkflowCoordinatorInvocation>();
  private readonly currentSlots = new Map<string, WorkflowCoordinatorInvocation>();
  private readonly persisted = new Map<string, PersistedInvocation>();
  private readonly stepProgress: WorkflowStepProgress;
  private stepProgressReconstructed = false;
  private readonly materializedContainers = new Map<string, import('./input').WorkflowJsonValue>();
  private readonly loadedParentSlots = new Set<string>();
  private readonly locallyCreatedParents = new Set<string>();
  private readonly progressMembers = new Map<string, {
    members: Map<string, WorkflowRunInvocationIndexV1>; completed: number;
  }>();
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingFrameAdmission?: {
    intents: Map<string, WorkflowInvocationIntent>;
    result: Promise<ReadonlyMap<string, WorkflowCoordinatorInvocation>>;
  };
  private readonly invocationMutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly params: {
      accountId: string;
      runId: string;
      parentAttempt: number;
      machineId?: string;
      storage: Pick<StorageClient, 'execute'>;
      encryption: WorkflowRunEncryptionV1;
      rootRecordId: string;
      checkpoint: WorkflowCheckpointEnvelopeV1;
      revision: number;
      authoredDefinition?: WorkflowDefinitionV1;
      definition?: WorkflowDefinitionV1;
      frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
      destinations?: NonNullable<WorkflowRunStepProgressV1['destinations']>;
      projectionExpectedRevision?: number;
      discussionRound?: WorkflowDiscussionRoundBindingV1;
      /** The root row this executor just created: opened as the starting row; it has no members yet. */
      createdRoot?: Readonly<{ index: unknown; contentEnvelope: unknown; parentRevision: number; destinationEnvelopes?: unknown }>;
    },
  ) {
    this.stepProgress = new WorkflowStepProgress({ definition: params.authoredDefinition,
      frozenChildren: params.frozenChildren, destinations: params.destinations });
  }

  static async load(params: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]): Promise<DurableWorkflowCoordinatorStore> {
    const store = new DurableWorkflowCoordinatorStore(params);
    await store.loadInvocation(params.rootRecordId, params.createdRoot);
    if (params.createdRoot) {
      store.locallyCreatedParents.add(params.rootRecordId);
      store.stepProgressReconstructed = true;
    }
    const original = await store.readInvocationBindingRow(params.rootRecordId);
    if (!original) throw new Error('workflow_root_invocation_missing');
    const root = await readWorkflowInvocationRootV1({ root: original, readInvocation: store.readInvocationBindingRow,
      readCurrentRoot: async () => {
        const page = asRecord(await params.storage.execute({ operation: 'invocations.list', runId: params.runId,
          parentRecordId: null, memberOrdinal: '0', pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }));
        if (!Array.isArray(page.invocations) || page.invocations.length !== 1 || page.nextCursor !== undefined) {
          throw new Error('workflow_storage_response_invalid');
        }
        const index = WorkflowRunInvocationIndexV1Schema.parse(page.invocations[0]);
        if (index.parentRecordId !== null || index.memberOrdinal !== '0') throw new Error('workflow_storage_response_invalid');
        // Exact root detail supplies the sealed body and its ordered destination snapshot.
        await store.loadInvocation(index.id);
        return store.readInvocationBindingRow(index.id);
      } });
    if (!root) throw new Error('workflow_root_invocation_missing');
    params.rootRecordId = root.index.id;
    params.checkpoint = { ...params.checkpoint, rootRecordId: root.index.id };
    return store;
  }

  private async loadInvocation(invocationId: string, snapshotRow?: unknown): Promise<void> {
    const detailResponse: Readonly<Record<string, unknown>> = snapshotRow === undefined
      ? asRecord(await this.params.storage.execute({ operation: 'invocations.get', runId: this.params.runId, invocationId }))
      : { invocation: snapshotRow };
    const invocation = asRecord(detailResponse.invocation);
    const detailIndex = asRecord(invocation.index);
    const index = WorkflowRunInvocationIndexV1Schema.parse(detailIndex);
    if (index.id !== invocationId || index.runId !== this.params.runId) throw new Error('workflow_storage_response_invalid');
    const contentEnvelope = invocation.contentEnvelope;
    if (typeof contentEnvelope !== 'string') throw new Error('workflow_storage_response_invalid');
    const opened = openWorkflowProgressSnapshotV1({
      destinationEnvelopes: invocation.destinationEnvelopes,
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
    this.remember(index, opened.content);
    if (invocation.parentRevision !== undefined) {
      this.params.revision = Math.max(this.params.revision, WorkflowRunSummaryV1Schema.shape.revision.parse(invocation.parentRevision));
    }
  }

  private async loadParentSlot(parentRecordId: string, memberOrdinal: string): Promise<void> {
    const slotKey = `${parentRecordId}:${memberOrdinal}`;
    // The Home fences every admission and this store remembers every admitted
    // child of a parent it created. Reclaimed parents still resolve on Home.
    if (this.loadedParentSlots.has(slotKey) || this.locallyCreatedParents.has(parentRecordId)) return;
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
      this.remember(index, opened.content);
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
      ...(progress.resultProvenance ? { resultProvenance: progress.resultProvenance } : {}),
      runId: index.runId, blockId: progress.invocationPath.blockId,
      memberOrdinal: index.memberOrdinal,
      ...(index.parentRecordId ? { parentKey: this.recordsById.get(index.parentRecordId)?.key } : {}),
      path: progress.invocationPath, attempt, acceptedAtMs: Date.parse(index.createdAt), lifecycle: index.lifecycle,
      ...(progress.result === undefined ? {} : { result: progress.result }),
      ...(progress.replyOutcome ? { replyOutcome: progress.replyOutcome } : {}),
      ...(progress.resultContract === undefined ? {} : { resultContract: progress.resultContract }),
      ...(progress.usage === undefined ? {} : { usage: progress.usage }),
      ...(progress.reason ? { reason: progress.reason.code } : {}),
      ...(progress.reason?.message !== undefined ? { reasonMessage: progress.reason.message } : {}),
      ...(progress.reason?.details ? { reasonDetails: progress.reason.details } : {}),
      ...(progress.reason?.failureCause ? { failureCause: progress.reason.failureCause } : {}),
      ...(progress.reason?.runtimeIssueV1 ? { runtimeIssueV1: progress.reason.runtimeIssueV1 } : {}),
      ...(progress.validationIssues ? { validationIssues: progress.validationIssues } : {}),
      ...(progress.execution ? { execution: progress.execution } : {}),
      ...(progress.sessionPermissionPending ? { sessionPermissionPending: true } : {}),
      ...(progress.sharedConversationInvocationRecordId ? { sharedConversationInvocationRecordId: progress.sharedConversationInvocationRecordId } : {}),
      ...(progress.observationDeadline ? { observationDeadline: progress.observationDeadline } : {}),
      ...(progress.input === undefined ? {} : { input: WorkflowAuthoredInputV1Schema.parse(progress.input) }),
      ...(progress.discussionReplyTo ? { discussionReplyTo: progress.discussionReplyTo } : {}),
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
    const parent = index.parentRecordId ? this.recordsById.get(index.parentRecordId) : undefined;
    this.stepProgress.remember(index, progress, record, parent?.blockKind === 'root'
      && this.currentSlots.get(slot)?.recordId === record.recordId, !cached);
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
    const parent = parentKey ? this.records.get(parentKey) : undefined;
    if ((parentKey && !parent) || memberOrdinal === undefined) return undefined;
    const parentRecordId = parent?.recordId ?? this.params.rootRecordId;
    const members = await readWorkflowInvocationMembersV1({ parentRecordIds: [parentRecordId], memberOrdinal,
      readParent: this.readInvocationBindingRow,
      readChildren: async parents => {
        await Promise.all(parents.map(id => this.loadParentSlot(id, memberOrdinal)));
        return parents.flatMap(id => {
          const selected = this.currentSlots.get(`${id}:${memberOrdinal}`);
          const index = selected && this.persisted.get(selected.key)?.index;
          return index ? [index] : [];
        });
      }, indexOf: index => index });
    const index = members.get(parentRecordId)![0];
    const selected = index ? await this.readByLogicalInvocation(index.id) : undefined;
    const resolved = selected?.runId === runId && selected.blockId === blockId ? selected : undefined;
    if (resolved && parent?.blockKind === 'root') this.stepProgress.rememberTopLevel(resolved);
    return resolved;
  };

  listCurrentMembers = (parentKey: string): Promise<readonly WorkflowRunInvocationIndexV1[]> => this.readCurrentMembers(parentKey);

  private async readCurrentMembers(parentKey: string, openProgress = false): Promise<readonly WorkflowRunInvocationIndexV1[]> {
    // Loop progress already owns these admitted indices for this claimed
    // store. remember() updates their slots on every local frame mutation;
    // a fresh claim constructs a new store and acquires its own projection.
    const projection = this.progressMembers.get(parentKey);
    if (projection) return [...projection.members.values()].sort((left, right) => BigInt(left.memberOrdinal) < BigInt(right.memberOrdinal) ? -1
      : BigInt(left.memberOrdinal) > BigInt(right.memberOrdinal) ? 1 : 0);
    const owner = this.records.get(parentKey);
    if (!owner) throw new Error('workflow_parent_invocation_missing');
    const progressRows = new Map<string, { index: WorkflowRunInvocationIndexV1; contentEnvelope: unknown; parentRevision: unknown }>();
    const selected = await readWorkflowInvocationMembersV1({ parentRecordIds: [owner.recordId],
      readParent: this.readInvocationBindingRow,
      readChildren: async parents => (await Promise.all(parents.map(async parentRecordId => {
        if (this.locallyCreatedParents.has(parentRecordId)) {
          return [...this.currentSlots.values()].flatMap(row => {
            const index = this.persisted.get(row.key)?.index;
            return index?.parentRecordId === parentRecordId ? [index] : [];
          });
        }
        const indices: WorkflowRunInvocationIndexV1[] = [];
        let cursor: string | undefined;
        do {
          const page = asRecord(await this.params.storage.execute({ operation: 'invocations.list', runId: this.params.runId,
            parentRecordId, ...(cursor ? { cursor } : {}), ...(openProgress ? { progressEnvelopes: true } : {}),
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }));
          if (!Array.isArray(page.invocations)) throw new Error('workflow_storage_response_invalid');
          const pageIndices = page.invocations.map(value => WorkflowRunInvocationIndexV1Schema.parse(value));
          if (openProgress) {
            const envelopes = asRecord(page.progressEnvelopesByInvocationId);
            for (const index of pageIndices) {
              progressRows.set(index.id, { index, contentEnvelope: envelopes[index.id], parentRevision: page.parentRevision });
            }
          }
          indices.push(...pageIndices);
          cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        } while (cursor);
        return indices;
      }))).flat(), indexOf: index => index });
    const members = new Map(selected.get(owner.recordId)!.map(index => [index.memberOrdinal, index]));
    for (const index of members.values()) {
      const progressRow = progressRows.get(index.id);
      if (progressRow && this.recordsById.get(index.id)?.contentRevision !== index.contentRevision) {
        await this.loadInvocation(index.id, progressRow);
      }
    }
    if (owner.container?.kind === 'loop') {
      // A local parallel frame may commit while the initial page is in flight.
      // Reconcile once where the membership projection is admitted, whichever
      // consumer (scheduling or progress) requested it first.
      for (const row of this.currentSlots.values()) {
        const index = this.persisted.get(row.key)?.index;
        if (index?.parentRecordId === owner.recordId) {
          const prior = members.get(index.memberOrdinal);
          if (!prior || prior.parentRecordId !== index.parentRecordId
            || BigInt(index.attempt) > BigInt(prior.attempt)
            || (index.attempt === prior.attempt && BigInt(index.contentRevision) >= BigInt(prior.contentRevision))) members.set(index.memberOrdinal, index);
        }
      }
      this.progressMembers.set(parentKey, { members,
        completed: [...members.values()].filter(index => index.lifecycle === 'completed').length });
    }
    return [...members.values()].sort((left, right) => BigInt(left.memberOrdinal) < BigInt(right.memberOrdinal) ? -1
      : BigInt(left.memberOrdinal) > BigInt(right.memberOrdinal) ? 1 : 0);
  };

  private serializeProgress(binding: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['binding'], progress: WorkflowProgressEnvelopeV1): string {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      ...sealMode(this.params.encryption), binding, progress,
    }));
  }

  private trySerializeProgress(binding: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['binding'], progress: WorkflowProgressEnvelopeV1): string | undefined {
    try { return this.serializeProgress(binding, progress); }
    catch (error) {
      const issues = error !== null && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues) ? error.issues : [];
      if (issues.some(issue => issue !== null && typeof issue === 'object' && 'message' in issue
        && issue.message === 'Stored Automation envelope exceeds its UTF-8 byte limit')) return undefined;
      throw error;
    }
  }

  private fitCommandOutput(binding: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['binding'], progress: WorkflowProgressEnvelopeV1) {
    const execution = progress.execution;
    const output = WorkflowMachineCommandOutputV1Schema.safeParse(progress.result);
    const complete = this.trySerializeProgress(binding, progress);
    if (complete !== undefined) return { progress, contentEnvelope: complete };
    if (execution?.kind !== 'action' || getWorkflowActionOutputKindV1(execution.actionId) !== 'command' || !output.success) {
      // Only command output is a suffix projection. Inputs, identities and other
      // result contracts remain governed by the incumbent envelope rejection.
      return { progress, contentEnvelope: this.serializeProgress(binding, progress) };
    }
    const suffix = (value: string, count: number) => {
      let start = Math.max(0, value.length - count);
      if (start > 0 && value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff
        && value.charCodeAt(start - 1) >= 0xd800 && value.charCodeAt(start - 1) <= 0xdbff) start++;
      return value.slice(start);
    };
    const candidate = (count: number): WorkflowProgressEnvelopeV1 => {
      const stdout = suffix(output.data.stdout, count);
      const stderr = suffix(output.data.stderr, count);
      const result = { ...output.data, stdout, stderr,
        stdoutTruncated: output.data.stdoutTruncated === true || stdout.length < output.data.stdout.length,
        stderrTruncated: output.data.stderrTruncated === true || stderr.length < output.data.stderr.length };
      return { ...progress, result,
        execution: { ...execution, ...(execution.output === undefined ? {} : { output: result }) } };
    };
    let retained = candidate(0);
    let contentEnvelope = this.trySerializeProgress(binding, retained);
    if (contentEnvelope === undefined) {
      // No valid suffix can fit. Preserve the existing storage failure; this is
      // post-effect and must never be classified as a definitive input refusal.
      return { progress, contentEnvelope: this.serializeProgress(binding, retained) };
    }
    let low = 0;
    let high = Math.max(output.data.stdout.length, output.data.stderr.length);
    // A common maximum retained length leaves short streams whole and gives
    // their unused allocation to the longer stream. The actual sealed envelope,
    // including E2EE/base64 framing and duplicate Stop output, owns capacity.
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const next = candidate(middle);
      const serialized = this.trySerializeProgress(binding, next);
      if (serialized === undefined) high = middle;
      else { low = middle; retained = next; contentEnvelope = serialized; }
    }
    return { progress: retained, contentEnvelope };
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

  ensureIntent = async (invocation: WorkflowInvocationIntent): Promise<WorkflowCoordinatorInvocation> => {
    const parentRecordId = invocation.parentKey
      ? this.records.get(invocation.parentKey)?.recordId
      : this.params.rootRecordId;
    if (!parentRecordId) throw new Error('workflow_parent_invocation_missing');
    if (invocation.lifecycle === 'running' && invocation.frame && this.locallyCreatedParents.has(parentRecordId)) {
      // The coordinator has already granted these body frames capacity. Only
      // group work that actually reached this boundary, never queued frames.
      let batch = this.pendingFrameAdmission;
      if (!batch) {
        const intents = new Map<string, WorkflowInvocationIntent>();
        const result = this.serialized(async () => {
          this.pendingFrameAdmission = undefined;
          return await this.admitNewIntents([...intents.values()]);
        });
        batch = { intents, result };
        this.pendingFrameAdmission = batch;
      }
      if (!batch.intents.has(invocation.key)) batch.intents.set(invocation.key, invocation);
      const admitted = (await batch.result).get(invocation.key);
      if (!admitted) throw new Error('workflow_storage_response_invalid');
      if (admitted.lifecycle !== 'pending') return admitted;
      return await this.commitFact({ key: admitted.key, lifecycle: invocation.lifecycle });
    }
    return await this.serialized(async () => {
      await this.loadParentSlot(parentRecordId, invocation.memberOrdinal ?? '0');
      const existing = this.records.get(invocation.key);
      if (existing) return existing;
      const pending = (await this.admitNewIntents([invocation])).get(invocation.key)!;
      if (invocation.lifecycle === pending.lifecycle) return pending;
      return await this.commitFact({ key: pending.key, lifecycle: invocation.lifecycle });
    });
  };

  private async admitNewIntents(intents: readonly WorkflowInvocationIntent[]): Promise<ReadonlyMap<string, WorkflowCoordinatorInvocation>> {
    const records = new Map<string, WorkflowCoordinatorInvocation>();
    const fresh = intents.filter(intent => {
      const existing = this.records.get(intent.key);
      if (!existing) return true;
      records.set(intent.key, existing);
      return false;
    });
    if (fresh.length === 0) return records;
    const firstSequence = BigInt(this.params.checkpoint.nextSequence);
    const prepared = fresh.map((invocation, offset) => {
      const sequence = (firstSequence + BigInt(offset)).toString();
      const parentRecordId = invocation.parentKey
        ? this.records.get(invocation.parentKey)?.recordId
        : this.params.rootRecordId;
      if (!parentRecordId) throw new Error('workflow_parent_invocation_missing');
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
      // A fresh structural frame already has capacity. Native input still
      // needs its separate, exact admitting fact before it can be released.
      const lifecycle = invocation.lifecycle === 'waiting_for_capacity'
        || (invocation.lifecycle === 'running' && invocation.container && !invocation.execution)
        ? invocation.lifecycle : undefined;
      const row = { id: invocation.recordId, sequence, parentRecordId, memberOrdinal,
        ...(lifecycle ? { lifecycle } : {}), contentEnvelope: this.serializeProgress(binding, progress) };
      return { invocation, row, progress };
    });
    const checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({
      ...this.params.checkpoint,
      nextSequence: (firstSequence + BigInt(fresh.length)).toString(),
    });
    const admission = {
      operation: 'invocations.admit', runId: this.params.runId, parentAttempt: this.params.parentAttempt,
      accountCurrentness: this.params.encryption.witness,
      checkpointEnvelope: this.serializeCheckpoint(checkpoint),
      invocations: prepared.map(item => item.row),
    } as const;
    if (prepared.length > 1 && readServerHttpRequestBodyUtf8ByteLengthV1({ ...admission,
      publisherMachineId: this.params.machineId, expectedRevision: Number.MAX_SAFE_INTEGER,
    }) > SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1) {
      for (const intent of fresh) {
        const record = (await this.admitNewIntents([intent])).get(intent.key)!;
        records.set(intent.key, record);
      }
      return records;
    }
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
    if (!Array.isArray(response.invocations) || response.invocations.length !== prepared.length
      || typeof response.parentRevision !== 'number') throw new Error('workflow_storage_response_invalid');
    const rows = response.invocations.map((value, index) => {
      const admitted = WorkflowRunInvocationIndexV1Schema.parse(value);
      const { row } = prepared[index]!;
      if (admitted.id !== row.id || admitted.runId !== this.params.runId || admitted.sequence !== row.sequence
        || admitted.parentRecordId !== row.parentRecordId || admitted.memberOrdinal !== row.memberOrdinal
        || admitted.attempt !== '0' || admitted.contentRevision !== '0'
        || admitted.lifecycle !== (row.lifecycle ?? 'pending')) throw new Error('workflow_storage_response_invalid');
      return admitted;
    });
    this.params.revision = Math.max(this.params.revision, response.parentRevision);
    this.params.checkpoint = checkpoint;
    const running: WorkflowCoordinatorInvocation[] = [];
    rows.forEach((admitted, index) => {
      const { invocation, progress } = prepared[index]!;
      const record = this.remember(admitted, progress);
      records.set(invocation.key, record);
      if (admitted.lifecycle === 'running') running.push(record);
      if (response.disposition === 'created') this.locallyCreatedParents.add(admitted.id);
      this.loadedParentSlots.add(`${admitted.parentRecordId}:${admitted.memberOrdinal}`);
    });
    if (running.length > 0) await this.refreshInvocationProgress(running);
    return records;
  }

  /** Publication observers share the root fact writer and never clear another root hold. */
  reconcilePublicationApprovalAttention = async (hasPending: () => boolean): Promise<void> => {
    const rootKey = this.recordsById.get(this.params.rootRecordId)?.key;
    if (!rootKey) throw new Error('workflow_root_invocation_missing');
    await this.serializedInvocation(rootKey, async () => {
      if (await this.readControl() !== 'running') return;
      const root = this.recordsById.get(this.params.rootRecordId);
      if (!root || (root.lifecycle !== 'running' && root.lifecycle !== 'needs_attention')
        || root.reason !== undefined && root.reason !== 'approval_required') return;
      const pending = hasPending();
      if (pending) {
        if (root.lifecycle !== 'needs_attention' || root.reason !== 'approval_required') {
          await this.commitFactNow({ key: root.key, lifecycle: 'needs_attention', reason: 'approval_required' });
        }
      } else if (root.reason === 'approval_required') {
        await this.commitFactNow({ key: root.key, lifecycle: 'running' });
      }
    });
  };

  private async commitFactNow(
    fact: Parameters<WorkflowCoordinatorStore['commitFact']>[0],
    stepProgress?: WorkflowRunStepProgressV1,
    loopProgress?: WorkflowProgressEnvelopeV1['loopProgress'],
    discussionRound?: WorkflowDiscussionRoundProgressV1,
  ): Promise<WorkflowCoordinatorInvocation> {
    const current = this.records.get(fact.key);
    const persisted = this.persisted.get(fact.key);
    if (!current || !persisted) throw new Error('workflow_invocation_intent_missing');
    if (current.lifecycle === 'waiting_for_review' && fact.interaction !== undefined) return current;
    // These root facts own metadata only. Their caller may have captured a
    // lifecycle before entering this queue; only a lifecycle owner may change
    // the current state or retire its reason.
    const preservesRootLifecycle = current.recordId === this.params.rootRecordId
      && (stepProgress !== undefined || loopProgress !== undefined
        || (fact.resultProvenance !== undefined || fact.workspace !== undefined || fact.sharedConversationInvocationRecordId !== undefined)
          && Object.keys(fact).every(key => key === 'key' || key === 'lifecycle' || key === 'resultProvenance'
            || key === 'workspace' || key === 'sharedConversationInvocationRecordId'));
    if (preservesRootLifecycle) fact = { ...fact, lifecycle: current.lifecycle };
    const updatesInteraction = fact.interaction !== undefined;
    const observesDetachedExecution = fact.lifecycle === 'running' && fact.execution?.kind === 'detached_run';
    if ((updatesInteraction || observesDetachedExecution)
      && (current.lifecycle === 'admitting' || current.lifecycle === 'running' || current.lifecycle === 'waiting_for_approval')) {
      // A detached execution can report acceptance or usage while its tool request is still open.
      const interaction = updatesInteraction ? fact.interaction : persisted.progress.interaction;
      const requests = interaction && typeof interaction === 'object' && 'requests' in interaction
        ? interaction.requests : undefined;
      const hasOutstandingRequests = requests && typeof requests === 'object' && !Array.isArray(requests)
        && Object.keys(requests).length > 0;
      const lifecycle = hasOutstandingRequests ? 'waiting_for_approval'
        : updatesInteraction && current.lifecycle === 'waiting_for_approval' ? 'running' : fact.lifecycle;
      if (fact.lifecycle !== lifecycle) fact = { ...fact, lifecycle };
    }
    const { key: _key, lifecycle: _lifecycle, review, advanceFrontierTo, ...ownedFact } = fact;
    const { reason: _reason, reasonMessage: _reasonMessage, reasonDetails: _reasonDetails, failureCause: _failureCause, runtimeIssueV1: _runtimeIssueV1, ...withoutInvalidResultReason } = ownedFact;
    const publishedResultWins = fact.lifecycle === 'waiting_for_review' && fact.reason === 'invalid_result_contract'
      && persisted.progress.review?.resultSource?.kind === 'published' && persisted.progress.result !== undefined;
    // The structural root reports the current orchestration failure, rather
    // than a leaf's immutable observation/review history. A newly admitted
    // running boundary retires its old failure; a new refusal replaces it.
    // Aggregate refreshes alone cannot authorize either transition.
    const updatesRootReason = current.recordId === this.params.rootRecordId && !preservesRootLifecycle
      && (fact.reason !== undefined || (fact.lifecycle === 'running' && !stepProgress && !loopProgress));
    const { reason: _previousRootReason, ...withoutRootReason } = persisted.progress;
    const priorProgress = updatesRootReason ? withoutRootReason : persisted.progress;
    let progress = WorkflowProgressEnvelopeV1Schema.parse({ ...applyWorkflowInvocationFactV1(priorProgress,
      WorkflowInvocationFactV1Schema.parse(publishedResultWins ? withoutInvalidResultReason : ownedFact),
      { previousLifecycle: current.lifecycle, lifecycle: fact.lifecycle, observedAtMs: Date.now() }),
      ...(review ? { review: { ...review, ...(persisted.progress.review?.resultSource ? { resultSource: persisted.progress.review.resultSource } : {}) } } : {}),
      ...(stepProgress ? { stepProgress } : {}) });
    if (loopProgress) progress = WorkflowProgressEnvelopeV1Schema.parse({ ...progress, loopProgress });
    // A native answer is applied before its durable completion write, so the
    // turn can settle this row first. The server refuses later content writes
    // to a settled row, so a request still listed here would stay offered forever.
    const settles = (lifecycle: WorkflowCoordinatorInvocation['lifecycle']) => !WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1
      .some(unsettled => unsettled === lifecycle);
    const settledInteraction = progress.interaction;
    if (settles(fact.lifecycle) && !settles(current.lifecycle) && settledInteraction && typeof settledInteraction === 'object'
      && !Array.isArray(settledInteraction) && 'requests' in settledInteraction) {
      const { requests: _outstanding, ...interaction } = settledInteraction;
      progress = WorkflowProgressEnvelopeV1Schema.parse({ ...progress, interaction });
    }
    // Compare before sealing: E2EE ciphertext changes even for an equal fact.
    // An unchanged row is not a write (each write is a server CAS and Run
    // publication). Admitting still reaches the final parent/control predicate
    // on every input.
    if (current.lifecycle === fact.lifecycle && fact.lifecycle !== 'admitting'
      && discussionRound === undefined && sameStrictJsonValue(progress, persisted.progress)) return current;
    const index = persisted.index;
    const binding = {
      v: 1 as const, purpose: 'invocation_progress' as const, accountId: this.params.accountId, runId: this.params.runId,
      recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
      memberOrdinal: index.memberOrdinal, attempt: index.attempt,
    };
    if (fact.lifecycle === 'admitting' && progress.execution?.kind === 'action'
      && getWorkflowActionOutputKindV1(progress.execution.actionId) === 'command') {
      // Windows process status is a 32-bit DWORD. Reserve the longer signed
      // interpretation as well as unsigned Node/Bun-compatible producers;
      // POSIX statuses and BASH's -1 sentinel are shorter. This is serialized
      // field width, not a numeric restriction on the public output schema.
      const minimalReply = { exitCode: -0x80000000, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
      const minimalTerminal = { ...progress, reason: progress.reason ?? { code: 'command_cancelled' }, result: minimalReply,
        execution: { ...progress.execution, output: minimalReply } };
      if (this.trySerializeProgress(binding, minimalTerminal) === undefined) {
        // This check precedes the transport call: no command input was released.
        throw new WorkflowInputResolutionError('workflow_input_too_large');
      }
    }
    const publication = prepareWorkflowDestinationPublicationV1({
      accountId: this.params.accountId, runId: this.params.runId,
      ...sealMode(this.params.encryption), progress, previous: persisted.progress,
    });
    const fitted = this.fitCommandOutput(binding, publication.progress);
    progress = progress.stepProgress?.destinations
      ? { ...fitted.progress, stepProgress: progress.stepProgress }
      : fitted.progress;
    // Compare the exact persisted projection, not raw output that cannot fit.
    const effectiveFact = { ...fact,
      ...(fact.result === undefined ? {} : { result: progress.result }),
      ...(fact.execution === undefined ? {} : { execution: progress.execution }) };
    let updatedIndex: WorkflowRunInvocationIndexV1;
    try {
      const frontierCheckpoint = advanceFrontierTo !== undefined && fact.lifecycle === 'completed'
        && index.parentRecordId === this.params.rootRecordId
        && this.params.checkpoint.frontier.nextBlockOrdinal === advanceFrontierTo - 1 && !this.params.checkpoint.frontier.paused
        ? WorkflowCheckpointEnvelopeV1Schema.parse({ ...this.params.checkpoint,
          frontier: { ...this.params.checkpoint.frontier, nextBlockOrdinal: advanceFrontierTo } })
        : undefined;
      const { parentRevision, frontierCommitted, ...updated } = WorkflowInvocationFactResultV1Schema.parse(await this.params.storage.execute({
        operation: 'invocations.fact', runId: this.params.runId,
        ...(stepProgress && this.params.projectionExpectedRevision !== undefined
          ? { expectedRevision: this.params.projectionExpectedRevision, resolution: 'root_list_progress' }
          : { parentAttempt: this.params.parentAttempt }),
        accountCurrentness: this.params.encryption.witness,
        invocationId: index.id, invocationAttempt: index.attempt, expectedLifecycle: index.lifecycle, expectedContentRevision: index.contentRevision,
        lifecycle: fact.lifecycle, contentEnvelope: fitted.contentEnvelope,
        ...(publication.destinationWrites.length ? { destinationWrites: publication.destinationWrites } : {}),
        ...(discussionRound ? { discussionRound } : {}),
        ...(frontierCheckpoint ? { frontier: { expectedParentRevision: this.params.revision,
          checkpointEnvelope: this.serializeCheckpoint(frontierCheckpoint) } } : {}),
      }));
      this.params.revision = Math.max(this.params.revision, parentRevision);
      if (frontierCommitted && frontierCheckpoint) this.params.checkpoint = frontierCheckpoint;
      updatedIndex = updated;
    } catch (error) {
      // Cancellation changes the exact row lifecycle at the server. Reload the
      // row once so that this CAS loser cannot overwrite or hide that control.
      if (fact.lifecycle === 'admitting') {
        // A lost admission acknowledgement is ambiguous, and a repeated
        // admitting fact may have lost its exact parent/control predicate.
        // Reloading the same row cannot authorize either input release.
        try { await this.loadInvocation(index.id); }
        catch (reloadError) {
          throw reloadError instanceof WorkflowInputResolutionError
            ? new Error('workflow_admission_ack_uncertain', { cause: reloadError }) : reloadError;
        }
        throw error instanceof WorkflowInputResolutionError ? new Error('workflow_admission_ack_uncertain', { cause: error }) : error;
      }
      await this.loadInvocation(index.id);
      const refreshed = this.records.get(fact.key);
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
        && (effectiveFact.result === undefined || sameStrictJsonValue(refreshed.result, effectiveFact.result))
        && (fact.resultContract === undefined || sameStrictJsonValue(refreshed.resultContract, fact.resultContract))
        && (fact.replyOutcome === undefined || sameStrictJsonValue(refreshed.replyOutcome, fact.replyOutcome))
        && (fact.usage === undefined || sameStrictJsonValue(refreshed.usage, fact.usage))
        && (fact.reason === undefined || refreshed.reason === fact.reason)
        && (fact.reasonMessage === undefined || refreshed.reasonMessage === fact.reasonMessage)
        && (fact.reasonDetails === undefined || sameStrictJsonValue(refreshed.reasonDetails, fact.reasonDetails))
        && (fact.failureCause === undefined || sameStrictJsonValue(refreshed.failureCause, fact.failureCause))
        && (fact.runtimeIssueV1 === undefined || sameStrictJsonValue(refreshed.runtimeIssueV1, fact.runtimeIssueV1))
        && (!updatesRootReason || sameStrictJsonValue(this.persisted.get(fact.key)?.progress.reason, progress.reason))
        && (effectiveFact.execution === undefined || sameStrictJsonValue(refreshed.execution, effectiveFact.execution))
        && (fact.observationDeadline === undefined || sameStrictJsonValue(refreshed.observationDeadline, fact.observationDeadline))
        && (fact.input === undefined || sameStrictJsonValue(refreshed.input, fact.input))
        && (fact.discussionReplyTo === undefined || sameStrictJsonValue(refreshed.discussionReplyTo, fact.discussionReplyTo))
        && (fact.container === undefined || sameStrictJsonValue(refreshed.container, fact.container))
        && (fact.containerResult === undefined || sameStrictJsonValue(refreshed.containerResult, fact.containerResult))
        && (fact.resultProvenance === undefined || Object.entries(fact.resultProvenance).every(([id, provenance]) =>
          refreshed.resultProvenance?.[id]?.notificationCondition === 'matched'
          || refreshed.resultProvenance?.[id]?.notificationCondition === provenance.notificationCondition))
        && (stepProgress === undefined || sameStrictJsonValue(this.persisted.get(fact.key)?.progress.stepProgress, stepProgress))
        && (loopProgress === undefined || sameStrictJsonValue(this.persisted.get(fact.key)?.progress.loopProgress, loopProgress))
        && workspaceMatches
        && sharedConversationMatches) {
        return refreshed;
      }
      const actionLaunch = fact.execution?.kind === 'action' ? fact.execution : undefined;
      const matchesActionRequest = (execution: WorkflowCoordinatorInvocation['execution']) => actionLaunch
        && execution?.kind === 'action' && execution.actionId === actionLaunch.actionId
        && execution.actionRequestId === actionLaunch.actionRequestId && execution.localInputId === actionLaunch.localInputId
        && sameStrictJsonValue(execution.input, actionLaunch.input);
      const exactAcceptance = fact.execution?.kind === 'session' || fact.execution?.kind === 'session_ready'
        ? sameStrictJsonValue(current.execution, fact.execution) && sameStrictJsonValue(refreshed?.execution, fact.execution)
        : actionLaunch?.output !== undefined && (actionLaunch.awaitedRuns !== undefined || actionLaunch.awaitedOperations !== undefined || actionLaunch.awaitedWorkflows !== undefined)
          && matchesActionRequest(current.execution) && matchesActionRequest(refreshed?.execution);
      if (current.lifecycle === 'admitting' && fact.lifecycle === 'running'
        && refreshed?.lifecycle === 'cancel_requested' && exactAcceptance) {
        // A positive host acceptance or exact Action launch response arrived
        // while Cancel swept the row. Preserve it in the refreshed content,
        // without releasing input or reopening cancellation custody.
        return await this.commitFactNow({ ...fact, lifecycle: 'cancel_requested' });
      }
      const exactImmediateOutput = actionLaunch?.output !== undefined && actionLaunch.awaitedRuns === undefined && actionLaunch.awaitedOperations === undefined && actionLaunch.awaitedWorkflows === undefined
        && fact.result !== undefined && sameStrictJsonValue(fact.result, actionLaunch.output)
        && matchesActionRequest(current.execution) && matchesActionRequest(refreshed?.execution);
      const exactCancelledCommand = fact.execution === undefined && fact.reason === 'command_cancelled'
        && fact.result !== undefined && current.execution?.kind === 'action'
        && getWorkflowActionOutputKindV1(current.execution.actionId) === 'command'
        && WorkflowMachineCommandOutputV1Schema.safeParse(fact.result).success;
      if (current.lifecycle === 'admitting' && fact.lifecycle === 'cancelled'
        && refreshed?.lifecycle === 'cancel_requested'
        && refreshed.recordId === current.recordId && refreshed.attempt === current.attempt
        && sameStrictJsonValue(refreshed.execution, current.execution)
        && (exactImmediateOutput || exactCancelledCommand)) {
        // Retain the definitive reply for the exact stopped row and attempt,
        // merging into its refreshed content under the existing custody CAS.
        return await this.commitFactNow(fact);
      }
      if ((fact.lifecycle === 'cancelled' || fact.lifecycle === 'completed' || fact.lifecycle === 'failed')
        && refreshed?.lifecycle === 'cancel_requested'
        && current.lifecycle !== 'admitting'
        && refreshed.contentRevision !== current.contentRevision
        && sameStrictJsonValue(current.execution, refreshed.execution)
        && (fact.execution === undefined || sameStrictJsonValue(fact.execution, current.execution))) {
        // Stop may sweep the row after its executor has proved settlement.
        // Keep that exact input's terminal fact (or a structural frame's
        // unwind) under the refreshed CAS instead of abandoning stop custody.
        return await this.commitFactNow(fact);
      }
      if (refreshed && refreshed.contentRevision !== current.contentRevision && (stepProgress || loopProgress)
        && (refreshed.lifecycle === current.lifecycle || refreshed.lifecycle === 'cancel_requested')) {
        // Aggregates carry observed progress, not lifecycle authority. Rebase
        // after a competing publication or Stop without reopening its control
        // state or losing a member that completed before cancellation.
        this.loadedParentSlots.clear();
        this.locallyCreatedParents.clear();
        this.progressMembers.clear();
        return await this.commitFactNow({ ...fact, lifecycle: refreshed.lifecycle }, stepProgress ? await this.projectStepProgress() : undefined,
          loopProgress ? await this.projectLoopProgress(refreshed) : undefined,
          discussionRound ? await this.readDiscussionRoundProgress() : undefined);
      }
      if (refreshed?.lifecycle === 'cancel_requested' || refreshed?.lifecycle === 'cancelled') {
        throw new WorkflowControlBoundary('cancelled');
      }
      if (refreshed?.lifecycle === 'superseded') throw error;
      if (refreshed?.contentRevision !== current.contentRevision && refreshed?.lifecycle === current.lifecycle) {
        return await this.commitFactNow(fact);
      }
      throw error;
    }
    if (discussionRound) this.lastDiscussionRoundProgress = discussionRound;
    return this.remember(updatedIndex, progress);
  }

  commitFact = async (
    fact: Parameters<WorkflowCoordinatorStore['commitFact']>[0],
  ): Promise<WorkflowCoordinatorInvocation> => {
    const result = await this.serializedInvocation(fact.key, async () => await this.commitFactNow(fact));
    await this.refreshInvocationProgress([result]);
    return result;
  };

  private async refreshInvocationProgress(records: readonly WorkflowCoordinatorInvocation[]): Promise<void> {
    const loops = new Set<string>();
    let rootChanged = this.params.destinations !== undefined;
    for (const record of records) {
      const parentId = this.persisted.get(record.key)?.index.parentRecordId;
      const parent = parentId ? this.recordsById.get(parentId) : undefined;
      const parentIndex = parent ? this.persisted.get(parent.key)?.index : undefined;
      const currentParent = parentIndex ? this.currentSlots.get(`${parentIndex.parentRecordId}:${parentIndex.memberOrdinal}`) ?? parent : parent;
      if (record.container?.kind === 'loop') loops.add(record.key);
      if (currentParent?.container?.kind === 'loop') loops.add(currentParent.key);
      rootChanged ||= parentId === this.params.rootRecordId
        || (parent?.blockKind === 'loop' && parentIndex?.parentRecordId === this.params.rootRecordId);
    }
    for (const key of loops) await this.refreshLoopProgress(key);
    if (rootChanged) await this.refreshStepProgress();
  }

  private async projectLoopProgress(invocation: WorkflowCoordinatorInvocation, authoredTotal?: number): Promise<WorkflowProgressEnvelopeV1['loopProgress']> {
    const loop = invocation.container;
    if (loop?.kind !== 'loop') return undefined;
    const total = loop.mode === 'items' ? Number(loop.itemCount) : loop.mode === 'count' ? Number(loop.count) : authoredTotal;
    if (total === undefined) return undefined;
    let projection = this.progressMembers.get(invocation.key);
    if (!projection) {
      await this.listCurrentMembers(invocation.key);
      projection = this.progressMembers.get(invocation.key);
      if (!projection) throw new Error('workflow_loop_projection_missing');
    }
    // nextMemberIndex is the admission frontier, never a completion count.
    return { completed: projection.completed, total };
  }

  private async refreshLoopProgress(key: string): Promise<void> {
    await this.serializedInvocation(key, async () => {
      const invocation = this.records.get(key);
      if (!invocation || isTerminalWorkflowInvocationLifecycleV1(invocation.lifecycle)) return;
      const loopProgress = await this.projectLoopProgress(invocation);
      if (!loopProgress || sameStrictJsonValue(this.persisted.get(key)?.progress.loopProgress, loopProgress)) return;
      await this.commitFactNow({ key, lifecycle: invocation.lifecycle }, undefined, loopProgress);
    });
  }

  private async projectStepProgress(): Promise<WorkflowRunStepProgressV1> {
    const definition = this.params.authoredDefinition;
    const root = this.recordsById.get(this.params.rootRecordId);
    if (!definition || !root) throw new Error('workflow_root_invocation_missing');
    if (!this.stepProgressReconstructed) {
      // Recovery opens admitted rows, never future authored slots. Subsequent
      // local admissions and facts update the aggregate in remember().
      for (const index of await this.readCurrentMembers(root.key, true)) {
        const invocation = await this.readByLogicalInvocation(index.id);
        const current = this.currentSlots.get(`${root.recordId}:${index.memberOrdinal}`)
          ?? this.currentSlots.get(`${index.parentRecordId}:${index.memberOrdinal}`) ?? invocation;
        if (current) this.stepProgress.rememberTopLevel(current);
      }
      this.stepProgressReconstructed = true;
    }
    let currentLoop: WorkflowRunStepProgressV1['currentLoop'];
    for (const invocation of this.stepProgress.currentLoops()) {
      const ordinal = Number(invocation.memberOrdinal);
      const loop = invocation.container;
      if (loop?.kind !== 'loop') continue;
      const frozenBlock = this.params.definition?.blocks[ordinal] ?? definition.blocks[ordinal];
      const total = loop.mode === 'items' ? Number(loop.itemCount) : loop.mode === 'count' ? Number(loop.count)
        : frozenBlock?.kind === 'loop' && frozenBlock.id === invocation.blockId && 'maxIterations' in frozenBlock.repetition
          ? frozenBlock.repetition.maxIterations : undefined;
      if (typeof total !== 'number') continue;
      currentLoop = await this.projectLoopProgress(invocation, total);
    }
    return this.stepProgress.project(currentLoop);
  }

  /** Reuse the built-in's durable outcome aggregate and exact current slots, never scan private list rows. */
  readDiscussionRoundProgress = async (): Promise<WorkflowDiscussionRoundProgressV1 | undefined> => {
    const binding = this.params.discussionRound;
    const root = this.recordsById.get(this.params.rootRecordId);
    if (!binding || !root) return undefined;
    const child = (parent: WorkflowCoordinatorInvocation, blockId: string, ordinal: number) => this.readCurrent({
      runId: this.params.runId, blockId, scope: [], parentKey: parent.key, memberOrdinal: String(ordinal),
    });
    const answered = (row: WorkflowCoordinatorInvocation | undefined) => row?.lifecycle === 'completed'
      && (row.replyOutcome ? row.replyOutcome.kind === 'answer' : typeof row.result === 'string' && row.result.trim().length > 0);
    if (binding.pattern === 'answer_and_review') {
      return { discussionId: binding.discussionId, answerCount: Number(answered(await child(root, 'answer', 0))), synthesized: false };
    }
    const outcomes = await child(root, 'outcomes', 1);
    const parsed = outcomes?.lifecycle === 'completed' ? WorkflowDiscussionRoundProjectResultV1Schema.safeParse(outcomes.result) : undefined;
    const synthesis = await child(root, 'synthesize', 2);
    const choice = synthesis ? await child(synthesis, 'choose-synthesizer', 0) : undefined;
    const selected = choice?.container?.kind === 'if' ? choice.container.selected : undefined;
    const result = choice && selected ? await child(choice, selected === 'then' ? 'selected-synthesis' : 'synthesis', 0) : undefined;
    return { discussionId: binding.discussionId,
      answerCount: parsed?.success ? parsed.data.outcomeReferences.filter(outcome => outcome.kind === 'answer').length : 0,
      synthesized: answered(result) };
  };

  /** The executing/recovery owner publishes counts; list readers never reconstruct private structure. */
  refreshStepProgress = async (): Promise<void> => {
    const root = this.recordsById.get(this.params.rootRecordId);
    if (!this.params.authoredDefinition || !root) return;
    await this.serializedInvocation(root.key, async () => {
      const currentRoot = this.recordsById.get(this.params.rootRecordId);
      if (!currentRoot) throw new Error('workflow_root_invocation_missing');
      // Aggregate writes cannot resolve an uncertain execution outcome.
      if (isTerminalWorkflowInvocationLifecycleV1(currentRoot.lifecycle)) return;
      const stepProgress = await this.projectStepProgress();
      const discussionRound = await this.readDiscussionRoundProgress();
      const roundChanged = !sameStrictJsonValue(this.lastDiscussionRoundProgress, discussionRound);
      const persisted = this.persisted.get(root.key);
      if (sameStrictJsonValue(persisted?.progress.stepProgress, stepProgress) && !roundChanged) return;
      await this.commitFactNow({ key: root.key, lifecycle: currentRoot.lifecycle }, stepProgress, undefined,
        roundChanged ? discussionRound : undefined);
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
          if (this.trySerializeProgress(binding, candidate) === undefined) {
            throw createWorkflowInteractionCapacityError();
          }
          await this.commitFactNow({
            key,
            lifecycle: current.index.lifecycle,
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
      if (!leaf?.execution || (leaf.execution.kind !== params.targetClass
        && !(params.targetClass === 'session' && leaf.execution.kind === 'session_ready'))) {
        throw workflowConversationResolverUnavailable(leaf?.execution ? 'target_kind_mismatch' : 'session_unavailable',
          { kind: params.targetClass, ids: [params.invocationRecordId] },
          leaf?.execution ? { kind: leaf.execution.kind } : { kind: 'unset' });
      }
      const previousId = owner.sharedConversationInvocationRecordId?.[params.targetClass];
      const previous = previousId ? await this.readByLogicalInvocation(previousId) : undefined;
      if (previousId && !previous?.execution) throw workflowConversationResolverUnavailable('recovery_execution_missing',
        { kind: params.targetClass, ids: [previousId] }, { kind: 'unset' });
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
      const result = createStoredReadSchema(ReviewStartTerminalValueV1Schema).safeParse(record.result);
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
        const current = opened.content;
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
    const snapshot = parseRunControl(await this.params.storage.execute({ operation: 'get', runId: this.params.runId, projection: 'control' }));
    this.params.revision = Math.max(this.params.revision, snapshot.run.revision);
    // The Run snapshot projects the original root for list progress. Recovery
    // selects its current physical root through the authenticated checkpoint.
    const projectedRootId = snapshot.rootProgress === undefined || snapshot.rootProgress === null
      ? undefined : asRecord(asRecord(snapshot.rootProgress).index).id;
    if (projectedRootId === this.params.rootRecordId) {
      const projected = WorkflowRunInvocationIndexV1Schema.parse(asRecord(snapshot.rootProgress).index);
      if (projected.runId !== this.params.runId) throw new Error('workflow_storage_response_invalid');
      const cached = this.rootIndex;
      // The control projection carries current lifecycle and revision, without destination rows.
      // Reload the exact snapshot only when the authoritative root differs from our opened row.
      if (projected.contentRevision !== cached?.contentRevision || projected.lifecycle !== cached.lifecycle) {
        await this.refreshRootIndex();
      }
    } else {
      const root = this.recordsById.get(this.params.rootRecordId);
      if (projectedRootId !== undefined && projectedRootId !== root?.logicalInvocationRecordId) {
        throw new Error('workflow_storage_response_invalid');
      }
      // A snapshot without the root projection still uses the exact row
      // reader; a prior in-memory root is never fresh control evidence.
      await this.refreshRootIndex();
    }
    const root = this.rootIndex;
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
    const snapshot = parseRunControl(await this.params.storage.execute({ operation: 'get', runId: this.params.runId, projection: 'revision' }));
    const revision = snapshot.run.revision;
    this.params.revision = Math.max(this.params.revision, revision);
    const pending = new Set(recordIds);
    if (pending.size > 1) {
      const request = { operation: 'invocations.list', runId: this.params.runId,
        invocationIds: [...pending], progressEnvelopes: true, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } as const;
      let cursor: string | undefined;
      do {
        const operation = cursor ? { ...request, cursor } : request;
        if (readServerHttpRequestBodyUtf8ByteLengthV1({ ...operation, publisherMachineId: this.params.machineId })
          > SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1) break;
        const page = asRecord(await this.params.storage.execute(operation));
        if (!Array.isArray(page.invocations)) throw new Error('workflow_storage_response_invalid');
        const envelopes = asRecord(page.progressEnvelopesByInvocationId);
        for (const value of page.invocations) {
          const index = WorkflowRunInvocationIndexV1Schema.parse(value);
          if (!pending.delete(index.id)) throw new Error('workflow_storage_response_invalid');
          await this.loadInvocation(index.id, { index, contentEnvelope: envelopes[index.id], parentRevision: page.parentRevision });
        }
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        if (!cursor && pending.size > 0) throw new Error('workflow_invocation_intent_missing');
      } while (cursor);
    }
    for (const id of pending) await this.loadInvocation(id);
    const selected = recordIds.map(id => {
      const record = this.recordsById.get(id);
      if (!record) throw new Error('workflow_invocation_intent_missing');
      return record;
    });
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
      this.locallyCreatedParents.delete(index.parentRecordId);
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
      timing: _timing, loopProgress: _loopProgress,
      observationDeadline: _deadline, usage: _usage, interaction: _interaction, sessionPermissionPending: _sessionPermissionPending, ...retained } = persisted.progress;
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
    if (!leaf?.execution || (leaf.execution.kind !== binding.targetClass
      && !(binding.targetClass === 'session' && leaf.execution.kind === 'session_ready'))) {
      throw workflowConversationResolverUnavailable(leaf?.execution ? 'target_kind_mismatch' : 'session_unavailable',
        { kind: binding.targetClass, ids: [pointer] }, leaf?.execution ? { kind: leaf.execution.kind } : { kind: 'unset' });
    }
    return leaf;
  }
}

export type WorkflowProductionExecutionDeps = Readonly<{
  credentials: StoredCredentials;
  secretSources?: NonNullable<Parameters<typeof createWorkflowRunCommittedNotificationHandler>[0]>['secretSources'];
  sessionStartup?: import('./sessionStepExecutor').WorkflowSessionStartup;
  /** Stable Home identity used by Account-scoped domain rows. */
  serverIdentityId?: string;
  /** Device-local profile/routing key used by Session and Action transports. */
  serverId: string;
  machineAdmissionTransport: NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;
  resolveExistingSessionConversation: Parameters<typeof createProductionWorkflowSessionStepExecutor>[0]['resolveExistingSessionConversation'];
  /** Canonical Session I/O boundary adapter; production uses the incumbent default owner. */
  sessionInput?: Parameters<typeof createProductionWorkflowSessionStepExecutor>[0]['sessionInput'];
  postWorkflowMessage?: Parameters<typeof createDiscussionReplyReturnPublisher>[0]['postWorkflowMessage'];
  originSessionInput?: Parameters<typeof createWorkflowSessionStepExecutor>[0]['originSessionInput'];
  detachedRun: Omit<WorkflowDetachedExecutionRunStepExecutorDeps, 'resolveSharedRunConversation' | 'resolveProducerConversation' | 'workDepth' | 'resolveRoleInstructions'> & Readonly<{
    actionExecutor: WorkflowDetachedExecutionRunStepExecutorDeps['actionExecutor'] & Readonly<{
      resolveReviewServices?: (context?: ActionExecutorContext) => Promise<CliReviewServices>;
    }>;
  }>;
  action?: import('./coordinator').WorkflowActionExecutor;
}>;

export function createWorkflowRunPushNotificationClient(token: string): PushNotificationClient {
  return new PushNotificationClient(token);
}

export type WorkflowTriggerClaimSource =
  | Readonly<{ kind: 'inline'; definition: WorkflowDefinitionV1 }>
  | Readonly<{ kind: 'catalog'; definition: WorkflowDefinitionV1; ref: string; version: number | string;
    metadata?: WorkflowDefinitionMetadataV1 }>
  | Readonly<{ kind: 'saved' } & Awaited<ReturnType<ReturnType<typeof createWorkflowDefinitionActions>['get']>>>;

export type WorkflowTriggerAdmissionRefusal = Readonly<{
  state: 'failed' | 'skipped';
  reason: string;
  blockId?: string;
  targetUnavailableReason?: WorkflowTargetUnavailableReasonV1;
  targetUnavailablePlatformReason?: WorkflowTargetUnavailableDiagnosticV1['platformReason'];
  /** No accepted snapshot or coordinator effects were committed by this claim. */
  admission: 'refused';
}>;
export type WorkflowClaimCoordinationResult = WorkflowCoordinatorResult | WorkflowTriggerAdmissionRefusal
  | Readonly<{ state: 'failed'; reason: 'waiting_for_keys'; preInitializationFailure: true }>;

function refuseWorkflowTriggerAdmission(reason: string, blockId?: string): WorkflowTriggerAdmissionRefusal {
  return { state: 'failed', reason, ...(blockId === undefined ? {} : { blockId }), admission: 'refused' };
}

/** Resolves current source bytes through the existing Artifact/definition owner; E7 owns materialization. */
export async function resolveWorkflowTriggerClaimSource(params: Readonly<{
  target: TriggerTargetV1;
  credentials: StoredCredentials;
  encryption: AvailableAutomationAccountEncryptionV1;
  event?: WorkflowTriggerEventIdentityV1;
  signal?: AbortSignal;
}>): Promise<WorkflowTriggerClaimSource | null> {
  params.signal?.throwIfAborted();
  if (params.target.kind === 'inline') return { kind: 'inline', definition: params.target.definition };
  const artifactStore = createAccountArtifactStore({
    credentials: params.credentials,
    resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() }),
    getAccountEncryptionMode: async () => params.encryption.witness.mode,
  });
  const definitions = createWorkflowDefinitionActions({ artifactStore });
  return resolveWorkflowDefinitionRefV1(params.target.ref, {
    ...(params.event ? { event: params.event } : {}),
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
  requesterWorkAttributionV1?: import('@/daemon/lifecycle/requesterWorkAttribution').RequesterWorkAttributionV1;
  token: string;
  accountId: string;
  machineId: string;
  resolveAccountEncryption: (signal?: AbortSignal) => Promise<AvailableAutomationAccountEncryptionV1>;
  isAcceptedAuthorizationCurrent: WorkflowAcceptedAuthorizationCurrentness;
  waitForNewWorkAdmission?: (signal?: AbortSignal) => Promise<void>;
  /** Fresh host policy for trigger admission; Resume consumes its actual Action caller. */
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
  restoreManagedWorkspaceSource?: import('./resolveWorkflowWorkspace').RestoreManagedWorkflowWorkspaceSource;
  /**
   * The SCM/worktree boundary reached through the daemon-applied plugin
   * runtime. Production omits it and uses the canonical owners; composed tests
   * that run outside a loaded daemon supply it, exactly as
   * `prepareAcceptedWorkspaceTarget` already allows for accepted targets.
   */
  workspaceScm?: Parameters<typeof createCoordinatorWorkspaceResolver>[0]['scm'];
  resolveCurrentWorkspaceRefs?: (signal?: AbortSignal) => Promise<readonly import('@happier-dev/protocol').WorkspaceRefV1[]>;
  /** The preview owner derives this occurrence's Workflow from current private template intent. */
  resolveDeploymentPreviewWorkflow?: (input: Readonly<{
    templateRef: Readonly<{ serverId: string; environmentId: string }>;
    evidence: unknown; runId: string; signal?: AbortSignal;
  }>) => Promise<Readonly<{ kind: 'available'; definition: WorkflowDefinitionV1 }>
    | Readonly<{ kind: 'skipped' | 'refused'; reason: string }>>;
  onCommittedTransition?: (transition: Readonly<{ run: WorkflowRunSummaryV1; result: WorkflowCoordinatorResult }>) => Promise<void> | void;
  onReviewEntered?: (entry: Readonly<{ runId: string }>) => Promise<void> | void;
  storage?: StorageClient;
}>): (claim: WorkflowClaimForCoordination) => Promise<WorkflowClaimCoordinationResult> {
  const baseStorage = params.storage ?? createWorkflowRunStorageClient({ token: params.token, machineId: params.machineId });
  const readRunReportPolicy = createSessionRunReportPolicyReader({
    serverId: params.execution.serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl(), accountId: params.accountId,
    readCredentials: async () => params.execution.credentials,
    // This coordinator captures one admitted Account credential; it never follows ambient Account changes.
    isCurrent: () => params.execution.credentials.token === params.token,
  });
  const onReviewEntered = params.onReviewEntered ?? createWorkflowRunReviewEntryNotificationHandler({
    secretSources: params.execution.secretSources,
    expoPushSender: createWorkflowRunPushNotificationClient(params.token),
  });
  return async (claim) => {
    // Stop cancels leaf execution; the worker lifetime keeps storage available
    // until the coordinator has recorded the Run's terminal outcome.
    const storage: StorageClient = { ...baseStorage, execute: (operation, options = {}) => baseStorage.execute(operation, {
      ...options,
      ...(claim.storageSignal ? { signal: options.signal
        ? AbortSignal.any([claim.storageSignal, options.signal]) : claim.storageSignal } : {}),
    }) };
    const accountEncryption = await params.resolveAccountEncryption(claim.signal);
    // The claim owns this Run/attempt, not the Account-wide change cursor.
    // Unrelated publications can advance that cursor before we open content;
    // mode/key identity plus the storage and accepted-authority fences govern it.
    if (!sameAutomationAccountContentIdentityV1(accountEncryption.witness, claim.accountCurrentness)) {
      logger.debug('[WORKFLOW] Claim content identity unavailable before initialization', {
        runId: claim.runId, attempt: claim.attempt, stage: 'claim_content_identity', reason: 'content_unavailable',
        claimVersion: claim.accountCurrentness.version, currentVersion: accountEncryption.witness.version,
        modeMatches: accountEncryption.witness.mode === claim.accountCurrentness.mode,
        contentKeyMatches: accountEncryption.witness.contentKeyFingerprint === claim.accountCurrentness.contentKeyFingerprint,
      });
      return claim.definitionEnvelope === undefined
        ? { state: 'failed', reason: 'content_unavailable' }
        : refuseWorkflowTriggerAdmission('content_unavailable');
    }
    let resolvedAcceptedEnvelope = claim.acceptedEnvelope;
    // A freshly resolved Automation snapshot already carries the Run's key
    // projection; its checkpoint, result and root do not exist yet.
    let resolvedSnapshot: RunStorageSnapshot | undefined;
    let workspaceSource: import('@/workspaces/source/workspaceSource').WorkspaceSource | undefined;
    let postSummaryRequest: Readonly<{ enabled: boolean; occurrence: WorkflowPostSummaryEventOccurrence }> | undefined;
    // Admission happens once. A reclaim/Continue uses the same immutable
    // snapshot and recipient key custody as a direct Run, not the live source.
    if (claim.definitionEnvelope !== undefined && resolvedAcceptedEnvelope === undefined) {
      const refuse = (stage: string, reason: string, blockId?: string, ownerDetails?: unknown): WorkflowTriggerAdmissionRefusal => {
        const details = ownerDetails && typeof ownerDetails === 'object' && !Array.isArray(ownerDetails) ? asRecord(ownerDetails) : {};
        const nested = details.diagnostic && typeof details.diagnostic === 'object' && !Array.isArray(details.diagnostic)
          ? asRecord(details.diagnostic) : {};
        const platformReason = nested.platformReason ?? details.platformReason;
        const diagnostic = reason === 'target_unavailable'
          ? WorkflowTargetUnavailableDiagnosticV1Schema.safeParse({
            reason: nested.reason ?? details.reason,
            ...(platformReason === 'os' || platformReason === 'arch' ? { platformReason } : {}),
          }).data : undefined;
        logger.debug('[WORKFLOW] Trigger admission refused before initialization', {
          runId: claim.runId, automationId: claim.automationId, machineId: params.machineId,
          attempt: claim.attempt, stage, reason, ...(diagnostic === undefined ? {} : { diagnostic }),
        });
        return {
          ...refuseWorkflowTriggerAdmission(reason, blockId),
          ...(diagnostic === undefined ? {} : { targetUnavailableReason: diagnostic.reason }),
          ...(diagnostic?.platformReason === undefined ? {} : { targetUnavailablePlatformReason: diagnostic.platformReason }),
        };
      };
      const refuseSourceRead = (stage: string, error: unknown) => {
        claim.signal?.throwIfAborted();
        const thrown = error && typeof error === 'object' && !Array.isArray(error) ? asRecord(error) : {};
        const code = thrown.code;
        return refuse(stage, code === 'source_unavailable' || code === 'content_unavailable' || code === 'target_unavailable'
          ? code : 'source_unavailable', undefined, thrown.details);
      };
      if (!claim.automationId || !claim.automationCause) return refuse('claim', 'content_unavailable');
      let storedInput: unknown;
      try { storedInput = JSON.parse(claim.definitionEnvelope); } catch { storedInput = null; }
      const frozen = createStoredReadSchema(AutomationRunExecutionInputV1Schema).safeParse(storedInput);
      let definitionContent: unknown;
      if (frozen.success) {
        if (!sameStrictJsonValue(frozen.data.origin, toAutomationRunExecutionInputV1Origin(claim.automationCause))) {
          return refuse('definition_payload', 'content_unavailable');
        }
        // Unattended admission has Account custody only. In particular, a later
        // device Save cannot grant consent to open this Run's retained ciphertext.
        const opened = openAutomationTemplateStoredV1({ templateCiphertext: frozen.data.templateCiphertext,
          accountMode: accountEncryption.witness.mode,
          ...(isAvailableE2eeAutomationAccountEncryptionV1(accountEncryption)
            ? { material: accountEncryption.material.material } : {}),
        });
        if (!opened.ok) return refuse('definition_payload', 'content_unavailable');
        const session = frozen.data.targetType === 'existing_session' && opened.template.existingSessionId
          ? await params.execution.resolveExistingSessionConversation({ sessionId: opened.template.existingSessionId,
            machineId: params.machineId, ...(claim.signal ? { signal: claim.signal } : {}) }) : null;
        const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({
          legacyTemplate: { template: opened.template, targetType: frozen.data.targetType }, machineId: params.machineId,
          ...(session ? { session: { project: { machineId: session.machineId, directory: session.directory },
            executionSelection: { ...session.runtimeSelection, ...(session.agentTarget ? { agentTarget: session.agentTarget } : {}) } } } : {}),
        });
        if (converted.kind !== 'available') return refuse('legacy_source', 'source_unavailable');
        const { machineId: _machineId, ...workspace } = converted.project;
        definitionContent = { workspace, executionTarget: converted.executionTarget, inlineDefinition: converted.definition };
      } else {
        definitionContent = openAutomationStoredContent({ serialized: claim.definitionEnvelope,
          kind: 'automation_template_payload', encryption: accountEncryption });
      }
      // A frozen predecessor owns its exact source and has no mutable scope/ref.
      const scopeSessionId = frozen.success ? null : claim.scopeSessionId;
      // An admitted lifecycle occurrence owns its source independently of the habit's lifetime scope.
      const sourceSessionId = claim.automationCause.kind === 'trigger' && claim.automationCause.triggerKind === 'sessionLifecycle'
        ? claim.automationCause.evidence.sourceSessionId : undefined;
      const originSessionId = sourceSessionId ?? scopeSessionId ?? undefined;
      const storedDefinition = AutomationStoredWorkflowDefinitionV2ReadSchema.safeParse(definitionContent);
      const target = readTriggerTargetV1({ workflowDefinitionId: frozen.success ? null : claim.workflowDefinitionId,
        scopeSessionId }, definitionContent);
      if (!storedDefinition.success || target.kind !== 'available') return refuse('definition_payload', 'source_unavailable');
      const actionEvidence = claim.automationCause.kind === 'trigger' && claim.automationCause.triggerKind === 'action'
        ? claim.automationCause.evidence : undefined;
      const storedWorkspace = storedDefinition.data.workspace;
      const claimWorkspace: typeof storedDefinition.data.workspace = storedWorkspace ?? (
        target.target.kind === 'workflow' && !scopeSessionId && actionEvidence?.machineId === params.machineId
          ? { directory: '~' } : undefined
      );
      if (!claimWorkspace) return refuse('definition_payload', 'source_unavailable');
      const evidenceContent = claim.automationEvidenceEnvelope == null ? null
        : openAutomationStoredContent({ serialized: claim.automationEvidenceEnvelope,
          kind: 'automation_trigger_evidence', encryption: accountEncryption });
      const pluginEvent = claim.automationCause.kind === 'trigger' && claim.automationCause.triggerKind === 'pluginEvent'
        ? AutomationRunPluginEventTriggerEvidenceV1Schema.safeParse(evidenceContent) : undefined;
      const occurrence = pluginEvent?.success === false
        ? AutomationPluginEventOccurrenceEvidenceV1Schema.safeParse(evidenceContent) : pluginEvent;
      const matchedOccurrence = occurrence?.success && matchesCauseEvidence(claim.automationCause, occurrence.data)
        ? occurrence.data : undefined;
      const pluginEventOccurrence = matchedOccurrence
        ? { event: matchedOccurrence.eventRef, payload: matchedOccurrence.payload } : undefined;
      if (storedDefinition.data.postSummaryToSource === true && pluginEvent?.success && matchedOccurrence) {
        postSummaryRequest = {
          enabled: true,
          occurrence: {
            eventRef: pluginEvent.data.eventRef,
            sourceInstanceId: pluginEvent.data.sourceInstanceId,
            payload: pluginEvent.data.payload,
          },
        };
      }
      let source: WorkflowTriggerClaimSource | null;
      try {
        if (storedDefinition.data.deploymentPreview) {
          if (!params.resolveDeploymentPreviewWorkflow) return refuse('preview_source', 'source_unavailable');
          const preview = await params.resolveDeploymentPreviewWorkflow({
            templateRef: storedDefinition.data.deploymentPreview, evidence: evidenceContent,
            runId: claim.runId, ...(claim.signal ? { signal: claim.signal } : {}),
          });
          if (preview.kind !== 'available') {
            if (preview.kind === 'skipped') return { state: 'skipped', reason: preview.reason, admission: 'refused' };
            return refuse('preview_source', preview.reason);
          }
          source = { kind: 'inline', definition: preview.definition };
        } else {
          source = await resolveWorkflowTriggerClaimSource({
            target: target.target, credentials: params.execution.credentials, encryption: accountEncryption,
            ...(pluginEventOccurrence ? { event: pluginEventOccurrence.event } : {}),
            ...(claim.signal ? { signal: claim.signal } : {}),
          });
        }
      } catch (error) {
        return refuseSourceRead('source', error);
      }
      if (!source || claim.causeWorkDepth === undefined
        || !Number.isSafeInteger(claim.causeWorkDepth) || claim.causeWorkDepth < 0) {
        return refuse('source', 'source_unavailable');
      }
      const deploymentOccurrence = resolveDeploymentTriggerOccurrence({ cause: claim.automationCause,
        evidence: evidenceContent, triggers: storedDefinition.data.deploymentTriggers });
      if (deploymentOccurrence.kind === 'refused') return refuse('deployment_occurrence', deploymentOccurrence.code);
      if (deploymentOccurrence.kind === 'skipped') return { state: 'skipped', reason: 'filtered', admission: 'refused' };
      const prepareClaimWorkspace = async () => {
        let workspaceRefs: readonly import('@happier-dev/protocol').WorkspaceRefV1[] = [];
        if (claimWorkspace.workspaceRefId || claimWorkspace.sessionPlacement?.kind === 'in_place') {
          try {
            workspaceRefs = await params.resolveCurrentWorkspaceRefs?.(claim.signal) ?? [];
          } catch {
            claim.signal?.throwIfAborted();
            return { ok: false, code: 'workspace_unavailable' } as const;
          }
        }
        const workspaceServerId = params.execution.serverIdentityId ?? params.execution.serverId;
        return (params.prepareAcceptedWorkspaceTarget ?? prepareWorkflowAcceptedWorkspaceTarget)({
          projectTarget: { machineId: params.machineId, ...claimWorkspace },
          executionTargetKind: storedDefinition.data.executionTarget.kind,
          definition: source.definition,
          currentServerId: workspaceServerId,
          accountId: params.accountId,
          restoreManagedWorkspaceSource: params.restoreManagedWorkspaceSource,
          signal: claim.signal,
          resolveWorkspaceRef: (workspaceRefId) => resolveWorkspaceRefById(workspaceRefs, workspaceRefId, workspaceServerId),
        });
      };
      // The signed project may use a home alias. Fingerprint the same canonical
      // project that execution receives, without creating any Run-owned worktree.
      const fingerprintWorkspace = originSessionId && source.definition.inputs.some((input) => input.name === 'diffFingerprint')
        ? await prepareClaimWorkspace() : undefined;
      if (fingerprintWorkspace?.ok === false) return refuse('workspace', fingerprintWorkspace.code);
      const fingerprint = fingerprintWorkspace?.ok ? await (async () => {
        const read = () => readWorktreeChangeFingerprint(fingerprintWorkspace.workspaceTarget.project.directory);
        return fingerprintWorkspace.workspaceSource ? await runWithWorkspaceSourceDemand(fingerprintWorkspace.workspaceSource, read) : await read();
      })() : undefined;
      claim.signal?.throwIfAborted();
      const diffFingerprint = fingerprint?.kind === 'available' ? fingerprint.fingerprint : undefined;
      let inputs: ReturnType<typeof bindAutomationWorkflowInputs>;
      try {
        const occurrenceSeed = WorkflowResolvedInputsV1Schema.parse({ ...resolveAutomationWorkflowOccurrenceSeed({
          cause: claim.automationCause, openedEvidence: evidenceContent,
          ...(diffFingerprint === undefined ? {} : { diffFingerprint }),
        }), ...(deploymentOccurrence.kind === 'available' ? {
          sha: deploymentOccurrence.occurrence.sha, requestKey: deploymentOccurrence.occurrence.requestKey,
        } : {}) });
        inputs = bindAutomationWorkflowInputs({ definition: source.definition, evidence: occurrenceSeed,
          constants: storedDefinition.data.inputs });
      } catch (error) {
        return refuse('inputs', error instanceof WorkflowInputResolutionError ? error.code : 'content_unavailable');
      }
      const workspace = fingerprintWorkspace ?? await prepareClaimWorkspace();
      if (!workspace.ok) return refuse('workspace', workspace.code);
      workspaceSource = workspace.workspaceSource;
      if (!params.resolveMaterializationHost) return refuse('materialization_host', 'target_unavailable', undefined,
        { reason: 'materialization_owner_unavailable' });
      let reportPolicy: Awaited<ReturnType<typeof readRunReportPolicy>> | undefined;
      if (storedDefinition.data.onComplete?.kind === 'originating_session' && originSessionId) {
        try {
          reportPolicy = await readRunReportPolicy(claim.signal);
        } catch {
          claim.signal?.throwIfAborted();
          return refuse('report_policy', 'content_unavailable');
        }
      }
      let host: Awaited<ReturnType<NonNullable<typeof params.resolveMaterializationHost>>>;
      try {
        host = await params.resolveMaterializationHost({
          runId: claim.runId, workDepth: claim.causeWorkDepth,
          directory: workspace.workspaceTarget.project.directory,
          ...(originSessionId ? { originSessionId } : {}),
          ...(claim.signal ? { signal: claim.signal } : {}),
        });
      } catch (error) {
        // Host preparation only reads required admission sources here; no
        // accepted snapshot or execution exists yet. An unavailable inventory
        // must settle this occurrence rather than silently repeat on reclaim.
        return refuseSourceRead('materialization_host', error);
      }
      // Saved/plugin provenance wins. An inline Account Workflow uses the same name as its Library row.
      const automationDisplayName = storedDefinition.data.display?.name ?? claim.automationName;
      const automationTitle = automationDisplayName === undefined ? undefined : workflowTriggerDisplayNameV1({
        name: automationDisplayName,
        ...(source.kind === 'inline' ? { target: { kind: 'inline', definition: source.definition } as const } : {}),
      })?.trim();
      const runMetadata = (source.kind === 'inline' ? undefined : source.metadata)
        ?? (automationTitle ? { title: automationTitle } : undefined);
      let created: Awaited<ReturnType<typeof materializeWorkflowAcceptedSnapshotV1>>;
      const eventOccurrence = actionEvidence
        ? projectWorkflowActionTriggerEventOccurrenceV1(actionEvidence)
        : pluginEventOccurrence;
      try {
        created = await materializeWorkflowAcceptedSnapshotV1({
          definition: source.definition,
          ...host,
          roleOverrides: storedDefinition.data.roleOverrides,
          admission: { kind: 'trigger', workDepth: claim.causeWorkDepth, admitLeaf: host.admitLeaf,
            ...(eventOccurrence ? { eventOccurrence } : {}) },
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
            ...(runMetadata ? { metadata: runMetadata } : {}),
            // This Account owns the admitted trigger occurrence. Retain its
            // requester for contained approvals, independently of saved consent
            // or a Session persona, including later Resume of this snapshot.
            origin: { kind: 'direct', authenticatedStarterV1: {
              requestRef: claim.runId,
              requester: { serverId: params.execution.serverIdentityId ?? params.execution.serverId, accountId: params.accountId },
            },
              ...(originSessionId ? { originSessionId } : {}),
              ...(storedDefinition.data.approvalProfileId === undefined ? {} : { actionPolicy: {
                authority: 'account_automation', approvalProfileId: storedDefinition.data.approvalProfileId,
              } }),
            },
            ...(storedDefinition.data.onComplete?.kind === 'originating_session' && originSessionId ? {
              resultDelivery: { kind: 'originating_session', originSessionId, reportPolicy },
            } : {}),
          },
        });
      } catch (error) {
        // Nested definitions are still required source reads before acceptance.
        return refuseSourceRead('materialization', error);
      }
      if (!created.ok) return refuse('materialization', created.error.code, created.error.blockId, created.error);
      if (deploymentOccurrence.kind === 'available') {
        try {
          const controller = await params.resolveControllerContext({ runId: claim.runId, accepted: created.snapshot,
            ...(claim.signal ? { signal: claim.signal } : {}) });
          const context: ActionExecutorContext = { ...controller, executionRunTargetMachineId: params.machineId,
            externalActionTarget: { kind: 'machine', machineId: params.machineId }, ...(claim.signal ? { signal: claim.signal } : {}) };
          const decision = await admitDeploymentTriggerOccurrence({ occurrence: deploymentOccurrence.occurrence,
            snapshot: created.snapshot, machineId: params.machineId, executor: params.execution.detachedRun.actionExecutor, context });
          if (decision.kind === 'refused') return refuse('deployment_filter', decision.code);
          if (decision.kind === 'skipped') return { state: 'skipped', reason: 'filtered', admission: 'refused' };
        } catch (error) {
          return refuseSourceRead('deployment_filter', error);
        }
      }
      // Only a lifecycle event has a source turn that can feed back into itself.
      // A manual/scheduled scoped habit intentionally continues its destination.
      const selfTarget = sourceSessionId ? created.snapshot.materializedLeaves.find((leaf) => {
        if (leaf.selection.conversation?.kind !== 'existing_session' || leaf.selection.conversation.sessionId !== sourceSessionId) return false;
        // A declared source-context input preserves origin_session semantics.
        // An independently selected or literal existing Session still cannot
        // feed the lifecycle event back into its own source.
        return originSessionId !== sourceSessionId || leaf.sessionBindings?.defaultFrom !== 'origin_session'
          || !leaf.sessionBindings?.targets.some((target) => target.address.sessionId === sourceSessionId);
      }) : undefined;
      if (selfTarget) return refuse('self_target', 'self_target', selfTarget.blockId);
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
      const triggerCause = claim.automationCause;
      const approvedOperation = triggerCause.kind === 'trigger'
        ? readTriggerApprovedOperationForRun(storedDefinition.data.actionApprovals, triggerCause.triggerId, params.accountId)
        : undefined;
      if (approvedOperation) created = { ...created, snapshot: { ...created.snapshot, approvedOperation } };
      const { acceptedEnvelope: candidate, displayEnvelope } = sealWorkflowRunAcceptedEnvelopesV1({
        ...sealMode({ witness: accountEncryption.witness, runCrypto: prepared.runCrypto }),
        accountId: params.accountId, runId: claim.runId, acceptedSnapshot: created.snapshot,
      });
      const resolution = asRecord(await storage.execute({
        operation: 'accepted-snapshot.resolve',
        accountCurrentness: accountEncryption.witness,
        runId: claim.runId,
        automationId: claim.automationId,
        expectedAttempt: claim.attempt,
        expectedRevision: claim.expectedRevision,
        definitionEnvelope: claim.definitionEnvelope,
        acceptedEnvelope: candidate,
        displayEnvelope,
        sourceArtifactId,
        ...(created.snapshot.origin?.originSessionId ? { originSessionId: created.snapshot.origin.originSessionId } : {}),
        ...(created.snapshot.resultDelivery ? { resultDelivery: { kind: created.snapshot.resultDelivery.kind } } : {}),
        recipientKeyEnvelopes: prepared.recipientKeyEnvelopes,
        ...(census ? { visibleTeamId: census.visibleTeamId } : visibility),
      }, { ...(claim.signal ? { signal: claim.signal } : {}) }));
      if (typeof resolution.acceptedEnvelope !== 'string') throw new Error('workflow_storage_response_invalid');
      resolvedAcceptedEnvelope = resolution.acceptedEnvelope;
      if (resolution.disposition === 'created') {
        resolvedSnapshot = parseRunSnapshot({ run: resolution.run, acceptedEnvelope: resolution.acceptedEnvelope,
          checkpointEnvelope: null, resultEnvelope: null, keyCensus: resolution.keyCensus });
      }
    }
    const initial = resolvedSnapshot
      ?? parseRunSnapshot(await storage.execute({ operation: 'get', runId: claim.runId }, { ...(claim.signal ? { signal: claim.signal } : {}) }));
    const resolved = resolveWorkflowRunDataKeyV1({ encryption: accountEncryption, census: initial.keyCensus });
    if (resolved.kind !== 'available' || initial.keyCensus.ownerAccountId !== params.accountId) {
      logger.debug('[WORKFLOW] Run key unavailable before initialization', { runId: claim.runId, attempt: claim.attempt,
        stage: 'run_key', reason: resolved.kind === 'unavailable' ? resolved.reason : 'owner_mismatch' });
      if (resolved.kind === 'unavailable' && resolved.reason === 'waiting_for_keys'
        && initial.keyCensus.ownerAccountId === params.accountId && initial.run.state === 'claimed'
        && initial.checkpointEnvelope === null && initial.rootProgress == null) {
        return { state: 'failed', reason: resolved.reason, preInitializationFailure: true };
      }
      return { state: 'failed', reason: 'content_unavailable' };
    }
    const encryption = resolved.encryption;
    // Startup passes the census the claimed snapshot already carries, as the
    // Account owner does; the commit rechecks live access, the owner key and
    // recipient bindings. Later conversation materialization reads it afresh.
    const prepareRecipients = async (signal?: AbortSignal, census?: WorkflowRunRecipientCensusResponseV1) => await runWorkflowRecipientKeyPreparationV1({
      runId: claim.runId, runCrypto: encryption.runCrypto, openedDataEncryptionKey: initial.keyCensus.callerDataEncryptionKey,
      randomBytes: getRandomBytes,
      readCensus: async () => census ?? WorkflowRunRecipientCensusResponseV1Schema.parse(await storage.execute({ operation: 'run-key.census', runId: claim.runId }, signal ? { signal } : {})),
      commit: async input => WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema.parse(await storage.execute({ operation: 'run-key.commit', ...input }, signal ? { signal } : {})),
      ...(signal ? { signal } : {}),
    });
    if (resolvedAcceptedEnvelope !== undefined && initial.acceptedEnvelope !== resolvedAcceptedEnvelope) {
      logger.debug('[WORKFLOW] Accepted snapshot unavailable before initialization', {
        runId: claim.runId, attempt: claim.attempt, stage: 'accepted_snapshot', reason: 'envelope_mismatch' });
      return { state: 'failed', reason: 'content_unavailable' };
    }
    const acceptedEnvelope = parseWorkflowStoredContentEnvelopeV1(resolvedAcceptedEnvelope ?? initial.acceptedEnvelope);
    if (!acceptedEnvelope) {
      logger.debug('[WORKFLOW] Accepted snapshot unavailable before initialization', {
        runId: claim.runId, attempt: claim.attempt, stage: 'accepted_snapshot', reason: 'invalid_envelope' });
      return { state: 'failed', reason: 'content_unavailable' };
    }
    const openedAccepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...openMode(encryption),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: params.accountId, runId: claim.runId },
      envelope: acceptedEnvelope,
    });
    if (openedAccepted.kind !== 'available') {
      logger.debug('[WORKFLOW] Accepted snapshot unavailable before initialization', {
        runId: claim.runId, attempt: claim.attempt, stage: 'accepted_snapshot', reason: openedAccepted.kind });
      return { state: 'failed', reason: 'content_unavailable' };
    }
    const accepted = openedAccepted.content;
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

    // Delivering a result to the frozen origin Discussion is admitted work: it keeps the
    // Account-encryption witness and abort signal but never re-reads principal authority.
    const isPublicationEncryptionCurrent = async (signal?: AbortSignal): Promise<boolean> =>
      sameAutomationAccountContentIdentityV1((await params.resolveAccountEncryption(signal)).witness, accountEncryption.witness);

    const checkResumeSourceCurrentness = async (signal?: AbortSignal) => {
      try {
        // The Resume Action already compared its actual controller. Rebuilding
        // that controller from accepted.authorization would compare the Run
        // with itself. Key-free person controls still need this source check.
        return await isOpenedAuthorizationCurrent(signal) ? undefined : 'run_access_denied' as const;
      } catch (error) {
        signal?.throwIfAborted();
        const code = WorkflowOperationErrorCodeV1Schema.safeParse(error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined);
        if (!code.success) throw error;
        return code.data;
      }
    };
    let recoveryFailure: Awaited<ReturnType<typeof checkResumeSourceCurrentness>> | 'workspace_unavailable' = claim.workflowResumeRequestedRevision === undefined
      ? undefined
      : await checkResumeSourceCurrentness(claim.signal);

    const placement = accepted.workspaceTarget.sessionPlacement;
    if (!recoveryFailure && placement?.kind === 'in_place' && !workspaceSource) {
      workspaceSource = await selectManagedWorkflowWorkspaceSource({ workspace: placement.workspace,
        accountId: params.accountId, restore: params.restoreManagedWorkspaceSource, signal: claim.signal }) ?? undefined;
      if (!workspaceSource) recoveryFailure = 'workspace_unavailable';
    }
    const destinations = deriveWorkflowDestinationsV1({ definition: accepted.authoredDefinition, children: accepted.frozenChildren,
      materializedLeaves: accepted.materializedLeaves, originSessionId: accepted.origin?.originSessionId }).leaves;
    let checkpoint: WorkflowCheckpointEnvelopeV1;
    let rootRecordId: string;
    let revision = initial.run.revision;
    let createdRoot: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['createdRoot'];
    // A fresh start that will run at once prepares recipients first and opens
    // its root running, so no separate running transition follows.
    const startsOnInitialize = initial.checkpointEnvelope === null && !recoveryFailure;
    if (startsOnInitialize) await prepareRecipients(claim.signal, initial.keyCensus);
    if (initial.checkpointEnvelope === null) {
      rootRecordId = randomUUID();
      checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({
        kind: 'happier.workflow-checkpoint.v1', rootRecordId, nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false },
      });
      const rootProgress = WorkflowProgressEnvelopeV1Schema.parse({
        stepProgress: { completed: 0, skipped: 0, total: countWorkflowStepsV1(accepted.authoredDefinition.blocks), destinations },
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootRecordId,
      });
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId }, checkpoint,
      }));
      const publication = prepareWorkflowDestinationPublicationV1({
        ...sealMode(encryption), accountId: params.accountId, runId: claim.runId, progress: rootProgress,
      });
      const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...sealMode(encryption),
        binding: { v: 1, purpose: 'invocation_progress', accountId: params.accountId, runId: claim.runId,
          recordId: rootRecordId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: publication.progress,
      }));
      const initialized = asRecord(await storage.execute({ operation: 'initialize', runId: claim.runId,
        parentAttempt: claim.attempt, accountCurrentness: encryption.witness,
        expectedRevision: revision, checkpointEnvelope,
        rootInvocation: { id: rootRecordId, contentEnvelope: rootEnvelope, destinationWrites: publication.destinationWrites },
        ...(startsOnInitialize ? { rootLifecycle: 'running' } : {}) }));
      const run = WorkflowRunSummaryV1Schema.parse(initialized.run);
      revision = run.revision;
      const root = initialized.initialization === 'created' && initialized.rootInvocation !== undefined
        ? asRecord(initialized.rootInvocation) : undefined;
      if (root) createdRoot = { index: root.index, contentEnvelope: root.contentEnvelope, parentRevision: revision,
        destinationEnvelopes: publication.destinationWrites.map(write => write.contentEnvelope) };
    } else {
      const envelope = parseWorkflowStoredContentEnvelopeV1(initial.checkpointEnvelope);
      const opened = openWorkflowCheckpointStoredEnvelopeV1({
        ...openMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId }, envelope,
      });
      if (opened.kind !== 'available') return { state: 'failed', reason: 'content_unavailable' };
      checkpoint = opened.content;
      rootRecordId = checkpoint.rootRecordId;
    }

    if (!recoveryFailure && checkpoint.frontier.paused) {
      checkpoint = { ...checkpoint, frontier: { ...checkpoint.frontier, paused: false } };
    }
    const durableStore = await DurableWorkflowCoordinatorStore.load({
      accountId: params.accountId, runId: claim.runId, parentAttempt: claim.attempt, machineId: params.machineId,
      storage, encryption, rootRecordId, checkpoint, revision,
      authoredDefinition: accepted.authoredDefinition,
      definition: accepted.definition,
      frozenChildren: accepted.frozenChildren,
      discussionRound: readWorkflowDiscussionRoundBindingV1(accepted),
      ...(createdRoot ? { createdRoot } : {}),
      destinations,
    });
    await durableStore.refreshStepProgress();
    const rootAtStart = durableStore.rootIndex;
    if (!rootAtStart) throw new Error('workflow_root_invocation_missing');
    rootRecordId = rootAtStart.id;
    let discussionPublicationPending = false;
    if (recoveryFailure) {
      const root = await durableStore.readByLogicalInvocation(rootRecordId);
      if (!root) throw new Error('workflow_root_invocation_missing');
      await durableStore.commitFact({ key: root.key, lifecycle: root.lifecycle,
        reason: recoveryFailure, reasonMessage: recoveryFailure === 'workspace_unavailable'
          ? 'The retained workspace is unavailable'
          : `Couldn't resume: ${recoveryFailure}` });
      const active = await durableStore.listByLifecycle({ runId: claim.runId,
        lifecycles: ['admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain'] });
      const hasInputCustody = active.some(row => (row.blockKind === 'step' || row.blockKind === 'action')
        && (row.execution !== undefined || row.lifecycle === 'admitting' || row.lifecycle === 'cancel_requested' || row.lifecycle === 'outcome_uncertain'));
      const control = await durableStore.readControl();
      const state = control === 'cancel_requested' ? 'cancelled' : hasInputCustody ? 'interrupted' : 'paused';
      // A denied resumed boundary owns no input. Reclaimed active custody must
      // remain recoverable rather than being mislabeled a quiescent pause.
      if (state !== 'paused') return await settleCoordinatorResult({ state, reason: recoveryFailure });
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId },
        checkpoint: { ...durableStore.checkpoint, frontier: { ...durableStore.checkpoint.frontier, paused: state === 'paused' } },
      }));
      await storage.execute({ operation: 'transition', runId: claim.runId, parentAttempt: claim.attempt,
        accountCurrentness: encryption.witness, expectedRevision: durableStore.revision, state, checkpointEnvelope });
      return { state, reason: recoveryFailure };
    }
    if (!startsOnInitialize) await prepareRecipients(claim.signal, initial.keyCensus);
    if (!startsOnInitialize && (rootAtStart.lifecycle === 'pending' || initial.run.state === 'claimed')) {
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
        ...sealMode(encryption), binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: claim.runId },
        checkpoint: durableStore.checkpoint,
      }));
      const started = WorkflowRunSummaryV1Schema.parse(await storage.execute({
        operation: 'transition', runId: claim.runId, parentAttempt: claim.attempt,
        accountCurrentness: encryption.witness,
        expectedRevision: durableStore.revision,
        state: 'running', checkpointEnvelope,
        ...(rootAtStart.lifecycle === 'pending' ? {
          invocationTransitions: [{ id: rootAtStart.id, expectedLifecycle: 'pending', expectedContentRevision: rootAtStart.contentRevision, lifecycle: 'running' }],
        } : {}),
      }));
      durableStore.applyParentTransition(started, rootAtStart.lifecycle === 'pending' ? 'running' : rootAtStart.lifecycle);
    }
    const resolveSharedSessionConversation = async ({ conversationBinding }: Readonly<{ conversationBinding?: WorkflowConversationBinding }>) => {
      const record = await durableStore.resolveSharedInvocation(conversationBinding);
      return (record?.execution?.kind === 'session' || record?.execution?.kind === 'session_ready') && record.workspace?.descriptor
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
      return (record?.execution?.kind === 'session' || record?.execution?.kind === 'session_ready') && record.workspace?.descriptor
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
      ...(accepted.workspaceTarget.sessionPlacement ? { sessionPlacement: accepted.workspaceTarget.sessionPlacement } : {}),
      ...(accepted.workspaceTarget.projectFiles ? { projectFiles: accepted.workspaceTarget.projectFiles } : {}),
      ...(accepted.origin?.originSessionId ? { originSessionId: accepted.origin.originSessionId } : {}),
      ...(accepted.origin?.discussion ? { discussionOrigin: accepted.origin.discussion } : {}),
      machineAdmissionTransport: params.execution.machineAdmissionTransport,
      visibleTeamId: initial.keyCensus.visibleTeamId,
      ...(params.execution.action ? { action: params.execution.action } : {}),
      ...(params.execution.sessionStartup ? { sessionStartup: params.execution.sessionStartup } : {}),
    });
    const resolveFrozenRole = (executionParams: Pick<Parameters<WorkflowStepExecutor>[0], 'role'>) => executionParams.role;
    const conversations = createProductionWorkflowConversationOwner({
      credentials: params.execution.credentials,
      serverId: params.execution.serverId,
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
      buildActionContext: async (executionParams) => {
        const role = resolveFrozenRole(executionParams);
        const context = await params.execution.detachedRun.buildActionContext(executionParams);
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
    if (rootInvocation.reason !== undefined
      && rootInvocation.reason !== WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1
      && (rootInvocation.lifecycle === 'running' || rootInvocation.lifecycle === 'needs_attention')) {
      await durableStore.commitFact({ key: rootInvocation.key, lifecycle: 'running' });
    }
    // A refused/aborted publication stays unresolved until the enclosing Run
    // settles it. Only the final successful approval can release this attention.
    let unresolvedPublicationApprovals = 0;
    const reconcilePublicationAttention = () => durableStore.reconcilePublicationApprovalAttention(() => unresolvedPublicationApprovals > 0);
    const publishDiscussionResult = accepted.resultDelivery?.kind === 'originating_discussion'
      ? createWorkflowDiscussionResultPublisher({
        credentials: params.execution.credentials, origin: accepted.resultDelivery,
        isCurrent: isPublicationEncryptionCurrent,
        findApproval: async (publication, signal) => {
          if (!('kind' in publication) || !params.execution.serverIdentityId) return undefined;
          const retained = await createCliApprovalsArtifactStore({ credentials: params.execution.credentials,
            serverId: params.execution.serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl() }).findWorkflowDiscussionReplyApproval({
            serverIdentityId: params.execution.serverIdentityId, accountId: params.accountId, machineId: params.machineId,
            producer: publication.producer, origin: publication.discussion, authorization: accepted.authorization,
          }, { signal });
          return retained ? { kind: 'approval', artifactId: retained.artifactId } : undefined;
        },
        ...(params.execution.action?.observeApproval ? { observeApproval: async ({ artifactId, publication, signal }) => {
          signal?.throwIfAborted();
          unresolvedPublicationApprovals++;
          await reconcilePublicationAttention();
          const observed = await params.execution.action!.observeApproval!({ artifactId, actionId: 'discussion.reply',
            actionRequestId: 'kind' in publication ? deriveWorkflowDiscussionReplyLocalIdV1(publication.workflow)
              : deriveSessionMessageReplyReturnLocalIdV1({ sessionId: publication.requestSessionId,
                localId: publication.requestLocalId, acceptedTurnId: publication.acceptedTurnId }),
            authorization: accepted.authorization, signal: signal ?? claim.signal ?? new AbortController().signal });
          signal?.throwIfAborted();
          if (observed.ok) {
            unresolvedPublicationApprovals--;
            await reconcilePublicationAttention();
          }
          return observed;
        } } : {}),
        // Every newly claimed coordinator may retry retained transient return
        // custody. Equal control hints do not create a claim or a retry loop.
        retryFailedPublications: true,
        publish: createDiscussionReplyReturnPublisher({ credentials: params.execution.credentials,
          machineId: params.machineId, serverId: params.execution.serverId,
          workflowActionContext: buildWorkflowActionContext({ ...accepted, runId: claim.runId }, params.requesterWorkAttributionV1),
          serverHttpBaseUrl: resolveServerHttpBaseUrl(), signal: claim.signal ?? new AbortController().signal,
          ...(params.execution.postWorkflowMessage ? { postWorkflowMessage: params.execution.postWorkflowMessage } : {}),
          isCurrent: isPublicationEncryptionCurrent }),
        ...(claim.signal ? { signal: claim.signal } : {}),
      }) : null;
    const coordinator = createWorkflowCoordinator({
      store: durableStore,
      ...(params.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: params.requesterWorkAttributionV1 } : {}),
      ...(params.waitForNewWorkAdmission ? { waitForNewWorkAdmission: params.waitForNewWorkAdmission } : {}),
      ...(params.execution.action ? { action: params.execution.action } : {}),
      onReviewEntered: async ({ runId }) => await onReviewEntered({ runId }),
      ...(accepted.resultDelivery?.kind === 'originating_discussion' ? { resolveDiscussionReplyParent: async ({ runId, invocation }) => {
        const destination = accepted.resultDelivery!;
        if (destination.kind !== 'originating_discussion') throw new WorkflowDiscussionPublicationUnavailable();
        const discussionAction = createDiscussionActionDeps({ credentials: params.execution.credentials,
          serverId: params.execution.serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl() }).discussionAction!;
        return await resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion: destination.discussion,
          addressingMessageId: destination.messageId }, context: { serverId: params.execution.serverId,
          surface: 'cli', authority: 'account_automation', ...(claim.signal ? { signal: claim.signal } : {}) },
          discussionAction, replyTo: { credentials: params.execution.credentials, runId, invocation,
            ...(params.execution.serverIdentityId ? { serverIdentityId: params.execution.serverIdentityId } : {}) } });
      } } : {}),
      ...(publishDiscussionResult ? { onInvocationSettled: publishDiscussionResult } : {}),
      sessionContext: { ...createProductionWorkflowSessionContextReader({
        credentials: params.execution.credentials,
        machineId: params.machineId,
        originSessionId: accepted.origin?.originSessionId,
        ...(claim.signal ? { signal: claim.signal } : {}),
      }), ...(accepted.origin?.discussion ? createProductionWorkflowDiscussionContextReader({
        credentials: params.execution.credentials,
        serverId: params.execution.serverId,
        serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        origin: accepted.origin?.discussion,
        ...(params.execution.serverIdentityId ? { serverIdentityId: params.execution.serverIdentityId } : {}),
        ...(claim.signal ? { signal: claim.signal } : {}),
      }) : {}) },
      rootInvocationRecordId: rootInvocation.recordId,
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
              : executionParams.participant?.kind === 'model' && executionParams.participant.launch.directory.kind === 'path'
                && (!executionParams.execution.workspace || executionParams.execution.workspace.kind === 'inherit')
                ? { conversationWorkspace: {
                    machineId: executionParams.participant.launch.executionTarget.machineId,
                    directory: executionParams.participant.launch.directory.path,
                  } }
              : {}),
          };
        } catch (error) {
          if (error instanceof WorkflowSessionCompositionError) {
            return { failure: { kind: 'failed', code: error.code,
              ...(error.details ? { reasonDetails: error.details } : {}) } };
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
          materializeReview: async input => {
            const context = await detachedRunDeps.buildActionContext({ ...input.params, workDepth: accepted.workDepth });
            const services = await params.execution.detachedRun.actionExecutor.resolveReviewServices?.(context);
            if (!services?.comments) return { kind: 'failed', code: 'review_comment_persistence_unavailable' };
            const owner = await resolveWorkflowAuthorizedSession({ credentials: params.execution.credentials,
              sessionId: input.sessionId, machineId: input.params.workspace.machineId,
              ...(context.signal ? { signal: context.signal } : {}) });
            if (!owner) return { kind: 'failed', code: 'review_comment_session_unavailable' };
            const agentId = resolveAgentIdFromSessionMetadata(owner.metadata);
            if (!agentId) return { kind: 'failed', code: 'review_engine_unavailable' };
            return await materializeWorkflowSessionReview({ ...input, context, comments: services.comments,
              workspace: { machineId: owner.machineId, path: input.params.workspace.directory }, agentId,
              serverId: params.execution.serverIdentityId ?? params.execution.serverId });
          },
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
        ...(workspaceSource ? { workspaceSource } : {}),
        ...(accepted.workspaceTarget.originalCommittedRevision
          ? { originalCommittedRevision: accepted.workspaceTarget.originalCommittedRevision }
          : {}),
        ...(params.workspaceScm ? { scm: params.workspaceScm } : {}),
      }),
    });
    claim.registerReviewHoldRefresh?.(coordinator.refreshReviewHolds);
    const runCoordinator = async () => {
      logger.infoFile('[WORKFLOW] Run phase', { event: 'workflow_run_phase', runId: claim.runId,
        phase: 'coordinator_dispatch', timestamp: new Date().toISOString() });
      const releaseActivity = claim.registerLiveWorkProducer?.(coordinator.liveWorkProducer);
      try {
        return await coordinator.run({ runId: claim.runId, definition: accepted.definition, inputs,
          ...(accepted.triggerEventValues ? { triggerEventValues: accepted.triggerEventValues } : {}),
          authoredDefinition: accepted.authoredDefinition,
          executionTarget: accepted.executionTarget,
          materializedLeaves: accepted.materializedLeaves,
          frozenChildren: accepted.frozenChildren,
          workDepth: accepted.workDepth,
          authorization: accepted.authorization,
          source: accepted.source,
          ...(accepted.origin ? { origin: accepted.origin } : {}),
          ...(initial.run.origin.kind === 'automation' && initial.run.origin.cause
            ? { automationCause: initial.run.origin.cause } : {}),
          ...(accepted.origin?.originSessionId ? { originSessionId: accepted.origin.originSessionId } : {}),
          ...(claim.signal ? { signal: claim.signal } : {}) });
      } catch (error) {
        if (claim.signal?.aborted) throw error;
        const publicationUnavailable = error instanceof WorkflowDiscussionPublicationUnavailable;
        const storageFailure = readWorkflowRunStorageFailure(error);
        if (!publicationUnavailable && storageFailure === null) throw error;
        if (publicationUnavailable) {
          discussionPublicationPending = !error.terminal;
          // An Ask or unavailable append retains publication custody, not an
          // executable claim. Never replace Cancel with publication attention
          // or reopen an already-cancelled root on every lease reclaim.
          if (await durableStore.readControl() === 'cancel_requested') {
            return { state: 'cancelled' } satisfies WorkflowCoordinatorResult;
          }
        }
        // Preserve every admitted identity and completed result. Known
        // publication refusal needs visible attention; a storage 5xx can follow
        // a committed write. Neither permits a terminal effect reinterpretation.
        // If storage is still unavailable, this write also fails and the
        // incumbent lease-reclaim owner remains responsible for recovery.
        const root = await durableStore.readByLogicalInvocation(rootRecordId);
        if (!root) throw error;
        const terminalPublicationFailure = publicationUnavailable && error.terminal;
        const reason = publicationUnavailable && error.pending ? 'approval_required'
          : publicationUnavailable && error.failure ? error.failure.code
          : publicationUnavailable ? 'workflow_discussion_publication_unavailable' : 'storage_unavailable';
        try {
          await durableStore.commitFact({ key: root.key, lifecycle: terminalPublicationFailure ? 'failed' : 'needs_attention',
            reason,
            ...(storageFailure ? { failureCause: storageFailure.failureCause } : {}),
            reasonMessage: terminalPublicationFailure
              ? 'The accepted result is saved, but its Discussion return was refused. The native execution result is unchanged.'
              : publicationUnavailable && error.pending
              ? 'The accepted result is saved privately for Discussion publication. Resolve its approval request, then resume the run.'
              : publicationUnavailable
              ? 'The accepted result is saved, but Discussion publication is unavailable. Restore access or resolve the publication request, then resume the run.'
              : storageFailure!.message });
        } catch (error) {
          if (error instanceof WorkflowControlBoundary && error.state === 'cancelled') {
            return { state: 'cancelled' } satisfies WorkflowCoordinatorResult;
          }
          throw error;
        }
        return { state: terminalPublicationFailure ? 'failed' : 'interrupted', reason } satisfies WorkflowCoordinatorResult;
      }
      finally { releaseActivity?.(); }
    };
    if (workflowRequiresMachineStartCapacityV1(accepted.materializedLeaves, accepted, claim.automationCause)) {
      await claim.acquireMachineStartCapacity?.(claim.signal, async () => {
        if (rootInvocation.reason === WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1) return;
        await durableStore.commitFact({ key: rootInvocation.key, lifecycle: 'running',
          reason: WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1 });
      });
    }
    claim.signal?.throwIfAborted();
    if (durableStore.read(rootInvocation.key)?.reason === WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1) {
      await durableStore.commitFact({ key: rootInvocation.key, lifecycle: 'running' });
      claim.signal?.throwIfAborted();
    }
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
    return await settleCoordinatorResult(result);

    async function settleCoordinatorResult(result: WorkflowCoordinatorResult): Promise<WorkflowCoordinatorResult> {
      const cancelledResult: WorkflowCoordinatorResult = { state: 'cancelled',
        ...(recoveryFailure ? { reason: recoveryFailure } : {}) };
      // Cancellation is the terminal authority even when it races the last
      // admitted leaf. A pause that arrives after all authored work completed is
      // intentionally allowed to settle that completed work normally.
      const control = await durableStore.readControl();
      if (control === 'cancel_requested') {
        const pendingStops = await durableStore.listByLifecycle({
          runId: claim.runId,
          lifecycles: ['cancel_requested', 'outcome_uncertain'],
        });
        for (const record of pendingStops) {
          if (record.recordId === durableStore.rootIndex?.id) continue;
          if (record.lifecycle === 'cancel_requested' && record.blockKind !== 'step' && record.blockKind !== 'action') {
            // Drained containers and cap-blocked frames have no physical input
            // to stop. Close the same durable row rather than retaining them as
            // child custody after the coordinator has unwound every pipeline.
            await durableStore.commitFact({ key: record.key, lifecycle: 'cancelled' });
          }
        }
        // Cancellation ends authored work, not unresolved child custody. Retain
        // pending custody for the terminal recovery owner instead of leaving the
        // parent claimable and replaying this same cancellation indefinitely.
        result = cancelledResult;
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
      // Home's terminal transition owns the unsettled-custody check: the root
      // closes in it, and independent accepted inputs or review holds keep
      // custody pending for the existing terminal recovery path.
      const settleCustodyWhenClear = !discussionPublicationPending
        && projectWorkflowTerminalCustodySettlement(result.state) === 'settled';
      if (result.state === 'failed' || result.state === 'cancelled'
        || result.state === 'interrupted' || result.state === 'outcome_uncertain') {
        const originalRound = ReviewRoundBindingV1Schema.safeParse(accepted.inputs.reviewRound);
        const preparesRound = accepted.materializedLeaves.some(leaf => leaf.kind === 'action' && leaf.actionId === 'review.prepare_round');
        if (originalRound.success || preparesRound) {
          const invocations = await durableStore.listByLifecycle({ runId: claim.runId, lifecycles: WORKFLOW_INVOCATION_LIFECYCLES_V1 });
          let binding = originalRound.success ? originalRound.data : undefined;
          let preparedSequence = -1n;
          const preparedRoundSchema = createStoredReadSchema(ReviewPreparedRoundV1Schema);
          for (const invocation of invocations) {
            if (invocation.lifecycle !== 'completed' || invocation.execution?.kind !== 'action'
              || invocation.execution.actionId !== 'review.prepare_round') continue;
            const prepared = preparedRoundSchema.safeParse(invocation.result);
            const sequence = BigInt(invocation.sequence ?? '0');
            if (prepared.success && sequence > preparedSequence) {
              binding = prepared.data.reviewRound;
              preparedSequence = sequence;
            }
          }
          if (binding) {
            const context = buildWorkflowActionContext({ ...accepted, runId: claim.runId }, params.requesterWorkAttributionV1);
            const services = await params.execution.detachedRun.actionExecutor.resolveReviewServices?.(context);
            if (!services?.records) throw Object.assign(new Error('review_record_unavailable'), { code: 'review_record_unavailable' });
            const runs: ReviewRunReferenceV1[] = [{ kind: 'workflow', runId: claim.runId }];
            const nativeRuns = new Set<string>();
            for (const invocation of invocations) {
              const execution = invocation.execution;
              const machineId = invocation.workspace?.descriptor?.machineId;
              if (!machineId || !execution) continue;
              const actual = execution.kind === 'detached_run' ? [{ runId: execution.runId }]
                : execution.kind === 'action' && execution.actionId === 'review.start' ? execution.awaitedRuns ?? [] : [];
              for (const run of actual) {
                if (nativeRuns.has(run.runId)) continue;
                nativeRuns.add(run.runId);
                runs.push({ kind: 'execution', runId: run.runId, machineId });
              }
            }
            // Settle before releasing the Workflow's existing custody so an
            // Artifact failure stays recoverable. A later Cancel can change
            // the Workflow label; it cannot reopen the settled Review round.
            await services.records.settle({ ...binding, outcome: result.state === 'cancelled' ? 'cancelled' : 'failed',
              reviewerOutcomes: collectWorkflowReviewRoundOutcomes(binding, invocations), finishedAt: Date.now(), runs });
          }
        }
      }
      const transition = {
        operation: 'transition', runId: claim.runId, parentAttempt: claim.attempt,
        accountCurrentness: encryption.witness,
        expectedRevision: durableStore.revision,
        state: terminalState, checkpointEnvelope,
        ...((terminalState === 'failed' || terminalState === 'interrupted') && result.reason ? { errorCode: result.reason } : {}),
        discussionRound: await durableStore.readDiscussionRoundProgress(),
        ...(resultEnvelope ? { resultEnvelope } : {}),
        ...(settleCustodyWhenClear ? { settleCustodyWhenClear: true } : {}),
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
          result = cancelledResult;
          terminalState = 'cancelled';
          rootTerminal = 'cancelled';
          committed = snapshot.run;
        } else {
          const persistedRoot = await durableStore.refreshRootIndex();
          // A conditional settlement commits either custody state Home chose.
          const custodyMatches = settleCustodyWhenClear || snapshot.run.workflowCustodyState === 'pending';
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
      if (terminalState === 'succeeded' && postSummaryRequest?.enabled) {
        try {
          const context = buildWorkflowActionContext({ ...accepted, runId: claim.runId }, params.requesterWorkAttributionV1);
          const outcome = await postWorkflowRunSummaryToAuthorizedSource({
            enabled: true,
            occurrence: postSummaryRequest.occurrence,
            finalResult: result.finalResult,
            actionExecutor: params.execution.detachedRun.actionExecutor,
            context: { ...context, ...(claim.signal ? { signal: claim.signal } : {}) },
          });
          if (outcome.kind === 'failed') {
            logger.warnLocalFile('[WORKFLOW] Post summary to source failed', {
              runId: claim.runId, code: outcome.code,
            });
          }
        } catch (error) {
          if (!claim.signal?.aborted) {
            logger.warnLocalFile('[WORKFLOW] Post summary to source threw', {
              runId: claim.runId, error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      await params.onCommittedTransition?.({ run: committed, result });
      return result;
    }
  };
}
