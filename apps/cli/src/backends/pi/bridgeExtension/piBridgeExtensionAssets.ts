import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeGeneratedTextAtomicallyIfChanged } from '@/utils/fs/writeGeneratedTextAtomicallyIfChanged';
import { buildPiBridgeExtensionSource, type PiBridgeExtensionSourceParams } from './piBridgeExtensionSource';

/**
 * On-disk layout for the Pi tools-bridge extension.
 *
 * Mirrors the broker extension: the asset lives under the Happier-controlled Pi agent dir
 * (`PI_CODING_AGENT_DIR`) and is passed to Pi through the `--extension` CLI argument
 * together with `--happy-session-id` by the Happier Pi launcher.
 *
 * Unlike the broker (whose materialized agent dirs are never auto-scanned), the bridge
 * can land in the user's real `~/.pi/agent` when `PI_CODING_AGENT_DIR` points there. Pi
 * auto-discovers `extensions/*.js` and `extensions/SUBDIR/index.js`, and a second copy
 * loaded via `--extension` would flag-conflict with an auto-discovered one. The asset
 * therefore lives in a subdirectory under a NON-index filename: never auto-discovered,
 * only loaded through the explicit `--extension` path.
 *
 * Older unreleased versioned assets (and the legacy flat
 * `extensions/happier-pi-tools-bridge.js`, which Pi WOULD auto-discover) are retired
 * before writing so homes do not accumulate competing copies.
 */

/** Tools-bridge extension base dir relative to the Happier-controlled Pi agent dir. */
export function resolvePiBridgeExtensionDir(agentDir: string): string {
  return join(agentDir, 'extensions', 'happier-pi-tools-bridge');
}

/**
 * Deterministic extension file path. Deliberately NOT `index.js`: Pi auto-discovers
 * `extensions/SUBDIR/index.js`, and this asset must only ever load via `--extension`.
 */
export function resolvePiBridgeExtensionPath(agentDir: string): string {
  return join(resolvePiBridgeExtensionDir(agentDir), 'happier-pi-tools-bridge.js');
}

const LEGACY_FLAT_PI_BRIDGE_EXTENSION_NAME = 'happier-pi-tools-bridge.js';
const VERSIONED_PI_BRIDGE_EXTENSION_PATTERN = /^happier-pi-tools-bridge-[^/]+\.js$/u;

async function retireStalePiBridgeExtensionAssets(extensionRoot: string, extensionDir: string): Promise<void> {
  const retirements: Array<Promise<void>> = [];

  const rootEntries = await readdir(extensionRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of rootEntries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (entry.name === LEGACY_FLAT_PI_BRIDGE_EXTENSION_NAME || VERSIONED_PI_BRIDGE_EXTENSION_PATTERN.test(entry.name)) {
      retirements.push(rm(join(extensionRoot, entry.name), { force: true }));
    }
  }

  const dirEntries = await readdir(extensionDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of dirEntries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (VERSIONED_PI_BRIDGE_EXTENSION_PATTERN.test(entry.name)) {
      retirements.push(rm(join(extensionDir, entry.name), { force: true }));
    }
  }

  await Promise.all(retirements);
}

/**
 * Idempotently write the Pi tools-bridge extension under the agent dir `extensions/`
 * subtree. Safe to call repeatedly (write-if-changed). Called by the Pi runtime's
 * backend-option resolution for sessions where Happier controls the Pi agent dir;
 * sessions without a managed agent dir never invoke it, so their homes stay free of
 * the extension.
 */
export async function ensurePiBridgeExtensionAsset(
  agentDir: string,
  params: PiBridgeExtensionSourceParams,
): Promise<string> {
  const extensionRoot = join(agentDir, 'extensions');
  const extensionDir = resolvePiBridgeExtensionDir(agentDir);
  await mkdir(extensionDir, { recursive: true });
  await retireStalePiBridgeExtensionAssets(extensionRoot, extensionDir);
  const path = resolvePiBridgeExtensionPath(agentDir);
  await writeGeneratedTextAtomicallyIfChanged({
    path,
    contents: buildPiBridgeExtensionSource(params),
    mode: 0o600,
  });
  return path;
}
