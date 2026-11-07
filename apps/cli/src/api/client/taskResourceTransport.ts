import { createAccountKvCipher } from '@happier-dev/protocol/crypto/accountKvCipher';
import { createTaskResourceClientV1, type TaskResourceClientOptionsV1 } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import type { StoredCredentials } from '@/persistence';
import axios from './credentialAxios';
import { resolveCliAccountStorageContext, createCliAccountKvJsonCollectionTransport } from './accountKvJsonTransport';
import { decodeBase64, encodeBase64, getRandomBytes, encryptWithDataKey, decryptWithDataKeyResult } from '@/api/encryption';
import { openResourceDataKey } from '@/api/encryption/resourceDataKey';

export function createCliTaskResourceOptions(params: Readonly<{
  credentials: StoredCredentials; accountId: string; serverBaseUrl: string; requireCurrent: () => void; signal?: AbortSignal;
  resolveAuthorizationHeaders: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): TaskResourceClientOptionsV1 {
  const base = params.serverBaseUrl.replace(/\/+$/, '');
  const headers = (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    params.requireCurrent();
    const value = params.resolveAuthorizationHeaders(request);
    if (!value) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    return value;
  };
  const open = async (ciphertext: string, key: Uint8Array) => {
    const result = decryptWithDataKeyResult(decodeBase64(ciphertext), key);
    if (result.status !== 'authenticated') throw Object.assign(new Error('task_content_invalid'), { code: 'task_content_invalid' });
    return result.value;
  };
  const seal = async (value: unknown, key: Uint8Array) => encodeBase64(encryptWithDataKey(value, key));
  // This adapter lives for one captured Action; identity admission is shared across its rows.
  let identityAdmission: ReturnType<typeof resolveCliAccountStorageContext> | undefined;
  const accountCipher = async (usage: 'identity' | 'fresh-authority') => {
    const readContext = () => resolveCliAccountStorageContext({ credentials: params.credentials, serverBaseUrl: base,
      signal: params.signal, usage, shouldContinue: () => { params.requireCurrent(); return true; },
      authorizationHeaders: headers({ method: 'GET', path: '/v1/account/encryption/currentness' }) });
    const admitted = await (usage === 'identity' ? identityAdmission ??= readContext() : readContext());
    if (admitted.mode !== 'e2ee') throw Object.assign(new Error('task_encryption_mode_mismatch'), { code: 'task_encryption_mode_mismatch' });
    return createAccountKvCipher({ mode: 'e2ee', material: admitted.material, dataKeyCipher: key => ({ seal: value => seal(value, key),
      open: async ciphertext => decryptWithDataKeyResult(decodeBase64(ciphertext), key) }) });
  };
  return {
    accountId: params.accountId, requireCurrent: params.requireCurrent, signal: params.signal,
    openAccountRow: createCliAccountKvJsonCollectionTransport({ credentials: params.credentials, serverBaseUrl: base, signal: params.signal,
      shouldContinue: () => { params.requireCurrent(); return true; }, resolveAuthorizationHeaders: headers }).openRow,
    crypto: {
      randomBytes: getRandomBytes, open, seal,
      openAccount: async ciphertext => (await accountCipher('identity')).open(ciphertext),
      sealAccount: async value => (await accountCipher('fresh-authority')).seal(value),
      openKey: async dataEncryptionKey => (await openResourceDataKey({ credentials: params.credentials, mode: 'e2ee', dataEncryptionKey })).dataKey,
    },
    request: async request => {
      const response = await axios.request<unknown>({ method: request.method, url: `${base}${request.path}`, data: request.body,
        headers: headers(request), signal: params.signal, validateStatus: () => true });
      params.requireCurrent();
      return { status: response.status, body: response.data };
    },
  };
}
export function createCliTaskResourceClient(params: Parameters<typeof createCliTaskResourceOptions>[0]) {
  return createTaskResourceClientV1(createCliTaskResourceOptions(params));
}
