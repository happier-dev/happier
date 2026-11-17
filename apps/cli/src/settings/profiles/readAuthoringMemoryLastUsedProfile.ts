import { LastUsedProfileSchema } from '@happier-dev/protocol/account/authoringMemory';
import type { StoredCredentials } from '@/persistence';
import { createAuthoringMemoryClient } from '@/settings/authoringMemory/createAuthoringMemoryClient';

/** Read one canonical row under the Account's persisted mode and exact Home transport. */
export async function readAuthoringMemoryLastUsedProfile(credentials: StoredCredentials, signal?: AbortSignal): Promise<string | null> {
  const client = await createAuthoringMemoryClient({ credentials, signal });
  const row = await client.read('lastUsedProfile');
  return row.status === 'present' ? LastUsedProfileSchema.parse(client.open('lastUsedProfile', row.content)) : null;
}

/** Conditional clear after a successful Profile-settings commit; a newer choice wins. */
export async function clearAuthoringMemoryLastUsedProfileIfEqual(credentials: StoredCredentials, base: string, signal?: AbortSignal): Promise<void> {
  const client = await createAuthoringMemoryClient({ credentials, signal });
  while (true) {
    signal?.throwIfAborted();
    const row = await client.read('lastUsedProfile');
    if (row.status !== 'present' || LastUsedProfileSchema.parse(client.open('lastUsedProfile', row.content)) !== base) return;
    const mutation = await client.mutate('lastUsedProfile', row.revision, client.seal('lastUsedProfile', null));
    if (mutation.status === 'updated') return;
  }
}
