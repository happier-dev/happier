import { composeWorkflowRunWorkerUpdateV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowFinalResultStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { WorkflowAuthoredInputV1Schema, WorkflowRunSummaryV1Schema, WorkflowRunInvocationIndexV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowAcceptedSnapshotV1, WorkflowRunSummaryV1, WorkflowRunInvocationIndexV1, WorkflowProgressEnvelopeV1, WorkflowRunEncryptionV1, ValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol';
import type { WorkflowRunStorageOperation } from '@/daemon/workflows/workflowRunStorageClient';
import { readSessionFollowWakeInvalidationGeneration, waitForSessionFollowWakeInvalidation } from '../follow/sessionFollowWakeSignal';
import type { HostContextOnlyInputPort, PreparedWorkerContextItem } from './hostContextOnlyInput';

export type WorkflowOriginInputOptions = Readonly<{
  accountId: string;
  originSessionId: string;
  machineId: string;
  storage: Readonly<{ execute: (operation: WorkflowRunStorageOperation, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown> }>;
  resolveEncryption: (signal: AbortSignal) => Promise<ValidatedAutomationAccountEncryptionV1>;
  readDispatchFact: (localInputId: string, signal: AbortSignal) => Promise<'dispatched' | 'not_dispatched'>;
  onDispatchedInput: (input: Readonly<{ localInputId: string }>) => void;
  onError: (error: unknown) => void;
}>;

type OpenRow = Readonly<{ index: WorkflowRunInvocationIndexV1; progress: WorkflowProgressEnvelopeV1 }>;
type Offer = Readonly<{ runId: string; invocationRecordId: string }>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_delivery_response_invalid');
  return value as Readonly<Record<string, unknown>>;
}

/** Origin consumption reads committed facts. It never takes publisher custody or writes Pending. */
export function createWorkflowOriginContextInputPort(options: WorkflowOriginInputOptions): HostContextOnlyInputPort {
  const offers = new Map<string, Offer>();
  const acceptedRevisions = new Map<string, number>();
  const pendingAcks = new Map<string, number>();
  let observedWake = readSessionFollowWakeInvalidationGeneration();
  const execute = async (operation: WorkflowRunStorageOperation, signal?: AbortSignal) =>
    record(await options.storage.execute(operation, signal ? { signal } : {}));
  const requireEncryption = async (runId: string, signal: AbortSignal): Promise<WorkflowRunEncryptionV1> => {
    const encryption = await options.resolveEncryption(signal);
    if (encryption.kind !== 'available') throw new Error('workflow_delivery_material_unavailable');
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse(await execute({ operation: 'run-key.census', runId }, signal));
    if (census.runId !== runId || census.ownerAccountId !== options.accountId) throw new Error('workflow_delivery_binding_mismatch');
    const resolved = resolveWorkflowRunDataKeyV1({ encryption, census });
    if (resolved.kind !== 'available') throw new Error('workflow_delivery_material_unavailable');
    return resolved.encryption;
  };
  const binding = (index: WorkflowRunInvocationIndexV1) => ({
    v: 1 as const, purpose: 'invocation_progress' as const, accountId: options.accountId, runId: index.runId,
    recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
    memberOrdinal: index.memberOrdinal, attempt: index.attempt,
  });
  const openRow = (raw: unknown, encryption: WorkflowRunEncryptionV1): OpenRow | null => {
    if (raw == null) return null;
    const row = record(raw);
    const index = WorkflowRunInvocationIndexV1Schema.parse(row.index);
    const opened = openWorkflowProgressStoredEnvelopeV1({ ...encryption.runCrypto, binding: binding(index),
      envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
    if (opened.kind !== 'available') throw new Error('workflow_delivery_content_unavailable');
    return { index, progress: opened.content };
  };
  const readRow = async (runId: string, invocationId: string, encryption: WorkflowRunEncryptionV1, signal?: AbortSignal) => {
    const response = await execute({ operation: 'invocations.get', runId, invocationId }, signal);
    const row = openRow(response.invocation, encryption);
    if (row && (row.index.runId !== runId || row.index.id !== invocationId)) throw new Error('workflow_delivery_binding_mismatch');
    return row;
  };
  const openSnapshot = (raw: Readonly<Record<string, unknown>>, encryption: WorkflowRunEncryptionV1) => {
    const run = WorkflowRunSummaryV1Schema.parse(raw.run);
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...encryption.runCrypto,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: options.accountId, runId: run.id },
      envelope: parseWorkflowStoredContentEnvelopeV1(raw.acceptedEnvelope) });
    if (opened.kind !== 'available') throw new Error('workflow_delivery_content_unavailable');
    if (opened.content.origin?.originSessionId !== options.originSessionId || opened.content.machineId !== run.machineId
      || run.ownerAccountId !== options.accountId) throw new Error('workflow_delivery_binding_mismatch');
    return { run, accepted: opened.content };
  };
  const rowMatchesOrigin = (run: WorkflowRunSummaryV1, row: OpenRow, localInputId: string) => row.index.runId === run.id
    && row.progress.execution?.kind === 'session' && row.progress.execution.sessionId === options.originSessionId
    && row.progress.execution.localInputId === localInputId
    && localInputId === deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId: run.id, invocationRecordId: row.index.id });
  const readOffer = async (localInputId: string, signal: AbortSignal) => {
    const offer = offers.get(localInputId);
    if (!offer) return null;
    const encryption = await requireEncryption(offer.runId, signal);
    const snapshot = openSnapshot(await execute({ operation: 'get', runId: offer.runId }, signal), encryption);
    const row = await readRow(offer.runId, offer.invocationRecordId, encryption, signal);
    if (snapshot.accepted.machineId !== options.machineId || !row || !rowMatchesOrigin(snapshot.run, row, localInputId) || !row.index.parentRecordId) return null;
    const current = await execute({ operation: 'invocations.current', runId: offer.runId,
      parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal }, signal);
    const currentRow = openRow(current.invocation, encryption);
    if (!currentRow || currentRow.index.id !== row.index.id) return null;
    return { ...snapshot, row: currentRow, encryption };
  };
  const observeDispatch = async (localInputId: string, signal: AbortSignal) => {
    if (await options.readDispatchFact(localInputId, signal) !== 'dispatched') return false;
    options.onDispatchedInput({ localInputId });
    return true;
  };
  const flushAcks = async (signal: AbortSignal) => {
    for (const [runId, revision] of pendingAcks) {
      try {
        await execute({ operation: 'delivery.ack', runId, revision }, signal);
        if (pendingAcks.get(runId) === revision) pendingAcks.delete(runId);
      } catch (error) {
        if (signal.aborted) throw error;
        options.onError(error);
      }
    }
  };
  const updates = async (signal: AbortSignal): Promise<Readonly<{ workers: PreparedWorkerContextItem[]; steps: Array<{
    localInputId: string; runId: string; row: OpenRow; accepted: WorkflowAcceptedSnapshotV1;
  }> }>> => {
    await flushAcks(signal);
    const workers: PreparedWorkerContextItem[] = [];
    const steps: Array<{ localInputId: string; runId: string; row: OpenRow; accepted: WorkflowAcceptedSnapshotV1 }> = [];
    let cursor: string | undefined;
    do {
      const page = await execute({ operation: 'delivery.pull', originSessionId: options.originSessionId,
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, ...(cursor ? { cursor } : {}) }, signal);
      if (!Array.isArray(page.runs)) throw new Error('workflow_delivery_response_invalid');
      for (const raw of page.runs) {
        try {
          const source = record(raw);
          const encryption = await requireEncryption(WorkflowRunSummaryV1Schema.parse(source.run).id, signal);
          const { run, accepted } = openSnapshot(source, encryption);
          if (source.hasOriginInputCandidates === true && accepted.machineId === options.machineId) {
            let invocationCursor: string | undefined;
            do {
              const rowPage = await execute({ operation: 'invocations.list', runId: run.id,
                lifecycles: ['admitting', 'cancel_requested'], progressEnvelopes: true,
                pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
                ...(invocationCursor ? { cursor: invocationCursor } : {}) }, signal);
              if (!Array.isArray(rowPage.invocations)) throw new Error('workflow_delivery_response_invalid');
              const progressEnvelopes = record(rowPage.progressEnvelopesByInvocationId);
              for (const rawRow of rowPage.invocations) {
                const index = WorkflowRunInvocationIndexV1Schema.parse(rawRow);
                const row = openRow({ index, contentEnvelope: progressEnvelopes[index.id] }, encryption);
                if (!row) continue;
                const localInputId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId: run.id, invocationRecordId: row.index.id });
                if (!rowMatchesOrigin(run, row, localInputId)) continue;
                offers.set(localInputId, { runId: run.id, invocationRecordId: row.index.id });
                if (await observeDispatch(localInputId, signal)) continue;
                steps.push({ localInputId, runId: run.id, row, accepted });
              }
              invocationCursor = typeof rowPage.nextCursor === 'string' ? rowPage.nextCursor : undefined;
            } while (invocationCursor && !signal.aborted);
          }
          if (run.originDeliveryAckRevision === null || run.revision <= Math.max(run.originDeliveryAckRevision, acceptedRevisions.get(run.id) ?? 0)) continue;
          const finalResult = source.resultEnvelope == null ? undefined : openWorkflowFinalResultStoredEnvelopeV1({
            ...encryption.runCrypto, binding: { v: 1, purpose: 'final_result', accountId: options.accountId, runId: run.id },
            envelope: parseWorkflowStoredContentEnvelopeV1(source.resultEnvelope),
          });
          if (finalResult && finalResult.kind !== 'available') throw new Error('workflow_delivery_content_unavailable');
          const final = finalResult?.kind === 'available' ? finalResult.content : undefined;
          const producer = final ? await readRow(run.id, final.producerInvocation.recordId, encryption, signal) : null;
          const update = composeWorkflowRunWorkerUpdateV1({ run, ...(final ? { finalResult: final } : {}),
            ...(producer?.progress.review === undefined ? {} : { finalProducerReview: producer.progress.review }) });
          if (!update) continue;
          workers.push({ localId: `workflow-run:${run.id}:${run.revision}`, update,
            recheckAdmission: async (recheckSignal) => {
              const current = openSnapshot(await execute({ operation: 'get', runId: run.id }, recheckSignal), await requireEncryption(run.id, recheckSignal));
              return !recheckSignal.aborted && current.run.revision === run.revision
                && current.run.originDeliveryAckRevision !== null && current.run.originDeliveryAckRevision < run.revision
                && current.run.state === run.state && current.run.attentionRequired === run.attentionRequired;
            },
            acknowledgeAccepted: () => {
              acceptedRevisions.set(run.id, Math.max(acceptedRevisions.get(run.id) ?? 0, run.revision));
              pendingAcks.set(run.id, Math.max(pendingAcks.get(run.id) ?? 0, run.revision));
            },
          });
        } catch (error) {
          if (signal.aborted) throw error;
          options.onError(error);
        }
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor && !signal.aborted);
    return { workers, steps };
  };
  const readUpdates = async (signal: AbortSignal) => {
    try {
      return await updates(signal);
    } catch (error) {
      if (!signal.aborted) options.onError(error);
      return { workers: [], steps: [] };
    }
  };
  return {
    take: async (signal) => {
      observedWake = readSessionFollowWakeInvalidationGeneration();
      const pulled = await readUpdates(signal);
      const step = pulled.steps[0];
      if (!step) {
        const terminal = pulled.workers.find((worker) => worker.update.wake === 'finished');
        return terminal ? { kind: 'worker_update', ...terminal } : null;
      }
      const authored = WorkflowAuthoredInputV1Schema.parse(step.row.progress.input);
      if (authored.renderedText === undefined) throw new Error('workflow_delivery_input_not_frozen');
      return { kind: 'workflow_step', localInputId: step.localInputId,
        text: authored.renderedText,
        workflowInvocation: { runId: step.runId, invocationRecordId: step.row.index.id },
        workDepth: step.accepted.workDepth, acknowledgeAccepted: () => undefined,
      };
    },
    waitForChange: async (signal) => await waitForSessionFollowWakeInvalidation(observedWake, signal),
    isWorkflowStepDeliverable: async ({ localInputId }) => {
      const signal = new AbortController().signal;
      if (await observeDispatch(localInputId, signal)) return false;
      const current = await readOffer(localInputId, signal);
      return current !== null && current.run.state === 'running' && current.row.index.lifecycle === 'admitting';
    },
    reportWorkflowStepWithdrawn: async ({ localInputId }) => {
      const signal = new AbortController().signal;
      if (await observeDispatch(localInputId, signal)) return;
      const current = await readOffer(localInputId, signal);
      if (!current || (current.run.state === 'running' && current.row.index.lifecycle === 'admitting')) return;
      if (!['admitting', 'cancel_requested'].includes(current.row.index.lifecycle)) return;
      await execute({ operation: 'origin-input.withdrawn', originSessionId: options.originSessionId,
        runId: current.run.id, invocationRecordId: current.row.index.id, expectedRevision: current.run.revision,
        accountCurrentness: current.encryption.witness,
      });
    },
    prepareWorkerUpdates: async ({ signal }) => (await readUpdates(signal)).workers,
  };
}
