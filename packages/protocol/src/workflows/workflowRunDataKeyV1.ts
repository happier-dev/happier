import type { AccountScopedCryptoMaterialSnapshotV1 } from '../crypto/accountScopedCipher.js';
import tweetnacl from 'tweetnacl';
import { prepareResourceRecipientKeyEnvelopesV1 } from '../teams/resourceRecipientKeyPreparationV1.js';
import { isAvailableE2eeAutomationAccountEncryptionV1, type AvailableAutomationAccountEncryptionV1,
  type AutomationAccountCurrentnessWitnessV1 } from '../automations/automationAccountCurrentnessV1.js';
import { deriveAccountMachineKeyFromRecoverySecret } from '../crypto/accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import type { WorkflowRunRecipientCensusResponseV1, WorkflowRunRecipientKeyEnvelopeV1,
  WorkflowRunRecipientKeyEnvelopeCommitInputV1, WorkflowRunRecipientKeyEnvelopeCommitResponseV1 } from './workflowRunKeyV1.js';

export type WorkflowRunDataKeyV1 = Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; runDataKey: Uint8Array }>;
export type WorkflowRunEncryptionV1 = Readonly<{
  witness: AutomationAccountCurrentnessWitnessV1;
  runCrypto: WorkflowRunDataKeyV1;
}>;

function machineKey(encryption: WorkflowRunReadEncryptionV1): Uint8Array {
  if (encryption.witness.mode !== 'e2ee' || !('material' in encryption)) throw new Error('workflow_run_key_unavailable');
  return encryption.material.material.type === 'legacy'
    ? deriveAccountMachineKeyFromRecoverySecret(encryption.material.material.secret)
    : encryption.material.material.machineKey;
}

/** Admission and Account transition both allocate one independent key per Run. */
export function prepareWorkflowRunDataKeyV1(params: Readonly<{
  accountId: string;
  encryption: AvailableAutomationAccountEncryptionV1;
  census?: WorkflowRunRecipientCensusResponseV1;
  randomBytes: (length: number) => Uint8Array;
}>): Readonly<{ runCrypto: WorkflowRunDataKeyV1; recipientKeyEnvelopes: WorkflowRunRecipientKeyEnvelopeV1[] }> {
  if (!isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)) {
    return { runCrypto: { mode: 'plain' }, recipientKeyEnvelopes: [] };
  }
  if (params.census && params.census.ownerAccountId !== params.accountId) throw new Error('workflow_run_key_owner_mismatch');
  const runDataKey = new Uint8Array(params.randomBytes(32));
  if (runDataKey.length !== 32) throw new Error('workflow_run_key_unavailable');
  const owner: WorkflowRunRecipientKeyEnvelopeV1 = {
    recipientAccountId: params.accountId,
    encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: runDataKey,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey(params.encryption)).publicKey,
      randomBytes: params.randomBytes })),
    recipientContentPublicKeyFingerprint: params.encryption.material.contentPublicKeyFingerprint,
  };
  const recipients = prepareResourceRecipientKeyEnvelopesV1({ dataKey: runDataKey,
    // A fresh Run/transition key requires fresh envelopes even for existing recipients.
    recipients: (params.census?.recipients ?? []).filter(item => item.recipientAccountId !== params.accountId)
      .map(item => ({ ...item, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null })),
    randomBytes: params.randomBytes });
  return { runCrypto: { mode: 'e2ee', runDataKey }, recipientKeyEnvelopes: [owner, ...recipients] };
}

/** Caller Account material opens only its envelope; content always binds the Run owner. */
export function resolveWorkflowRunDataKeyV1(params: Readonly<{
  encryption: WorkflowRunReadEncryptionV1;
  census: WorkflowRunRecipientCensusResponseV1;
}>): Readonly<{ kind: 'available'; encryption: WorkflowRunEncryptionV1 }>
  | Readonly<{ kind: 'unavailable'; reason: 'history_not_readable' | 'encryption_setup_required' | 'waiting_for_keys' }> {
  const { census } = params;
  if (census.encryptionMode !== census.ownerAccountCurrentness.mode) {
    return { kind: 'unavailable', reason: 'waiting_for_keys' };
  }
  if (census.encryptionMode === 'plain') {
    return { kind: 'available', encryption: { witness: census.ownerAccountCurrentness, runCrypto: { mode: 'plain' } } };
  }
  if (!census.dataEncryptionKey) return { kind: 'unavailable', reason: 'history_not_readable' };
  if (params.encryption.witness.mode !== 'e2ee' || !('material' in params.encryption)) return { kind: 'unavailable', reason: 'encryption_setup_required' };
  if (!census.callerDataEncryptionKey) return { kind: 'unavailable', reason: 'waiting_for_keys' };
  try {
    const envelope = decodeBase64(census.callerDataEncryptionKey);
    if (encodeBase64(envelope) !== census.callerDataEncryptionKey) return { kind: 'unavailable', reason: 'waiting_for_keys' };
    const runDataKey = openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: machineKey(params.encryption) });
    if (runDataKey) return { kind: 'available', encryption: { witness: census.ownerAccountCurrentness,
      runCrypto: { mode: 'e2ee', runDataKey } } };
  } catch { /* Malformed or unavailable recipient material stays locked. */ }
  return { kind: 'unavailable', reason: 'waiting_for_keys' };
}

/** Current key holders opportunistically fill the authorized audience through fenced commit. */
export async function runWorkflowRecipientKeyPreparationV1(params: Readonly<{
  runId: string;
  runCrypto: WorkflowRunDataKeyV1;
  openedDataEncryptionKey: string | null;
  randomBytes: (length: number) => Uint8Array;
  readCensus: () => Promise<WorkflowRunRecipientCensusResponseV1>;
  commit: (input: WorkflowRunRecipientKeyEnvelopeCommitInputV1) => Promise<WorkflowRunRecipientKeyEnvelopeCommitResponseV1>;
  signal?: AbortSignal;
}>): Promise<WorkflowRunRecipientKeyEnvelopeCommitResponseV1> {
  const empty = { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] };
  if (params.runCrypto.mode === 'plain') return empty;
  params.signal?.throwIfAborted();
  const census = await params.readCensus();
  params.signal?.throwIfAborted();
  if (census.runId !== params.runId || census.encryptionMode !== 'e2ee' || !census.dataEncryptionKey
    || !census.callerDataEncryptionKey || census.callerDataEncryptionKey !== params.openedDataEncryptionKey) {
    throw Object.assign(new Error('workflow_run_key_changed'), { code: 'currentness_conflict' });
  }
  const recipientKeyEnvelopes = prepareResourceRecipientKeyEnvelopesV1({ dataKey: params.runCrypto.runDataKey,
    recipients: census.recipients.filter(item => item.recipientAccountId !== census.ownerAccountId), randomBytes: params.randomBytes });
  if (!recipientKeyEnvelopes.length) return empty;
  params.signal?.throwIfAborted();
  return params.commit({ runId: params.runId, expectedDataEncryptionKey: census.dataEncryptionKey, recipientKeyEnvelopes });
}

export type WorkflowRunReadEncryptionV1 =
  | Readonly<{ witness: Readonly<{ mode: 'plain' }> }>
  | Readonly<{ witness: Readonly<{ mode: 'e2ee' }>; material: AccountScopedCryptoMaterialSnapshotV1 }>;
