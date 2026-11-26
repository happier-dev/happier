import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import { ANTIGRAVITY_APP_DATA_DIR } from '../install/cliRuntime.js';
import { isSafeAntigravityConversationId } from '../cliPrint/conversationStore.js';

/** Store written by the retired 1.3.0 ACP server; read only to adopt its conversations. */
const LEGACY_APP_DATA_DIR = 'antigravity-acp';

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (!await exists(source)) return;
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/**
 * Native agy reads and continues conversations the retired server wrote once they
 * sit in its own store, keeping the same id and the title it derives from the
 * conversation. Before a native `session/load`, copy a conversation that exists
 * only in the legacy store of the launch profile or of the machine profile.
 * Sources are left in place; existing native files are never overwritten.
 */
export async function adoptAntigravityLegacyConversation(input: Readonly<{
  geminiDir: string | null;
  conversationId: string;
  machineGeminiDir?: string;
}>): Promise<'native' | 'adopted' | 'absent'> {
  const id = input.conversationId;
  if (!isSafeAntigravityConversationId(id)) return 'absent';
  const machineRoot = input.machineGeminiDir ?? join(resolveHomeDirFromEnvironment(process.env), '.gemini');
  const launchRoot = input.geminiDir ?? machineRoot;
  const native = join(launchRoot, ANTIGRAVITY_APP_DATA_DIR);
  if (await exists(join(native, 'conversations', `${id}.db`))) return 'native';
  for (const root of new Set([launchRoot, machineRoot])) {
    const legacy = join(root, LEGACY_APP_DATA_DIR);
    if (!await exists(join(legacy, 'conversations', `${id}.db`))) continue;
    await mkdir(join(native, 'conversations'), { recursive: true });
    await mkdir(join(native, 'brain'), { recursive: true });
    // SQLite sidecars hold committed pages that were not yet checkpointed.
    for (const suffix of ['.db-wal', '.db-shm', '.meta']) {
      await copyIfPresent(join(legacy, 'conversations', `${id}${suffix}`), join(native, 'conversations', `${id}${suffix}`));
    }
    if (await exists(join(legacy, 'brain', id))) {
      await cp(join(legacy, 'brain', id), join(native, 'brain', id), { recursive: true, force: false, errorOnExist: false });
    }
    // The database lands last so a partial copy is never mistaken for an adopted conversation.
    await copyIfPresent(join(legacy, 'conversations', `${id}.db`), join(native, 'conversations', `${id}.db`));
    return 'adopted';
  }
  return 'absent';
}
