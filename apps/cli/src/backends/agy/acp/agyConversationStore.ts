import { realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Profiles whose retired-server store may hold the conversation: the profile itself and, when its CLI
 * conversations are shared with another profile (a connected account linked to the machine login),
 * that profile. Released connected homes linked the retired store too; materialization detaches those
 * links, so the shared profile is found through the CLI store link instead.
 */
async function listLegacyProfiles(profileDir: string): Promise<string[]> {
  try {
    const shared = dirname(dirname(await realpath(join(profileDir, AGY_APP_DATA_DIR, 'conversations'))));
    return resolve(shared) === resolve(await realpath(profileDir)) ? [profileDir] : [profileDir, shared];
  } catch {
    return [profileDir];
  }
}

/** Where a conversation can be loaded from in a `--gemini-dir` profile; a legacy one must be imported first. */
export async function locateAgyConversation(profileDir: string, conversationId: string): Promise<Readonly<{
  location: AgyConversationLocation;
  path: string | null;
  legacyProfileDir?: string;
}>> {
  const id = conversationId.trim();
  if (!isSafeConversationId(id)) return { location: 'missing', path: null };
  const native = conversationDatabase(profileDir, AGY_APP_DATA_DIR, id);
  if (await isFile(native)) return { location: 'native', path: native };
  for (const legacyProfileDir of await listLegacyProfiles(profileDir)) {
    const legacy = conversationDatabase(legacyProfileDir, LEGACY_APP_DATA_DIR, id);
    if (await isFile(legacy)) return { location: 'legacy', path: legacy, legacyProfileDir };
  }
  return { location: 'missing', path: null };
}

/**
 * Copy a conversation the retired server created into the CLI store so `agy acp` can list and load it
 * under the same id. Sources stay in place; a conversation the CLI already has is never overwritten.
 */
export async function importLegacyAgyConversation(profileDir: string, conversationId: string): Promise<boolean> {
  const id = conversationId.trim();
  const conversation = await locateAgyConversation(profileDir, id);
  if (conversation.location !== 'legacy' || !conversation.legacyProfileDir) return false;
  const legacy = join(conversation.legacyProfileDir, LEGACY_APP_DATA_DIR);
  const native = join(profileDir, AGY_APP_DATA_DIR);
  // Without its `.db` the CLI copy is an interrupted import, never a conversation the CLI continued:
  // discard it so the retry copies one consistent set instead of keeping stale files at their names.
  await Promise.all([
    ...[`${id}.db-wal`, `${id}.db-shm`, `${id}.meta`].map((name) => rm(join(native, 'conversations', name), { force: true })),
    rm(join(native, 'brain', id), { recursive: true, force: true }),
  ]);
  const conversations = { sourceRoot: join(legacy, 'conversations'), destinationRoot: join(native, 'conversations'), includeDirectory: () => false };
  // The CLI store counts a conversation as present once its `.db` exists, so the database is copied
  // last (each file lands atomically): an interrupted import leaves no `.db` and is retried next time.
  const sidecars = new Set([`${id}.db-wal`, `${id}.db-shm`, `${id}.meta`]);
  await importConnectedServiceSessionFiles({ roots: [
    { ...conversations, includeFile: (relativePath) => sidecars.has(relativePath) },
    { sourceRoot: join(legacy, 'brain', id), destinationRoot: join(native, 'brain', id) },
  ] });
  await importConnectedServiceSessionFiles({ roots: [
    { ...conversations, includeFile: (relativePath) => relativePath === `${id}.db` },
  ] });
  return true;
}
