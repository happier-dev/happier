import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SessionInitialAccessDraftV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol';
import {
  consumeProtectedLocalStateFile,
  createProtectedLocalStateFileExclusive,
  ensureProtectedLocalStateDirectory,
  removeProtectedLocalStateFile,
} from '@/utils/fs/protectedLocalState';

/** Ephemeral launch custody; platform protection belongs to protectedLocalState. */
export async function createSessionInitialAccessFile(
  happyHomeDir: string,
  initialAccess: SessionInitialAccessDraftV1,
): Promise<Readonly<{ path: string; cleanup: () => Promise<void> }>> {
  const contents = JSON.stringify(SessionInitialAccessDraftV1Schema.parse(initialAccess));
  const directory = join(happyHomeDir, 'session-initial-access');
  await ensureProtectedLocalStateDirectory(directory, { authority: 'owned' });
  const path = join(directory, `${randomUUID()}.json`);
  await createProtectedLocalStateFileExclusive(path, contents);
  return {
    path,
    cleanup: async () => {
      try {
        await removeProtectedLocalStateFile(path);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    },
  };
}

export async function consumeSessionInitialAccessFile(path: string): Promise<SessionInitialAccessDraftV1> {
  // Remove before parsing so malformed drafts cannot linger or be retried.
  const contents = await consumeProtectedLocalStateFile(path);
  return SessionInitialAccessDraftV1Schema.parse(JSON.parse(contents));
}
