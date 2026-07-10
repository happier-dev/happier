import { join } from 'node:path';

/**
 * The Happier-owned, isolated OpenCode config home for a connected selection. Derived deterministically
 * from the per-selection connected-service root dir the host already provisions, so:
 *  - the materializer emits it as `XDG_CONFIG_HOME` (config isolation: NO user 3rd-party plugins), and
 *  - the broker assets land under `<configHome>/opencode/plugin/` (the auto-load dir).
 *
 * Keeping it a pure function of `rootDir` lets the materializer reference the path without any
 * filesystem I/O while the live server-launch path writes the assets there.
 */
export function resolveOpenCodeConnectedConfigHomeDir(rootDir: string): string {
  return join(rootDir, 'connected-config');
}
