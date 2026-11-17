import {
  parseProjectLastOpenedMemoryKeyV1,
  ProjectLastOpenedMemoryValueV1Schema,
} from '@happier-dev/protocol/account/authoringMemory';
import { createAuthoringMemoryClient, type AuthoringMemoryClientInput } from '@/settings/authoringMemory/createAuthoringMemoryClient';

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
