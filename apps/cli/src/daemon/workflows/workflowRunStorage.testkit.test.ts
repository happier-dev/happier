import { describe, expect, it } from 'vitest';
import {
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowRunInvocationIndexV1,
} from '@happier-dev/protocol/workflows';

import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import type { WorkflowRunStorageOperation } from './workflowRunStorageClient';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows';

const runId = 'run-current-slot';
const parentRecordId = 'root-current-slot';
const currentSlot = {
  operation: 'invocations.current', runId, parentRecordId, memberOrdinal: '499',
} as const satisfies WorkflowRunStorageOperation;

function sealProgress(index: WorkflowRunInvocationIndexV1): string {
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain',
    binding: {
      v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
      recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
      memberOrdinal: index.memberOrdinal, attempt: index.attempt,
    },
    progress: {
      kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
      blockKind: 'step', attempt: index.attempt, logicalInvocationRecordId: 'original',
      ...(index.attempt === '0' ? {} : { previousAttemptRecordId: 'original' }),
    },
  }));
}

describe('Workflow storage boundary current slot', () => {
  it('retains the direct admission owner key in the opaque Run census', async () => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const witness = { mode: 'e2ee' as const, version: 1,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId: 'account-1',
      encryption: { kind: 'available', witness, material }, randomBytes: length => new Uint8Array(length).fill(3) });
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-1', origin: { kind: 'direct' } });
    await storage.execute({ operation: 'admit', runId, machineId: 'machine-1', origin: { kind: 'direct' },
      accountCurrentness: witness, acceptedEnvelope: 'opaque-accepted', recipientKeyEnvelopes: prepared.recipientKeyEnvelopes });
    const ownerKey = prepared.recipientKeyEnvelopes[0]!.encryptedDataKey;
    await expect(storage.execute({ operation: 'run-key.census', runId })).resolves.toMatchObject({
      encryptionMode: 'e2ee', ownerAccountCurrentness: witness,
      dataEncryptionKey: ownerKey, callerDataEncryptionKey: ownerKey });
  });
  it.each(['pause_requested', 'cancel_requested'] as const)('fences input admission and new slots after %s without blocking an owned completion fact', async (control) => {
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-1', origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: parentRecordId, contentEnvelope: 'root' } });
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: 'checkpoint',
      invocations: [{ id: 'leaf', sequence: '1', parentRecordId, memberOrdinal: '0', contentEnvelope: 'leaf' }] });
    storage.requestControl(control);
    const leaf = storage.rowById('leaf')!.index;
    await expect(storage.execute({ operation: 'invocations.fact', runId, invocationId: 'leaf', invocationAttempt: '0',
      expectedLifecycle: leaf.lifecycle, expectedContentRevision: leaf.contentRevision, lifecycle: 'admitting', contentEnvelope: 'admitting' })).rejects.toMatchObject({
      response: { status: 409, data: { error: 'currentness_conflict' } },
    });
    await expect(storage.execute({ operation: 'invocations.admit', runId, expectedRevision: storage.run().revision,
      checkpointEnvelope: 'checkpoint', invocations: [{ id: 'new', sequence: '2', parentRecordId, memberOrdinal: '1', contentEnvelope: 'new' }] }))
      .rejects.toMatchObject({ response: { status: 409, data: { error: 'currentness_conflict' } } });
    await expect(storage.execute({ operation: 'invocations.fact', runId, invocationId: 'leaf', invocationAttempt: '0',
      expectedLifecycle: leaf.lifecycle, expectedContentRevision: leaf.contentRevision, lifecycle: 'completed', contentEnvelope: 'completed' })).resolves.toMatchObject({ lifecycle: 'completed' });
  });

  it('returns an empty slot with the unchanged parent revision and refuses a foreign Run', async () => {
    const storage = createWorkflowRunStorageTestkit({
      runId, machineId: 'machine-1', origin: { kind: 'direct' }, acceptedEnvelope: 'opaque-accepted',
    });

    await expect(storage.execute(currentSlot)).resolves.toEqual({ invocation: null, parentRevision: 0 });
    expect(storage.run().revision).toBe(0);
    await expect(storage.execute({ ...currentSlot, runId: 'foreign-run' })).rejects.toMatchObject({
      response: { status: 404, data: { error: 'run_not_found' } },
    });
  });

  it('returns the numeric newest exact slot, including terminal rows and their sealed bytes', async () => {
    const storage = createWorkflowRunStorageTestkit({
      runId, machineId: 'machine-1', origin: { kind: 'direct' }, acceptedEnvelope: 'opaque-accepted',
      invocationPageSize: 1,
      state: 'running',
    });
    await storage.execute({
      operation: 'invocations.admit', runId, expectedRevision: 0, checkpointEnvelope: 'opaque-checkpoint',
      invocations: [
        { id: 'preceding-sibling', sequence: '1', parentRecordId, memberOrdinal: '0', contentEnvelope: 'opaque-sibling' },
        { id: 'original', sequence: '2', parentRecordId, memberOrdinal: '499', contentEnvelope: 'opaque-original' },
        { id: 'retry-two', sequence: '3', parentRecordId, memberOrdinal: '499', contentEnvelope: 'opaque-two' },
        { id: 'retry-ten', sequence: '4', parentRecordId, memberOrdinal: '499', contentEnvelope: 'opaque-ten' },
        { id: 'other-parent', sequence: '5', parentRecordId: 'other-root', memberOrdinal: '499', contentEnvelope: 'opaque-other-parent' },
      ],
    });
    // Seed persisted recovered rows at the storage boundary, as the server
    // integration fixture does; E0 does not implement the recovery operation.
    const earlier = storage.rowById('retry-two')!;
    earlier.index = { ...earlier.index, attempt: '2', lifecycle: 'running' };
    earlier.contentEnvelope = sealProgress(earlier.index);
    const newest = storage.rowById('retry-ten')!;
    newest.index = { ...newest.index, attempt: '10', lifecycle: 'failed' };
    newest.contentEnvelope = sealProgress(newest.index);

    await expect(storage.execute(currentSlot)).resolves.toEqual({
      invocation: { index: newest.index, contentEnvelope: newest.contentEnvelope }, parentRevision: 1,
    });
    await expect(storage.execute({ operation: 'invocations.list', runId, invocationId: earlier.index.id,
      progressEnvelopes: true })).resolves.toMatchObject({ invocations: [earlier.index],
        progressEnvelopesByInvocationId: { [earlier.index.id]: earlier.contentEnvelope } });
    await expect(storage.execute({ operation: 'invocations.list', runId, parentRecordId, memberOrdinal: '499' }))
      .resolves.toMatchObject({ invocations: [newest.index] });
    await expect(storage.execute({ operation: 'invocations.list', runId, parentRecordIds: ['other-root'] }))
      .resolves.toMatchObject({ invocations: [storage.rowById('other-parent')!.index] });
    await expect(storage.execute({ operation: 'invocations.list', runId, lifecycles: ['cancelled'] }))
      .resolves.toEqual({ invocations: [], parentRevision: 1 });
    await expect(storage.execute({ operation: 'invocations.list', runId, lifecycles: ['failed'] }))
      .resolves.toEqual({ invocations: [newest.index], parentRevision: 1 });
    await expect(storage.execute({ operation: 'invocations.list', runId, parentRecordId, lifecycles: ['failed'] }))
      .resolves.toEqual({ invocations: [newest.index], parentRevision: 1 });
    await expect(storage.execute({ ...currentSlot, parentRecordId: 'missing-parent' })).resolves.toEqual({
      invocation: null, parentRevision: 1,
    });
    await expect(storage.execute({ ...currentSlot, memberOrdinal: '498' })).resolves.toEqual({
      invocation: null, parentRevision: 1,
    });
    expect(storage.run().revision).toBe(1);
  });
});
