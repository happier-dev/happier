import { createTaskResourceClientV1, TaskResourceClientErrorV1, type TaskResourceClientOptionsV1 } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createUiTaskResourceCrypto, type TaskResourceEncryption } from '@/sync/encryption/taskResourceCrypto';
import { createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveTodoAccountStorageContext } from './todoOps';
import { createUiAccountKvCipher } from '@/sync/encryption/accountKvCipher';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { openUiAccountKvJsonRow } from '@/sync/ops/account/accountKvJsonTransport';

export function createUiTaskResourceOptions(args: Readonly<{
  credentials: AuthCredentials; accountId: string; serverId: string; request: ServerFetch; requireCurrent: () => void; signal?: AbortSignal;
  resolveEncryption?: () => Promise<TaskResourceEncryption | null>;
}>): TaskResourceClientOptionsV1 {
  const crypto = createUiTaskResourceCrypto(args.resolveEncryption ?? getSyncSingleton()?.encryption ?? null,
    { serverId: args.serverId, accountId: args.accountId });
  // Hosts construct this adapter for one captured Action/refresh, sharing its identity read across rows.
  let identityAdmission: ReturnType<typeof resolveTodoAccountStorageContext> | undefined;
  const accountCipher = async (usage: 'identity' | 'fresh-authority') => {
    args.requireCurrent();
    const readContext = () => resolveTodoAccountStorageContext(args.credentials, { request: args.request, usage });
    const context = await (usage === 'identity' ? identityAdmission ??= readContext() : readContext());
    args.requireCurrent();
    if (context.mode !== 'e2ee') throw new TaskResourceClientErrorV1('task_encryption_mode_mismatch');
    return context;
  };
  return {
    accountId: args.accountId, requireCurrent: args.requireCurrent, signal: args.signal,
    openAccountRow: async row => openUiAccountKvJsonRow({ credentials: args.credentials, row,
      context: await accountCipher('identity'), request: args.request, requireCurrent: args.requireCurrent }),
    crypto: { ...crypto,
      openAccount: async ciphertext => { await accountCipher('identity'); return createUiAccountKvCipher('e2ee', resolveAccountScopedCryptoMaterialFromCredentials(args.credentials)).open(ciphertext); },
      sealAccount: async value => { await accountCipher('fresh-authority'); return crypto.sealAccount(value); },
    },
    request: async ({ method, path, body }) => {
      args.requireCurrent();
      const response = await args.request(path, { method, headers: { Authorization: `Bearer ${args.credentials.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(args.signal ? { signal: args.signal } : {}) }, { retry: 'none' });
      const value: unknown = await response.json();
      args.requireCurrent();
      return { status: response.status, body: value };
    },
  };
}
export function createUiTaskResourceClient(args: Parameters<typeof createUiTaskResourceOptions>[0]) {
  return createTaskResourceClientV1(createUiTaskResourceOptions(args));
}

/**
 * The owner's later-member Task key repair on the membership-change wake: the shared owed loop over the
 * Task owed census. A Home without Task resources has nothing to repair; every other failure reaches the
 * wake's own error path.
 */
export async function prepareOwedTaskKeys(args: Readonly<{
  credentials: AuthCredentials; accountId: string; serverId: string; isCurrent: () => boolean;
}>): Promise<void> {
  const request = createServerFetchForActiveServer(undefined, { credentials: args.credentials, isCurrent: args.isCurrent });
  const requireCurrent = () => { if (!args.isCurrent()) throw new TaskResourceClientErrorV1('account_currentness_unavailable', 'failed'); };
  try {
    await createUiTaskResourceClient({ credentials: args.credentials, accountId: args.accountId, serverId: args.serverId,
      request, requireCurrent }).prepareOwed();
  } catch (error) {
    if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported') throw error;
  }
}
