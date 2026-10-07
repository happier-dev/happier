import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1, AUTHORING_MEMORY_ROUTE_V1, StoredAuthoringMemoryPrivatePayloadV1Schema, AuthoringMemoryReadResponseV1Schema, AuthoringMemoryMutationResponseV1Schema, assertAuthoringMemoryContentForModeV1 } from '@happier-dev/protocol/account/authoringMemory';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { LegacyLastUsedProfileSchema } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { importAuthoringMemoryRowAbsent, importLegacyAuthoringMemorySetting } from '@happier-dev/protocol/account/authoringMemoryImport';
import type { AuthoringMemoryReadResponseV1, AuthoringMemoryContentV1 } from '@happier-dev/protocol';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import type { StoredCredentials } from '@/persistence';
import { requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import {
  requireAccountSettingsMutationSuccess,
  updateAccountSettingsV2Once,
  readAccountSettingsV2RawForLegacyAuthoringMemoryImport,
  type AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

class AuthoringMemoryReadUnavailableError extends Error {
  readonly code = 'authoring_memory_unavailable';
  constructor() { super('Account authoring memory is unavailable'); this.name = 'AuthoringMemoryReadUnavailableError'; }
}

/** Read one canonical row under the Account's persisted mode and exact Home transport. */
export async function readAuthoringMemoryLastUsedProfile(credentials: StoredCredentials, signal?: AbortSignal): Promise<string | null> {
  const { baseUrl, options, accountMode, openProfile, sealProfile } = await createProfileRowContext(credentials, signal);
  const rowUrl = `${baseUrl}${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`;
  async function readRow(): Promise<AuthoringMemoryReadResponseV1> {
    const response = await axios.get(rowUrl, options);
    if (response.status < 200 || response.status >= 300) throw new AuthoringMemoryReadUnavailableError();
    const parsed = AuthoringMemoryReadResponseV1Schema.safeParse(response.data);
    if (!parsed.success) throw new AuthoringMemoryReadUnavailableError();
    return parsed.data;
  }
  let row = await readRow();
  openProfile(row);
  // Bind the importer to the same exact Home, credentials and persisted mode as
  // its destination. The incumbent Settings owner still opens and validates it.
  const settingsDeps: AccountSettingsUpdateV2Deps = {
    resolveAccountEncryptionMode: async () => accountMode,
    fetchSettings: async () => {
      const response = await axios.get(`${baseUrl}/v2/account/settings`, options);
      if (response.status < 200 || response.status >= 300) throw new AuthoringMemoryReadUnavailableError();
      return AccountSettingsV2GetResponseSchema.parse(response.data);
    },
    updateSettings: async (body) => {
      const response = await axios.post(`${baseUrl}/v2/account/settings`, body, options);
      if ((response.status < 200 || response.status >= 300) && response.status !== 409) throw new AuthoringMemoryReadUnavailableError();
      return AccountSettingsV2UpdateResponseSchema.parse(response.data);
    },
  };
  await importLegacyAuthoringMemorySetting({
    key: 'lastUsedProfile', assertCurrent: () => signal?.throwIfAborted(),
    read: () => readAccountSettingsV2RawForLegacyAuthoringMemoryImport({ credentials, signal, deps: settingsDeps }),
    transfer: async (value) => {
      row = await importAuthoringMemoryRowAbsent({
        key: 'lastUsedProfile', value: LegacyLastUsedProfileSchema.parse(value),
        assertCurrent: () => signal?.throwIfAborted(), read: readRow,
        seal: (_key, value) => sealProfile(LegacyLastUsedProfileSchema.parse(value)),
        mutate: async (_key, expectedRevision, content) => {
          const response = await axios.post(rowUrl, { expectedRevision, content }, options);
          if ((response.status < 200 || response.status >= 300) && response.status !== 409) throw new AuthoringMemoryReadUnavailableError();
          return AuthoringMemoryMutationResponseV1Schema.parse(response.data);
        },
      });
      openProfile(row);
    },
    remove: async (key, expectedVersion) => {
      const result = await updateAccountSettingsV2Once({ credentials, signal, deps: settingsDeps,
        expectedVersion, retireLegacyAuthoringMemoryKey: key, mutate: (settings) => settings });
      if (result.status === 'conflict' || result.status === 'outcomeUnknown') return result.status;
      requireAccountSettingsMutationSuccess(result);
      return 'applied';
    },
  });
  return openProfile(row);
}

/** Conditional clear after a successful Profile-settings commit; a newer choice wins. */
export async function clearAuthoringMemoryLastUsedProfileIfEqual(credentials: StoredCredentials, base: string, signal?: AbortSignal): Promise<void> {
  const { baseUrl, options, openProfile, sealProfile } = await createProfileRowContext(credentials, signal);
  const rowUrl = `${baseUrl}${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`;
  while (true) {
    signal?.throwIfAborted();
    const response = await axios.get(rowUrl, options);
    if (response.status < 200 || response.status >= 300) throw new AuthoringMemoryReadUnavailableError();
    const row = AuthoringMemoryReadResponseV1Schema.parse(response.data);
    if (row.status !== 'present' || openProfile(row) !== base) return;
    const result = await axios.post(rowUrl, { expectedRevision: row.revision, content: sealProfile(null) }, options);
    if ((result.status < 200 || result.status >= 300) && result.status !== 409) throw new AuthoringMemoryReadUnavailableError();
    const mutation = AuthoringMemoryMutationResponseV1Schema.parse(result.data);
    if (mutation.status === 'updated') return;
  }
}

async function createProfileRowContext(credentials: StoredCredentials, signal?: AbortSignal) {
  const baseUrl = resolveAccountSettingsHttpBaseUrl();
  const options = {
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` },
    validateStatus: () => true,
    ...(signal ? { signal } : {}),
  };
  const mode = await readAccountEncryptionModeOnce({ request: () => axios.get(`${baseUrl}/v1/account/encryption`, options) });
  if (mode.kind !== 'resolved') throw new AuthoringMemoryReadUnavailableError();
  const accountMode = mode.mode;
  return { baseUrl, options, accountMode, openProfile, sealProfile };

  function sealProfile(value: string | null): AuthoringMemoryContentV1 {
    if (accountMode === 'plain') return { t: 'plain', v: value };
    return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1, material: resolveMaterial(),
      payload: { key: 'lastUsedProfile', value }, randomBytes: (length) => new Uint8Array(randomBytes(length)),
    }) };
  }

  function openProfile(row: AuthoringMemoryReadResponseV1): string | null {
    if (row.status !== 'present') return null;
    const content = assertAuthoringMemoryContentForModeV1(row.content, accountMode);
    if (content.t === 'plain') return LegacyLastUsedProfileSchema.parse(content.v);
    const opened = openAccountScopedBlobCiphertext({
      kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: resolveMaterial(), ciphertext: content.c,
    });
    const payload = StoredAuthoringMemoryPrivatePayloadV1Schema.safeParse(opened?.value);
    if (!payload.success || payload.data.key !== 'lastUsedProfile') throw new AuthoringMemoryReadUnavailableError();
    return LegacyLastUsedProfileSchema.parse(payload.data.value);
  }

  function resolveMaterial() {
    const encryption = requireAccountSettingsEncryptionCredentials(credentials).encryption;
    return encryption.type === 'legacy'
      ? { type: 'legacy' as const, secret: encryption.secret }
      : { type: 'dataKey' as const, machineKey: encryption.machineKey };
  }
}
