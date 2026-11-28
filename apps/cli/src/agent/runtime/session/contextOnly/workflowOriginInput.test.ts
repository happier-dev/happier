import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  deriveWorkflowSessionInputLocalIdV2,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  prepareWorkflowRunDataKeyV1,
  resolveValidatedAutomationAccountEncryptionV1,
  SessionInputCausalPermissionAuthorityV1Schema,
  type AvailableE2eeAutomationAccountEncryptionV1,
  type WorkflowRunRecipientCensusResponseV1,
  type WorkflowRunSummaryV1,
} from '@happier-dev/protocol';
import { createWorkflowOriginContextInputPort } from './workflowOriginInput';
import { createSessionFollowWakeSignal, publishSessionFollowWakeInvalidation } from '../follow/sessionFollowWakeSignal';

describe('origin workflow current-state pull', () => {
  const accountId = 'account-1';
  const runId = 'run-1';
  const run: WorkflowRunSummaryV1 = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
    failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
    id: runId, origin: { kind: 'direct', originSessionId: 'origin' }, machineId: 'machine',
    state: 'succeeded', revision: 5, workflowCustodyState: 'settled', originDeliveryAckRevision: 0,
    attentionRequired: false, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
  };
  const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [
    { kind: 'step' as const, id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } },
  ] };
  const frozen = { startedBy: 'user' as const, authoredDefinition: definition, materializedLeaves: [], frozenChildren: {}, metadata: null };
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
    acceptedSnapshot: { ...frozen, definition,
      source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct', originSessionId: 'origin' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      resultDelivery: { kind: 'originating_session', originSessionId: 'origin' }, workDepth: 1,
    },
  }));
  const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'final_result', accountId, runId },
    finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'current final result' },
      producerInvocation: { recordId: 'producer' } },
  }));
  const producerIndex = { id: 'producer', runId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0',
    lifecycle: 'completed', contentRevision: '1', createdAt: run.createdAt, updatedAt: run.updatedAt };
  const producerEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'producer',
      sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] },
      attempt: '0', logicalInvocationRecordId: 'producer', result: 'current final result',
      review: { decision: { kind: 'use_result', requestedFromContentRevision: '0',
        followUp: { kind: 'run_started', runId: 'follow-up-run' } } } },
  }));
  const dispatchBoundary = { readDispatchFact: async () => 'not_dispatched' as const, onDispatchedInput: () => undefined };
  const plainCensus: WorkflowRunRecipientCensusResponseV1 = {
    runId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', visibleTeamId: null,
    ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
  };

  it('keeps successful workflow reports quiet while failures wake through the shared Important policy', async () => {
    let current = { ...run };
    let acknowledged = 0;
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      storage: { execute: async operation => {
        if (operation.operation === 'run-key.census') return plainCensus;
        if (operation.operation === 'delivery.pull') return { runs: [{ run: { ...current, originDeliveryAckRevision: acknowledged }, acceptedEnvelope }] };
        if (operation.operation === 'get') return { run: current, acceptedEnvelope };
        if (operation.operation === 'invocations.list') return { invocations: [], progressEnvelopesByInvocationId: {} };
        if (operation.operation === 'delivery.ack') { acknowledged = Number(operation.revision); return { acknowledgedRevision: acknowledged }; }
        throw new Error('unexpected source mutation');
      } }, onError: error => { throw error; } });
    const signal = new AbortController().signal;
    expect(await port.take(signal)).toBeNull();
    const quiet = await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 });
    expect(quiet).toHaveLength(1);
    expect(quiet[0]?.update.ownerState).toBe('succeeded');
    expect(acknowledged).toBe(0);
    current = { ...current, state: 'failed', revision: current.revision + 1 };
    expect(await port.take(signal)).toMatchObject({ kind: 'worker_update', update: { ownerState: 'failed' } });
    expect(await quiet[0]!.recheckAdmission(signal)).toBe(false);
    expect(acknowledged).toBe(0);
  });

  it('pulls only after its own Session wakes, never per input pass or for a sibling Session', async () => {
    let pulls = 0;
    const wake = createSessionFollowWakeSignal(() => 'origin');
    const sibling = createSessionFollowWakeSignal(() => 'sibling');
    try {
      const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        storage: { execute: async operation => {
          if (operation.operation === 'delivery.pull') { pulls++; return { runs: [] }; }
          throw new Error('unexpected operation');
        } }, onError: error => { throw error; }, deliveryWake: wake.workflowOrigin });
      const signal = new AbortController().signal;
      const pass = async () => {
        expect(await port.take(signal)).toBeNull();
        expect(await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
      };
      // Startup reads once; later passes without a wake have nothing new to read.
      for (let turn = 0; turn < 3; turn++) await pass();
      expect(pulls).toBe(1);
      // A sibling hosted Session's change cannot produce this origin's delivery.
      publishSessionFollowWakeInvalidation('sibling');
      await pass();
      expect(pulls).toBe(1);
      // Three ordinary turns can wake Follow while the origin delivery proof keeps its read quiet.
      for (let turn = 0; turn < 3; turn++) {
        publishSessionFollowWakeInvalidation('origin', false);
        await pass();
      }
      expect(pulls).toBe(1);
      // The origin's own durable Session change (workflow delivery publishes one) reads again, once.
      publishSessionFollowWakeInvalidation('origin');
      await pass();
      expect(pulls).toBe(2);
      // Destination-unknown recovery (gap, reconnect fallback) still reaches every Session.
      publishSessionFollowWakeInvalidation();
      await pass();
      expect(pulls).toBe(3);
    } finally {
      wake.dispose?.();
      sibling.dispose?.();
    }
  });

  it('retrieves the accepted Plan and its started Run together and continues when the Plan acknowledgement fails', async () => {
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
    if (opened.kind !== 'available') throw new Error('expected fixture snapshot');
    const secondId = 'follow-up-run';
    const secondEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: secondId }, acceptedSnapshot: opened.content }));
    let secondRevision = 5;
    let secondAck = 0;
    const errors: unknown[] = [];
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      storage: { execute: async operation => {
        if (operation.operation === 'run-key.census') return { ...plainCensus, runId: operation.runId };
        if (operation.operation === 'invocations.get' && operation.runId === runId) {
          return { invocation: { index: producerIndex, contentEnvelope: producerEnvelope } };
        }
        if (operation.operation === 'delivery.pull') return { runs: [
          { run, acceptedEnvelope, resultEnvelope },
          { run: { ...run, id: secondId, revision: secondRevision, originDeliveryAckRevision: secondAck }, acceptedEnvelope: secondEnvelope },
        ] };
        if (operation.operation === 'delivery.ack') {
          if (operation.runId === runId) throw new Error('deleted_run_ack');
          secondAck = Number(operation.revision);
          return { acknowledgedRevision: secondAck };
        }
        throw new Error('unexpected operation');
      } }, onError: error => { errors.push(error); } });
    const signal = new AbortController().signal;
    const first = await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 });
    expect(first.map(({ update }) => update)).toEqual([
      expect.objectContaining({ workerId: runId, headline: expect.stringContaining(secondId) }),
      expect.objectContaining({ workerId: secondId, ownerState: 'succeeded' }),
    ]);
    first.forEach(item => item.acknowledgeAccepted());
    secondRevision = 6;
    const next = await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 });
    expect(secondAck).toBe(5);
    expect(next).toHaveLength(1);
    expect(next[0]?.localId).toBe(`workflow-run:${secondId}:6`);
    expect(errors).toHaveLength(1);
  });

  it('refuses origin delivery when canonical Account currentness requires an E2EE material retry', async () => {
    const errors: unknown[] = [];
    const operations: string[] = [];
    const resolvedKinds: string[] = [];
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
      resolveEncryption: async (signal) => {
        const resolved = await resolveValidatedAutomationAccountEncryptionV1({
          signal,
          // Account currentness and local credential storage are the real system boundaries.
          resolveAccountEncryptionCurrentness: async () => ({ mode: 'e2ee', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: 'current-key', updatedAt: 0 }),
          resolveAccountEncryptionMaterial: async () => null,
        });
        resolvedKinds.push(resolved.kind);
        return resolved;
      },
      storage: { execute: async (operation) => {
        operations.push(operation.operation);
        if (operation.operation === 'delivery.pull') return { runs: [{ run, acceptedEnvelope, resultEnvelope }] };
        throw new Error('unavailable Account material must prevent content reads and delivery mutations');
      } },
      onError: (error) => { errors.push(error); },
    });
    const signal = new AbortController().signal;
    expect(await port.take(signal)).toBeNull();
    expect(await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(resolvedKinds).toEqual(['retry', 'retry']);
    expect(errors.every(error => error instanceof Error && error.message === 'workflow_delivery_material_unavailable')).toBe(true);
    expect(operations.every(operation => operation === 'delivery.pull')).toBe(true);
  });

  it.each(['machine', 'origin-machine'])('pulls current state without claiming custody and acknowledges only provider acceptance on %s', async (originMachineId) => {
    const operations: Readonly<Record<string, unknown>>[] = [];
    const counts = () => operations.reduce<Record<string, number>>((result, operation) => {
      const key = String(operation.operation);
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {});
    let acknowledgedRevision = 0;
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: originMachineId,
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      // The real storage owner is an HTTP/database system boundary; sealed bytes stay opaque here.
      storage: { execute: async (operation) => {
        operations.push(operation);
        if (operation.operation === 'run-key.census') return plainCensus;
        if (operation.operation === 'delivery.pull') return { runs: [{ run: { ...run, originDeliveryAckRevision: acknowledgedRevision }, acceptedEnvelope, resultEnvelope, checkpointEnvelope: null, invocations: [] }] };
        if (operation.operation === 'get') return { run: { ...run, originDeliveryAckRevision: acknowledgedRevision }, acceptedEnvelope, resultEnvelope };
        if (operation.operation === 'invocations.get') return { invocation: { index: producerIndex, contentEnvelope: producerEnvelope } };
        if (operation.operation === 'delivery.ack') {
          acknowledgedRevision = Number(operation.revision);
          return { acknowledgedRevision };
        }
        throw new Error('unexpected custody/input mutation');
      } },
      onError: (error) => { throw error; },
    });
    const signal = new AbortController().signal;
    expect(await port.take(signal)).toBeNull();
    expect(counts()).toEqual({ 'delivery.pull': 1, 'run-key.census': 1, 'invocations.get': 1 });
    operations.length = 0;
    const prepared = await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 });
    expect(prepared).toHaveLength(1);
    const input = prepared[0];
    expect(input).toMatchObject({ update: { result: expect.stringContaining('current final result'),
      headline: expect.stringContaining('follow-up-run'), ownerState: 'succeeded' } });
    expect(operations.some((operation) => operation.operation === 'delivery.ack')).toBe(false);
    expect(counts()).toEqual({ 'delivery.pull': 1, 'run-key.census': 1, 'invocations.get': 1 });
    if (!input) throw new Error('expected natural-turn worker update');
    operations.length = 0;
    expect(await input.recheckAdmission(signal)).toBe(true);
    expect(counts()).toEqual({ get: 1, 'run-key.census': 1 });
    operations.length = 0;
    input.acknowledgeAccepted();
    expect(await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).toEqual([]);
    expect(counts()).toEqual({ 'delivery.ack': 1, 'delivery.pull': 1, 'run-key.census': 1 });
    expect(operations.filter((operation) => operation.operation === 'delivery.ack')).toEqual([
      { operation: 'delivery.ack', runId, revision: 5 },
    ]);
    operations.length = 0;
    expect(await port.take(signal)).toBeNull();
    // The acknowledged result causes no repeated read, producer detail demand or
    // publication: nothing changed on the origin Session since that settled pull.
    expect(counts()).toEqual({});
  });

  it('rechecks the current Run so an old attention update is never admitted after resolution', async () => {
    let current = { ...run, state: 'running' as const, attentionRequired: true, invocationAttentionRequired: true };
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      storage: { execute: async (operation) => operation.operation === 'run-key.census' ? plainCensus : operation.operation === 'delivery.pull'
        ? { runs: [{ run: current, acceptedEnvelope, resultEnvelope: null, checkpointEnvelope: null, invocations: [] }] }
        : operation.operation === 'invocations.list' ? { invocations: [], progressEnvelopesByInvocationId: {} }
        : { run: current, acceptedEnvelope, resultEnvelope: null } }, onError: (error) => { throw error; },
    });
    const signal = new AbortController().signal;
    const input = (await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 }))[0];
    expect(input?.update.wake).toBe('needs_you');
    expect(await port.take(signal)).toMatchObject({ kind: 'worker_update', update: { ownerState: 'running', wake: 'needs_you' } });
    current = { ...current, attentionRequired: false, invocationAttentionRequired: false };
    expect(await input?.recheckAdmission(signal)).toBe(false);
    expect(await port.take(signal)).toBeNull();
  });

  it.each([
    { resetAtMs: 1_800_000, state: 'failed' as const, attentionRequired: false, lifecycle: 'failed' as const },
    { resetAtMs: null, state: 'failed' as const, attentionRequired: false, lifecycle: 'failed' as const },
    { resetAtMs: 1_800_000, state: 'waiting_for_review' as const, attentionRequired: true, lifecycle: 'waiting_for_review' as const },
  ])('delivers the actual failed leaf issue through sealed progress and the WorkerUpdate reader ($state, reset $resetAtMs)', async ({ resetAtMs, state, attentionRequired, lifecycle }) => {
    const failedRun = { ...run, state, attentionRequired, invocationAttentionRequired: attentionRequired };
    const runtimeIssueV1 = { v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const,
      source: 'usage_limit' as const, code: 'usage_limit', occurredAt: 1000,
      usageLimit: { v: 1 as const, resetAtMs, retryAfterMs: null, quotaScope: 'provider' as const, recoverability: 'wait' as const } };
    const index = { ...producerIndex, lifecycle };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id, sequence: index.sequence,
        parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] },
        attempt: '0', logicalInvocationRecordId: index.id,
        reason: { code: 'usage_limit', message: 'Quota exhausted', runtimeIssueV1 } },
    }));
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      storage: { execute: async operation => {
        if (operation.operation === 'run-key.census') return plainCensus;
        if (operation.operation === 'delivery.pull') return { runs: [{ run: failedRun, acceptedEnvelope }] };
        if (operation.operation === 'get') return { run: failedRun, acceptedEnvelope };
        if (operation.operation === 'invocations.list') return Array.isArray(operation.lifecycles) && operation.lifecycles.includes(lifecycle)
          ? { invocations: [index], progressEnvelopesByInvocationId: { [index.id]: contentEnvelope } }
          : { invocations: [], progressEnvelopesByInvocationId: {} };
        throw new Error(`Unexpected workflow operation: ${operation.operation}`);
      } }, onError: error => { throw error; } });
    const input = await port.take(new AbortController().signal);
    expect(input).toMatchObject({ kind: 'worker_update', update: { workerKind: 'workflow_run', ownerState: state,
      runtimeIssueV1, transcriptPointer: { kind: 'workflow_run', runId, invocationRecordId: index.id } } });
  });

  it.each([
    { dispatched: true, ceiling: 'default' as const, sourceAuthority: undefined },
    { dispatched: false, ceiling: 'read-only' as const, sourceAuthority: undefined },
    { dispatched: false, ceiling: 'default' as const, sourceAuthority: {
      mediatorPluginId: 'happier.channels', sourceRef: 'own-channel', sourceRevisionOrEpoch: 'revision-1', remoteApprovalMaxScope: 'request' as const,
    } },
  ])('uses the positive host fact, not publisher custody, for restart and same-identity Resume (dispatched: $dispatched, ceiling: $ceiling)', async ({ dispatched, ceiling, sourceAuthority }) => {
    const rootId = 'root';
    const invocationId = 'step';
    const localInputId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: invocationId });
    const makeRow = (id: string, root: boolean) => {
      const index = { id, runId, sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0',
        lifecycle: root ? 'running' : 'admitting', contentRevision: '0', createdAt: run.createdAt, updatedAt: run.updatedAt };
      const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
          sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
          invocationPath: { blockId: root ? '$root' : 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
          ...(!root ? { input: { document: { text: 'Committed input', references: [], attachments: [] }, input: [],
            renderedText: 'Frozen role instructions\n\nCommitted input\n\nFrozen result contract' },
            resultContract: { kind: 'text' }, execution: { kind: 'session', sessionId: 'origin', localInputId } } : {}),
        },
      }));
      return { index, contentEnvelope };
    };
    const row = makeRow(invocationId, false);
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
    if (opened.kind !== 'available') throw new Error('expected accepted snapshot');
    const inputEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: { ...opened.content,
        authorization: { ...opened.content.authorization, admittedPermissionCeiling: ceiling, ...(sourceAuthority ? { sourceAuthority } : {}) } } }));
    const restored: string[] = [];
    let dispatchReads = 0;
    const port = createWorkflowOriginContextInputPort({ accountId, originSessionId: 'origin', machineId: 'machine',
      readDispatchFact: async () => { dispatchReads++; return dispatched ? 'dispatched' : 'not_dispatched'; },
      onDispatchedInput: (input) => { restored.push(input.localInputId); },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      storage: { execute: async (operation) => {
        if (operation.operation === 'run-key.census') return plainCensus;
        if (operation.operation === 'delivery.pull') return { runs: [{ run: { ...run, state: 'running', originDeliveryAckRevision: null },
          acceptedEnvelope: inputEnvelope, resultEnvelope: null, checkpointEnvelope: null, invocations: [], hasOriginInputCandidates: true }] };
        if (operation.operation === 'invocations.list') return {
          invocations: [row.index], progressEnvelopesByInvocationId: { [invocationId]: row.contentEnvelope },
        };
        if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === rootId ? makeRow(rootId, true) : row };
        throw new Error('unexpected producer mutation');
      } }, onError: (error) => { throw error; },
    });
    const signal = new AbortController().signal;
    if (dispatched) {
      expect(await port.take(signal)).toBeNull();
      expect(restored).toContain(localInputId);
      // A positive host dispatch settles this offer. Later native-boundary
      // probes must not retain it as outstanding work or read its history again.
      expect(await port.isWorkflowStepDeliverable!({ localInputId })).toBe(false);
      expect(await port.isWorkflowStepDeliverable!({ localInputId })).toBe(false);
      expect(dispatchReads).toBe(1);
      expect(restored).toEqual([localInputId]);
    } else {
      const input = await port.take(signal);
      expect(input).toMatchObject({ kind: 'workflow_step', localInputId,
        text: 'Frozen role instructions\n\nCommitted input\n\nFrozen result contract' });
      expect(input?.kind === 'workflow_step'
        ? SessionInputCausalPermissionAuthorityV1Schema.parse(input.causalPermissionAuthority) : null)
        .toEqual({ kind: 'admittedSessionInputV1', admittedPermissionCeiling: ceiling,
          ...(sourceAuthority ? { sourceAuthority: { kind: 'mediatedExternal', ...sourceAuthority, admittedPermissionCeiling: ceiling } } : {}) });
      // RPC withdrawal is decided by the origin admission owner, not this pull adapter.
      // After its producer reoffers the same physical invocation, no second custody set may hide it.
      expect(await port.take(signal)).toMatchObject({ kind: 'workflow_step', localInputId });
      expect(restored).toEqual([]);
    }
  });

  it.each(['available', 'missing', 'wrong-run'] as const)('opens only the census-bound Run key for an E2EE origin (%s)', async (keyState) => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: randomBytes(32) } });
    const encryption: AvailableE2eeAutomationAccountEncryptionV1 = { kind: 'available', material,
      witness: { mode: 'e2ee', version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes });
    if (prepared.runCrypto.mode !== 'e2ee') throw new Error('expected E2EE workflow run crypto');
    const ownerEnvelope = prepared.recipientKeyEnvelopes[0]!.encryptedDataKey;
    const census: WorkflowRunRecipientCensusResponseV1 = { ...plainCensus,
      runId: keyState === 'wrong-run' ? 'another-run' : runId,
      encryptionMode: 'e2ee', ownerAccountCurrentness: encryption.witness,
      dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: keyState === 'missing' ? null : ownerEnvelope };
    const accepted = sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...prepared.runCrypto, randomBytes,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
      acceptedSnapshot: { ...frozen, definition, source: { kind: 'inline' },
        inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'origin' },
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, workDepth: 1,
        resultDelivery: { kind: 'originating_session', originSessionId: 'origin' } } });
    const final = sealWorkflowFinalResultStoredEnvelopeV1({ ...prepared.runCrypto, randomBytes,
      binding: { v: 1, purpose: 'final_result', accountId, runId },
      finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'Run-key protected result' },
        producerInvocation: { recordId: 'producer' } } });
    const producer = sealWorkflowProgressStoredEnvelopeV1({ ...prepared.runCrypto, randomBytes,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'producer',
        sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'producer', result: 'Run-key protected result' } });
    const errors: unknown[] = [];
    const operations: string[] = [];
    const port = createWorkflowOriginContextInputPort({ ...dispatchBoundary, accountId, originSessionId: 'origin', machineId: 'machine',
      resolveEncryption: async () => encryption,
      // Only the storage network boundary is replaced; recipient-key opening and all codecs are real.
      storage: { execute: async (operation) => {
        operations.push(operation.operation);
        if (operation.operation === 'run-key.census') return census;
        if (operation.operation === 'delivery.pull' || operation.operation === 'get') {
          const snapshot = { run, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(accepted),
            resultEnvelope: serializeWorkflowStoredContentEnvelopeV1(final) };
          return operation.operation === 'get' ? snapshot : { runs: [snapshot] };
        }
        if (operation.operation === 'invocations.get') return { invocation: { index: producerIndex,
          contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(producer) } };
        throw new Error('unexpected origin mutation');
      } }, onError: error => { errors.push(error); } });
    const input = (await port.prepareWorkerUpdates!({ signal: new AbortController().signal, maxUtf8Bytes: 65536 }))[0] ?? null;
    if (keyState === 'available') {
      expect(input).toMatchObject({ update: { result: 'Run-key protected result' } });
      if (!input) throw new Error('expected current encrypted result');
      expect(await input.recheckAdmission(new AbortController().signal)).toBe(true);
      expect(errors).toEqual([]);
    } else {
      expect(input).toBeNull();
      expect(errors).toHaveLength(1);
      expect(operations).not.toContain('invocations.get');
    }
    expect(operations).not.toContain('delivery.ack');
  });
});
