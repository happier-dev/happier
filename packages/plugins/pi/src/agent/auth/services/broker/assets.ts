import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildPiBrokerExtensionSource, PI_BROKER_EXTENSION_VERSION } from './source.js';

/**
 * On-disk layout for the Pi broker extension.
 *
 * Pi auto-discovers extensions from `<PI_CODING_AGENT_DIR>/extensions/` (its global extension dir).
 * Happier already controls `PI_CODING_AGENT_DIR` for connected sessions (it writes `auth.json` there),
 * so writing the broker extension into that dir's `extensions/` subdir is sufficient for Pi to load it
 * — exactly analogous to OpenCode's `XDG_CONFIG_HOME/opencode/plugin/` mechanism.
 *
 * The file is named by version so an upgraded daemon's new extension co-exists with any stale one and
 * the active version is unambiguous. The extension is self-selecting (it registers only the brokered
 * providers present in the selections env), so a single file serves both provider lanes.
 */

/** Pi's global extension auto-discovery dir, relative to the (Happier-controlled) agent dir. */
export function resolvePiBrokerExtensionDir(agentDir: string): string {
  return join(agentDir, 'extensions');
}

/** Deterministic, version-keyed extension file path. `.js` is discovered by Pi's extension loader. */
export function resolvePiBrokerExtensionPath(agentDir: string): string {
  return join(resolvePiBrokerExtensionDir(agentDir), `happier-pi-broker-${PI_BROKER_EXTENSION_VERSION}.js`);
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === content) return;
  await writeFile(path, content, { mode: 0o600 });
}

/**
 * Idempotently write the Pi broker extension into `<agentDir>/extensions/`. Safe to call repeatedly
 * (write-if-changed). Called by the materializer for brokered Pi sessions only — direct-API-key and
 * native Pi sessions never invoke it, so their agent dirs stay free of the extension.
 */
export async function ensurePiBrokerExtensionAsset(agentDir: string): Promise<string> {
  await mkdir(resolvePiBrokerExtensionDir(agentDir), { recursive: true });
  const path = resolvePiBrokerExtensionPath(agentDir);
  await writeFileIfChanged(path, buildPiBrokerExtensionSource());
  return path;
}
