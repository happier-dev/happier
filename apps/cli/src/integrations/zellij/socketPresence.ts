import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Positive death evidence for a zellij session, derived from the on-disk IPC socket the zellij
 * *server* owns. A zellij server publishes and holds a session by creating a unix socket named
 * after the session under a contract-version subdirectory of `ZELLIJ_SOCKET_DIR`
 * (`<socketDir>/<contract_version_*>/<sessionName>`). The server is the sole owner of that file:
 * if it is absent, no server process holds the session name and no client action can ever reach it
 * (an `attach`/`list-panes` client blocks forever waiting for a socket that will never appear). Its
 * absence is therefore the same fact as "no zellij server process holds that session name",
 * observed through the authoritative artifact rather than an expensive, racy process scan.
 *
 * - `absent`  — the socket dir is gone, or no socket file named `sessionName` exists under any
 *               contract-version subdir. Conclusive death; safe to skip the (hanging) client probe.
 * - `present` — a socket file for the session exists; proceed with the normal client liveness probe
 *               (a stale-but-present socket stays inconclusive on timeout, never falsely dead).
 * - `unknown` — presence could not be determined (unexpected FS error, or non-POSIX platform where
 *               zellij is unsupported). Never used as death evidence; caller proceeds as before.
 */
export type ZellijSessionSocketPresence = 'present' | 'absent' | 'unknown';

export type InspectZellijSessionSocketPresence = (
  params: Readonly<{ socketDir: string; sessionName: string }>,
) => Promise<ZellijSessionSocketPresence>;

function isEnoent(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    // A non-ENOENT error (e.g. EACCES) means we cannot prove absence; surface it to the caller as
    // an inability to determine presence rather than false death evidence.
    throw error;
  }
}

export const inspectZellijSessionSocketPresence: InspectZellijSessionSocketPresence = async ({
  socketDir,
  sessionName,
}) => {
  // zellij only runs on POSIX platforms; on win32 the socket model does not apply, so never treat
  // absence as death evidence there.
  if (process.platform === 'win32') return 'unknown';
  if (sessionName.length === 0) return 'unknown';

  let entries: string[];
  try {
    entries = await readdir(socketDir);
  } catch (error) {
    // The entire socket directory is gone: no server, no session, conclusively dead.
    if (isEnoent(error)) return 'absent';
    return 'unknown';
  }

  try {
    for (const entry of entries) {
      const contractDir = join(socketDir, entry);
      let isDirectory: boolean;
      try {
        isDirectory = (await lstat(contractDir)).isDirectory();
      } catch (error) {
        if (isEnoent(error)) continue;
        return 'unknown';
      }
      if (!isDirectory) continue;
      if (await pathExists(join(contractDir, sessionName))) return 'present';
    }
  } catch {
    // Could not fully enumerate — do not claim death.
    return 'unknown';
  }

  // Socket dir exists and is enumerable, but no contract-version subdir holds a socket for the
  // session: the server that owned it is gone.
  return 'absent';
};
