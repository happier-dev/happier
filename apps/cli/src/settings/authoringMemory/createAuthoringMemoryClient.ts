import axios, { type AxiosRequestConfig } from 'axios';
import { randomBytes } from 'node:crypto';
import {
  AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1, AUTHORING_MEMORY_ROUTE_V1,
  AuthoringMemoryKeyV1Schema, AuthoringMemoryReadResponseV1Schema,
  AuthoringMemoryListResponseV1Schema, AuthoringMemoryMutationRequestV1Schema,
  AuthoringMemoryMutationResponseV1Schema, StoredAuthoringMemoryPrivatePayloadV1Schema,
  assertAuthoringMemoryContentForModeV1, assertAuthoringMemoryValueForKeyV1,
  type AuthoringMemoryContentV1, type AuthoringMemoryValueV1,
  type AuthoringMemoryReadResponseV1, type AuthoringMemoryListResponseV1, type AuthoringMemoryMutationResponseV1,
} from '@happier-dev/protocol/account/authoringMemory';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import type { StoredCredentials } from '@/persistence';
import {
  AccountSettingsEncryptionMaterialUnavailableError,
  hasUsableAccountSettingsEncryptionMaterial,
  requireAccountSettingsEncryptionCredentials,
} from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

export class AuthoringMemoryReadUnavailableError extends Error {
  readonly code = 'authoring_memory_unavailable';
  constructor() { super('Account authoring memory is unavailable'); this.name = 'AuthoringMemoryReadUnavailableError'; }
}

export type AuthoringMemoryClient = Readonly<{
  baseUrl: string;
  options: AxiosRequestConfig;
  accountMode: 'plain' | 'e2ee';
  read(key: string): Promise<AuthoringMemoryReadResponseV1>;
  list(): Promise<AuthoringMemoryListResponseV1>;
  mutate(key: string, expectedRevision: number | 'absent', content: AuthoringMemoryContentV1 | null): Promise<AuthoringMemoryMutationResponseV1>;
  open(key: string, content: AuthoringMemoryContentV1): AuthoringMemoryValueV1;
  seal(key: string, value: AuthoringMemoryValueV1): AuthoringMemoryContentV1;
}>;

/** The incumbent Account-mode codec, also usable by already-admitted private custody. */
export function createAuthoringMemoryRowCipher(input: Readonly<{
  accountMode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
}>): Pick<AuthoringMemoryClient, 'open' | 'seal'> {
  return {
    open: (key, raw) => {
      AuthoringMemoryKeyV1Schema.parse(key);
      const content = assertAuthoringMemoryContentForModeV1(raw, input.accountMode, key);
      if (content.t === 'plain') return assertAuthoringMemoryValueForKeyV1(key, content.v);
      if (!input.material) throw new AuthoringMemoryReadUnavailableError();
      const opened = openAccountScopedBlobCiphertext({ kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1,
        material: input.material, ciphertext: content.c });
      const payload = StoredAuthoringMemoryPrivatePayloadV1Schema.safeParse(opened?.value);
      if (!payload.success || payload.data.key !== key) throw new AuthoringMemoryReadUnavailableError();
      return assertAuthoringMemoryValueForKeyV1(key, payload.data.value);
    },
    seal: (key, value) => {
      const validated = assertAuthoringMemoryValueForKeyV1(key, value);
      if (input.accountMode === 'plain') return { t: 'plain', v: validated };
      if (!input.material) throw new AuthoringMemoryReadUnavailableError();
      return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material,
        payload: { key, value: validated }, randomBytes: length => new Uint8Array(randomBytes(length)),
      }) };
    },
  };
}

/** One transport and cipher owner, bound to the current Account's exact Home and persisted mode. */
export type AuthoringMemoryClientInput = Readonly<({ credentials: StoredCredentials; authorization?: never; effectActionId?: never }
  | { credentials?: never; authorization: ExternalActionExecutionAuthorizationV1; effectActionId: string }) & { signal?: AbortSignal }>;
export async function createAuthoringMemoryClient(input: AuthoringMemoryClientInput): Promise<AuthoringMemoryClient> {
  input.signal?.throwIfAborted();
  const account = input.authorization?.requesterAccountProjection;
  const http = input.authorization?.requesterHttpProjection;
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    if (input.authorization && (!account?.authoringMemoryRowCipher || !http
      || account.accountId !== input.authorization.binding.accountId || http.accountId !== account.accountId
      || account.serverId !== http.serverId
      || http.accountEncryptionMode !== undefined && account.accountEncryptionMode !== http.accountEncryptionMode
      || !await account.isCurrent() || !await http.isCurrent())) throw new AuthoringMemoryReadUnavailableError();
  };
  await assertCurrent();
  const baseUrl = http?.serverHttpBaseUrl ?? resolveAccountSettingsHttpBaseUrl();
  const options: AxiosRequestConfig = {
    ...(!input.authorization ? { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` } } : {}),
    validateStatus: () => true,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const mode = account ? { kind: 'resolved' as const, mode: account.accountEncryptionMode }
    : await readAccountEncryptionModeOnce({ request: () => axios.get(`${baseUrl}/v1/account/encryption`, options) });
  if (mode.kind !== 'resolved') throw new AuthoringMemoryReadUnavailableError();
  const accountMode = mode.mode;
  if (!input.authorization && accountMode === 'e2ee' && !hasUsableAccountSettingsEncryptionMaterial(input.credentials)) {
    throw new AccountSettingsEncryptionMaterialUnavailableError();
  }
  const encryption = !input.authorization && accountMode === 'e2ee' ? requireAccountSettingsEncryptionCredentials(input.credentials).encryption : null;
  const material = encryption === null ? null : encryption.type === 'legacy'
    ? { type: 'legacy' as const, secret: encryption.secret }
    : { type: 'dataKey' as const, machineKey: encryption.machineKey };
  const cipher = account?.authoringMemoryRowCipher ?? createAuthoringMemoryRowCipher({ accountMode, material });
  const requestOptions = async (method: string, path: string, body?: unknown): Promise<AxiosRequestConfig> => {
    await assertCurrent();
    if (!input.authorization) return options;
    const headers = await http!.createRequestHeaders({ effectActionId: input.effectActionId, method, path,
      ...(body === undefined ? {} : { body }), ...(input.signal ? { signal: input.signal } : {}) });
    if (!headers) throw new AuthoringMemoryReadUnavailableError();
    return { ...options, headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers } };
  };
  const rowPath = (key: string) => `${AUTHORING_MEMORY_ROUTE_V1}/${encodeURIComponent(AuthoringMemoryKeyV1Schema.parse(key))}`;
  const rowUrl = (key: string) => `${baseUrl}${AUTHORING_MEMORY_ROUTE_V1}/${encodeURIComponent(AuthoringMemoryKeyV1Schema.parse(key))}`;
  return {
    baseUrl, options, accountMode,
    read: async (key: string) => {
      input.signal?.throwIfAborted();
      const response = await axios.get(rowUrl(key), await requestOptions('GET', rowPath(key)));
      requireStatus(response.status);
      const parsed = AuthoringMemoryReadResponseV1Schema.safeParse(response.data);
      if (!parsed.success) throw new AuthoringMemoryReadUnavailableError();
      await assertCurrent();
      return parsed.data;
    },
    list: async () => {
      input.signal?.throwIfAborted();
      const response = await axios.get(`${baseUrl}${AUTHORING_MEMORY_ROUTE_V1}`, await requestOptions('GET', AUTHORING_MEMORY_ROUTE_V1));
      requireStatus(response.status);
      const parsed = AuthoringMemoryListResponseV1Schema.safeParse(response.data);
      if (!parsed.success) throw new AuthoringMemoryReadUnavailableError();
      await assertCurrent();
      return parsed.data;
    },
    mutate: async (key: string, expectedRevision: number | 'absent', content: AuthoringMemoryContentV1 | null) => {
      input.signal?.throwIfAborted();
      if (content !== null) cipher.open(key, content);
      const request = AuthoringMemoryMutationRequestV1Schema.parse({ expectedRevision, content });
      const response = await axios.post(rowUrl(key), request, await requestOptions('POST', rowPath(key), request));
      requireStatus(response.status, true);
      return AuthoringMemoryMutationResponseV1Schema.parse(response.data);
    },
    ...cipher,
  };
}

function requireStatus(status: number, conflictAllowed = false): void {
  if ((status < 200 || status >= 300) && !(conflictAllowed && status === 409)) throw new AuthoringMemoryReadUnavailableError();
}
