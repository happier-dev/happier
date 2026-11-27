import { openDiscussionTaskWrappedKeyV1 } from '@happier-dev/protocol/discussions/taskKeys';
import type { DiscussionSummaryV1 } from '@happier-dev/protocol/discussions/models';
import type { DiscussionCreateRequestV1 } from '@happier-dev/protocol/discussions/api';
import { internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { createCliTaskResourceClient } from '@/api/client/taskResourceTransport';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { decodeBase64, decryptWithDataKeyResult } from '@/api/encryption';
import { openResourceDataKey, ResourceDataKeyUnavailableError, type ResourceDataKey } from '@/api/encryption/resourceDataKey';
import type { StoredCredentials } from '@/persistence';

export async function openCliDiscussionTaskKey(credentials: StoredCredentials, wrappedDiscussionKey: string,
  encryptedTaskKey: string): Promise<ResourceDataKey> {
  const task = await openResourceDataKey({ credentials, mode: 'e2ee', dataEncryptionKey: encryptedTaskKey });
  if (task.mode !== 'e2ee') throw new ResourceDataKeyUnavailableError();
  return openUsingTaskKey(wrappedDiscussionKey, task.dataKey);
}

async function openUsingTaskKey(wrappedDiscussionKey: string, taskDataKey: Uint8Array): Promise<ResourceDataKey> {
  try {
    const dataKey = await openDiscussionTaskWrappedKeyV1(wrappedDiscussionKey, taskDataKey, async (ciphertext, key) => {
      const result = decryptWithDataKeyResult(decodeBase64(ciphertext), key);
      return result.status === 'authenticated' ? result.value : null;
    });
    if (!dataKey) throw new ResourceDataKeyUnavailableError();
    return { mode: 'e2ee', dataKey, dataEncryptionKey: wrappedDiscussionKey };
  } finally { taskDataKey.fill(0); }
}

export async function openCliDiscussionKey(credentials: StoredCredentials,
  row: Pick<DiscussionSummaryV1, 'encryptionMode' | 'dataEncryptionKey' | 'taskKey'>): Promise<ResourceDataKey> {
  if (row.taskKey) {
    if (row.encryptionMode !== 'e2ee' || row.dataEncryptionKey !== null) throw new ResourceDataKeyUnavailableError();
    return openCliDiscussionTaskKey(credentials, row.taskKey.wrappedDiscussionKey, row.taskKey.encryptedTaskKey);
  }
  return openResourceDataKey({ credentials, mode: row.encryptionMode, dataEncryptionKey: row.dataEncryptionKey });
}

/** The admitted Session publisher verifies the supplied ciphertext before relaying it. */
export async function openCliDiscussionCreationKey({ credentials, serverUrl, request, signal }: Readonly<{
  credentials: StoredCredentials; serverUrl: string; request: DiscussionCreateRequestV1; signal?: AbortSignal;
}>): Promise<ResourceDataKey> {
  const { anchor, taskKey, dataEncryptionKey } = request;
  if (!taskKey) return openResourceDataKey({ credentials, mode: request.titleContent.t === 'plain' ? 'plain' : 'e2ee',
    dataEncryptionKey: dataEncryptionKey ?? null });
  if (anchor?.kind !== 'task' || !isInternalTaskReferenceV1(anchor.entry)) throw new ResourceDataKeyUnavailableError();
  const accountId = readAccountIdFromToken(credentials.token);
  const ownerAccountId = accountId && internalTaskOwnerAccountIdV1(anchor.entry, accountId);
  if (!accountId || !ownerAccountId) throw new ResourceDataKeyUnavailableError();
  if (taskKey.promotion) {
    return openCliDiscussionTaskKey(credentials, taskKey.wrappedDiscussionKey, taskKey.promotion.ownerKeyEnvelope.encryptedDataKey);
  }
  const client = createCliTaskResourceClient({ credentials, accountId, serverBaseUrl: serverUrl, signal,
    requireCurrent: () => signal?.throwIfAborted(), resolveAuthorizationHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }) });
  const task = await client.read({ ownerAccountId, taskId: anchor.entry.entryId });
  if (!task.dataKey) throw new ResourceDataKeyUnavailableError();
  return openUsingTaskKey(taskKey.wrappedDiscussionKey, task.dataKey);
}
