import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { WorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { WorkflowRunSummaryV1Schema, WorkflowRunInvocationIndexV1Schema,
  type WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowInvocationBindingRowV1 } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1, type WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import type { StoredCredentials } from '@/persistence';
import { createAutomationAccountEncryptionMaterialSnapshotV1,
  resolveValidatedAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { readObservedAccountEncryptionCurrentnessWitness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { readRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionContext';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

export type WorkflowActionAdmissionReaderParams = Readonly<{
  storage: Pick<ReturnType<typeof createWorkflowRunStorageClient>, 'execute'>;
  resolveEncryption: (context: ActionExecutorContext) => Promise<WorkflowRunReadEncryptionV1 | null>;
}>;

export type WorkflowActionAdmission = Readonly<{
  run: WorkflowRunSummaryV1;
  accepted: WorkflowAcceptedSnapshotV1;
  logicalInvocationId: string;
  attempt: string;
  openInvocation(value: unknown): WorkflowInvocationBindingRowV1 | undefined;
  readInvocation(id: string): Promise<WorkflowInvocationBindingRowV1 | undefined>;
  readActionInvocation(phase: 'prepare' | 'dispatch' | 'approval_replay'): Promise<WorkflowInvocationBindingRowV1 | undefined>;
}>;

/** Credentialed ingress and approval replay share the Account mode/material owner. */
export function createCredentialedWorkflowActionAdmissionReader(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
}>): ReturnType<typeof createWorkflowActionAdmissionReader> {
  return createWorkflowActionAdmissionReader({
    storage: createWorkflowRunStorageClient({ token: params.credentials.token, serverHttpBaseUrl: params.serverHttpBaseUrl }),
    resolveEncryption: createCredentialedWorkflowRunEncryptionResolver(params),
  });
}

/** Crypto for the existing Run-bound reader, never an API root's content fallback. */
export function createCredentialedWorkflowRunEncryptionResolver(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
}>): WorkflowActionAdmissionReaderParams['resolveEncryption'] {
  return async context => {
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    const signal = context.signal ?? new AbortController().signal;
    const resolved = await resolveValidatedAutomationAccountEncryptionV1({ signal,
      resolveAccountEncryptionCurrentness: async currentnessSignal => requester?.accountEncryptionCurrentness
        ?? readObservedAccountEncryptionCurrentnessWitness({ token: params.credentials.token,
          serverBaseUrl: params.serverHttpBaseUrl, signal: currentnessSignal })
        ?? fetchAccountEncryptionCurrentness({ token: params.credentials.token, credentials: params.credentials,
          serverBaseUrl: params.serverHttpBaseUrl, signal: currentnessSignal }),
      resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials),
    });
    return resolved.kind === 'available' ? resolved : null;
  };
}

/** One exact accepted Run and its sealed invocation rows, shared by policy and reviewed consent. */
export function createWorkflowActionAdmissionReader(params: WorkflowActionAdmissionReaderParams):
  (request: Readonly<{ runId: string; context: ActionExecutorContext; phase?: 'approval_replay' }>) => Promise<WorkflowActionAdmission | null> {
  return async ({ runId, context, phase }) => {
    const requestId = context.actionRequestId;
    const externalOrigin = context.externalActionExecutionAuthorization?.binding.workflowActionOrigin;
    const externalRun = externalOrigin?.runId === runId && externalOrigin.requestId === requestId;
    const localCaller = context.actionCaller;
    const localRun = localCaller?.kind === 'workflowRun' && localCaller.runId === runId
      && context.executionRunWorkflowRunId === runId;
    // Local replay retains the signed Run-start root, checked against the accepted snapshot below.
    if (phase === 'approval_replay' && !externalRun
      && (!localRun || !context.externalActionExecutionAuthorization)) return null;
    if (!requestId || !(externalRun
      || localRun)) return null;
    if (!requestId.startsWith(`${runId}/`)) return null;
    const identity = requestId.slice(runId.length + 1);
    const separator = identity.lastIndexOf('/');
    const logicalInvocationId = identity.slice(0, separator);
    const attempt = identity.slice(separator + 1);
    if (separator <= 0 || !/^(0|[1-9][0-9]*)$/.test(attempt)) return null;
    context.signal?.throwIfAborted();
    const options = context.signal ? { signal: context.signal } : {};
    const stored = record(await params.storage.execute({ operation: 'get', runId }, options));
    const run = WorkflowRunSummaryV1Schema.safeParse(stored.run);
    const census = WorkflowRunRecipientCensusResponseV1Schema.safeParse(stored.keyCensus);
    if (!run.success || run.data.id !== runId
      || !(run.data.state === 'claimed' || run.data.state === 'running' || phase === 'approval_replay' && run.data.state === 'paused')
      || run.data.workflowCustodyState !== 'pending' || !census.success || census.data.runId !== runId
      || census.data.ownerAccountId !== run.data.ownerAccountId || typeof stored.acceptedEnvelope !== 'string') return null;
    const material = await params.resolveEncryption(context);
    if (!material) return null;
    const key = resolveWorkflowRunDataKeyV1({ encryption: material, census: census.data });
    if (key.kind !== 'available') return null;
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...key.encryption.runCrypto,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: census.data.ownerAccountId, runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(stored.acceptedEnvelope) });
    if (opened.kind !== 'available') return null;
    if (!externalRun && context.externalActionExecutionAuthorization
      && (!localRun || !sameStrictJsonValue(opened.content.authorization.externalActionExecutionAuthorization,
        { v: context.externalActionExecutionAuthorization.v, token: context.externalActionExecutionAuthorization.token,
          binding: context.externalActionExecutionAuthorization.binding }))) return null;
    const openInvocation = (value: unknown): WorkflowInvocationBindingRowV1 | undefined => {
      const detail = record(value);
      const index = WorkflowRunInvocationIndexV1Schema.safeParse(detail.index);
      if (!index.success || index.data.runId !== runId || typeof detail.contentEnvelope !== 'string') return undefined;
      const row = index.data;
      const progress = openWorkflowProgressStoredEnvelopeV1({ ...key.encryption.runCrypto,
        binding: { v: 1, purpose: 'invocation_progress', accountId: census.data.ownerAccountId, runId,
          recordId: row.id, sequence: row.sequence, parentRecordId: row.parentRecordId,
          memberOrdinal: row.memberOrdinal, attempt: row.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(detail.contentEnvelope) });
      return progress.kind === 'available' && progress.content.attempt === row.attempt
        ? { index: row, progress: progress.content } : undefined;
    };
    const readInvocation = async (id: string) => {
      const row = openInvocation(record(await params.storage.execute({ operation: 'invocations.get', runId,
        invocationId: id }, options)).invocation);
      return row?.index.id === id ? row : undefined;
    };
    const readActionInvocation = async (invocationPhase: 'prepare' | 'dispatch' | 'approval_replay') => {
      if ((invocationPhase === 'approval_replay') !== (phase === 'approval_replay')) return undefined;
      let detail = record(record(await params.storage.execute({ operation: 'invocations.get', runId,
        invocationId: logicalInvocationId }, options)).invocation);
      let index = WorkflowRunInvocationIndexV1Schema.safeParse(detail.index);
      // Recovery keeps the logical request while the slot owner selects its physical attempt.
      if (index.success && index.data.attempt !== attempt && index.data.parentRecordId) {
        detail = record(record(await params.storage.execute({ operation: 'invocations.current', runId,
          parentRecordId: index.data.parentRecordId, memberOrdinal: index.data.memberOrdinal }, options)).invocation);
        index = WorkflowRunInvocationIndexV1Schema.safeParse(detail.index);
      }
      if (!index.success || index.data.runId !== runId || index.data.attempt !== attempt
        || !(invocationPhase === 'approval_replay' ? index.data.lifecycle === 'waiting_for_approval'
          : index.data.lifecycle === 'admitting' || invocationPhase === 'prepare' && index.data.lifecycle === 'pending')) return undefined;
      const row = openInvocation(detail);
      return row?.progress.logicalInvocationRecordId === logicalInvocationId && row.progress.blockKind === 'action' ? row : undefined;
    };
    return { run: run.data, accepted: opened.content, logicalInvocationId, attempt,
      openInvocation, readInvocation, readActionInvocation };
  };
}
