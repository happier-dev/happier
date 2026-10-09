import {
  buildProjectLastOpenedMemoryKeyV1, parseProjectLastOpenedMemoryKeyV1,
  ProjectLastOpenedMemoryValueV1Schema,
} from '@happier-dev/protocol/account/authoringMemory';
import { importAuthoringMemoryRowAbsent } from '@happier-dev/protocol/account/authoringMemoryImport';
import type { StoredCredentials } from '@/persistence';
import { createAuthoringMemoryClient, type AuthoringMemoryClientInput } from '@/settings/authoringMemory/createAuthoringMemoryClient';

/** Bounded cutover only: normal Project renders and Open do not write recency. */
export async function retainProjectLastOpenedMemory(input: Readonly<{
  credentials: StoredCredentials; serverId: string; projectKey: string; lastOpenedAtMs: number; signal?: AbortSignal;
}>): Promise<void> {
  const key = buildProjectLastOpenedMemoryKeyV1({ serverId: input.serverId, projectKey: input.projectKey });
  const value = ProjectLastOpenedMemoryValueV1Schema.parse(input.lastOpenedAtMs);
  const client = await createAuthoringMemoryClient(input);
  await importAuthoringMemoryRowAbsent({ key, value, read: client.read, mutate: client.mutate, seal: client.seal,
    assertCurrent: () => input.signal?.throwIfAborted() });
  // An acknowledgement or a preexisting row is insufficient to retire the source:
  // reopen the committed destination, including a concurrent deletion or winner.
  const destination = await client.read(key);
  if (destination.status !== 'present' || ProjectLastOpenedMemoryValueV1Schema.parse(client.open(key, destination.content)) < value) {
    throw Object.assign(new Error('Retained Project recency is not present in Account memory'), { code: 'project_last_opened_memory_not_retained' });
  }
  input.signal?.throwIfAborted();
}

/** One Account list; canonical memory keys preserve qualified Home/Project rankings. */
export async function readProjectLastOpenedMemoryMap(input: AuthoringMemoryClientInput): Promise<ReadonlyMap<string, number>> {
  const client = await createAuthoringMemoryClient(input);
  const { rows } = await client.list();
  const rankings = new Map<string, number>();
  for (const row of rows) {
    if (!parseProjectLastOpenedMemoryKeyV1(row.key) || row.content === null) continue;
    if (rankings.has(row.key)) throw Object.assign(new Error('Duplicate Project recency row'), { code: 'project_last_opened_memory_duplicate' });
    rankings.set(row.key, ProjectLastOpenedMemoryValueV1Schema.parse(client.open(row.key, row.content)));
  }
  input.signal?.throwIfAborted();
  return rankings;
}
