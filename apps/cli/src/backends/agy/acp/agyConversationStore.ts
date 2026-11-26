import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { importConnectedServiceSessionFiles } from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';
import { AGY_APP_DATA_DIR } from './agyAcpLaunch';

/** Conversation store written by the retired `agy_acp_server` (0.2.21 and earlier). */
const LEGACY_APP_DATA_DIR = 'antigravity-acp';

export type AgyConversationLocation = 'native' | 'legacy' | 'missing';

function isSafeConversationId(id: string): boolean {
  return Boolean(id) && !/[\\/]/.test(id) && id !== '.' && id !== '..';
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function conversationDatabase(profileDir: string, appDataDir: string, id: string): string {
  return join(profileDir, appDataDir, 'conversations', `${id}.db`);
}

/** Where a conversation can be loaded from in a `--gemini-dir` profile; a legacy one must be imported first. */
export async function locateAgyConversation(profileDir: string, conversationId: string): Promise<Readonly<{
  location: AgyConversationLocation;
  path: string | null;
}>> {
  const id = conversationId.trim();
  if (!isSafeConversationId(id)) return { location: 'missing', path: null };
  const native = conversationDatabase(profileDir, AGY_APP_DATA_DIR, id);
  if (await isFile(native)) return { location: 'native', path: native };
  const legacy = conversationDatabase(profileDir, LEGACY_APP_DATA_DIR, id);
  if (await isFile(legacy)) return { location: 'legacy', path: legacy };
  return { location: 'missing', path: null };
}

/**
 * Copy a conversation the retired server created into the CLI store so `agy acp` can list and load it
 * under the same id. Sources stay in place; a conversation the CLI already has is never overwritten.
 */
export async function importLegacyAgyConversation(profileDir: string, conversationId: string): Promise<boolean> {
  const id = conversationId.trim();
  if ((await locateAgyConversation(profileDir, id)).location !== 'legacy') return false;
  const legacy = join(profileDir, LEGACY_APP_DATA_DIR);
  const native = join(profileDir, AGY_APP_DATA_DIR);
  // The database's SQLite sidecars and the `.meta` file travel with it.
  const conversationFiles = new Set([`${id}.db`, `${id}.db-wal`, `${id}.db-shm`, `${id}.meta`]);
  await importConnectedServiceSessionFiles({ roots: [
    {
      sourceRoot: join(legacy, 'conversations'),
      destinationRoot: join(native, 'conversations'),
      includeDirectory: () => false,
      includeFile: (relativePath) => conversationFiles.has(relativePath),
    },
    { sourceRoot: join(legacy, 'brain', id), destinationRoot: join(native, 'brain', id) },
  ] });
  return true;
}
