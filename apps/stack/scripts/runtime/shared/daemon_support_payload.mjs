import { access } from 'node:fs/promises';
import { join } from 'node:path';

export const DAEMON_SUPPORT_DIRECTORIES = Object.freeze(['node_modules', 'tools', 'scripts', '.project']);

export async function assertDaemonSupportPayload({ supportPayloadDir }) {
  await Promise.all(DAEMON_SUPPORT_DIRECTORIES.map(async (name) => {
    try {
      await access(join(supportPayloadDir, name));
    } catch {
      throw new Error(`[build] daemon support artifact is incomplete: missing ${name}.`);
    }
  }));
}
