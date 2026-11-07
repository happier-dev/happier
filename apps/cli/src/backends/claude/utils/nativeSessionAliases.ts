import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeSessionAliasAssignmentV1 } from '@happier-dev/protocol';
import { parseNativeSessionAliasRegistration } from '@/session/metadata/nativeSessionAliases';

/** Numeric registration documents only: sibling key/credential files are never opened. */
export async function readClaudeNativeSessionAliases(params: Readonly<{
  configDir: string;
  sessionId: string;
  observedAt: number;
}>): Promise<NativeSessionAliasAssignmentV1[]> {
  const directory = join(params.configDir, 'sessions');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const assignments: NativeSessionAliasAssignmentV1[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9]+\.json$/.test(entry.name)) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
    } catch (error) {
      // Registrations are mutable and may disappear or be observed during a write.
      if (error instanceof SyntaxError || (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) continue;
      throw error;
    }
    // Only an explicit nameSince proves assignment time. startedAt is not a rename timestamp.
    const assignment = parseNativeSessionAliasRegistration(value, 'claude', params.observedAt);
    if (assignment?.providerSessionId === params.sessionId) assignments.push(assignment);
  }
  return assignments;
}
