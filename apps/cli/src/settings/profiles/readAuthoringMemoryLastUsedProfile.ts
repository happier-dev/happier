import axios from 'axios';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { LegacyLastUsedProfileSchema } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { importAuthoringMemoryRowAbsent, importLegacyAuthoringMemorySetting } from '@happier-dev/protocol/account/authoringMemoryImport';
import type { AuthoringMemoryReadResponseV1 } from '@happier-dev/protocol/account/authoringMemory';
import type { StoredCredentials } from '@/persistence';
import { createAuthoringMemoryClient, AuthoringMemoryReadUnavailableError } from '@/settings/authoringMemory/createAuthoringMemoryClient';
import {
  requireAccountSettingsMutationSuccess,
  updateAccountSettingsV2Once,
  readAccountSettingsV2RawForLegacyAuthoringMemoryImport,
  type AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

/** Read one canonical row under the Account's persisted mode and exact Home transport. */
export async function readAuthoringMemoryLastUsedProfile(credentials: StoredCredentials, signal?: AbortSignal): Promise<string | null> {
  const client = await createAuthoringMemoryClient({ credentials, signal });
  const { baseUrl, options, accountMode } = client;
  const readRow = () => client.read('lastUsedProfile');
  const openProfile = (row: AuthoringMemoryReadResponseV1) => row.status === 'present'
    ? LegacyLastUsedProfileSchema.parse(client.open('lastUsedProfile', row.content)) : null;
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
        seal: (_key, value) => client.seal('lastUsedProfile', LegacyLastUsedProfileSchema.parse(value)),
        mutate: client.mutate,
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
  const client = await createAuthoringMemoryClient({ credentials, signal });
  while (true) {
    signal?.throwIfAborted();
    const row = await client.read('lastUsedProfile');
    if (row.status !== 'present' || LegacyLastUsedProfileSchema.parse(client.open('lastUsedProfile', row.content)) !== base) return;
    const mutation = await client.mutate('lastUsedProfile', row.revision, client.seal('lastUsedProfile', null));
    if (mutation.status === 'updated') return;
  }
}
