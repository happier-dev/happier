import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { internalTaskOwnerAccountIdV1, type TriageEntryRefV1 } from '../tasks/entryRefV1.js';
import { createTaskResourceClientV1, TaskResourceClientErrorV1, type TaskResourceClientOptionsV1 } from '../todos/taskResourceClientV1.js';
import type { DiscussionCreateRequestV1 } from './api.js';

export function sealDiscussionTaskWrappedKeyV1(discussionDataKey: Uint8Array, taskDataKey: Uint8Array,
  seal: TaskResourceClientOptionsV1['crypto']['seal']): Promise<string> {
  return seal(encodeBase64(discussionDataKey), taskDataKey);
}

export async function openDiscussionTaskWrappedKeyV1(wrappedDiscussionKey: string, taskDataKey: Uint8Array,
  open: TaskResourceClientOptionsV1['crypto']['open']): Promise<Uint8Array | null> {
  const value = await open(wrappedDiscussionKey, taskDataKey);
  return typeof value === 'string' && readCanonicalPaddedBase64DecodedLength(value) === ENCRYPTED_DATA_KEY_V1_BYTES
    ? decodeBase64(value) : null;
}

type PreparedTaskDiscussionKeyV1 = Readonly<{ mode: 'plain'; dataKey: null; taskKey?: undefined }>
  | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array; taskKey: NonNullable<DiscussionCreateRequestV1['taskKey']> }>;

export async function prepareTaskDiscussionKeyV1(ref: TriageEntryRefV1,
  options: TaskResourceClientOptionsV1): Promise<PreparedTaskDiscussionKeyV1> {
  const ownerAccountId = internalTaskOwnerAccountIdV1(ref, options.accountId);
  if (!ownerAccountId) throw new TaskResourceClientErrorV1('task_not_found');
  const client = createTaskResourceClientV1(options);
  const task = await client.read({ ownerAccountId, taskId: ref.entryId });
  if (task.resource.encryptionMode === 'plain') return { mode: 'plain', dataKey: null };

  const prepared = task.dataKey === null ? await client.preparePromotion(task) : null;
  const taskDataKey = prepared?.dataKey ?? task.dataKey;
  if (!taskDataKey) throw new TaskResourceClientErrorV1('resource_encryption_material_unavailable');
  const dataKey = options.crypto.randomBytes(ENCRYPTED_DATA_KEY_V1_BYTES);
  try {
    const wrappedDiscussionKey = await sealDiscussionTaskWrappedKeyV1(dataKey, taskDataKey, options.crypto.seal);
    return { mode: 'e2ee', dataKey, taskKey: { wrappedDiscussionKey,
      ...(prepared ? { promotion: prepared.promotion } : {}) } };
  } finally { taskDataKey.fill(0); }
}
