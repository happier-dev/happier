import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeGeneratedTextAtomicallyIfChanged } from '@/utils/fs/writeGeneratedTextAtomicallyIfChanged';
import { buildPiBrokerExtensionSource } from './piBrokerExtensionSource';

/**
 * On-disk layout for the Pi broker extension.
 *
 * Happier controls `PI_CODING_AGENT_DIR` for connected sessions (it writes `auth.json` there), so the
 * broker extension lives beside that materialized auth state under an `extensions/` subdir. Pi's current
 * extension loader does not auto-load that directory; `createPiBackend` passes this deterministic path
 * through Pi's `--extension` CLI argument for brokered sessions.
 *
 * The stable file path is passed explicitly to Pi. Older unreleased versioned assets are retired
 * before writing it so local development homes do not accumulate competing implementations.
 */

/** Broker extension dir relative to the Happier-controlled Pi agent dir. */
export function resolvePiBrokerExtensionDir(agentDir: string): string {
  return join(agentDir, 'extensions');
}

/** Deterministic extension file path. `.js` is discovered by Pi (`isExtensionFile`). */
export function resolvePiBrokerExtensionPath(agentDir: string): string {
  return join(resolvePiBrokerExtensionDir(agentDir), 'happier-pi-broker.js');
}

const VERSIONED_PI_BROKER_EXTENSION_PATTERN = /^happier-pi-broker-[^/]+\.js$/u;

async function retireVersionedPiBrokerExtensionAssets(extensionDir: string): Promise<void> {
  const entries = await readdir(extensionDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => (
      entry.isFile()
      && VERSIONED_PI_BROKER_EXTENSION_PATTERN.test(entry.name)
    ))
    .map((entry) => rm(join(extensionDir, entry.name), { force: true })));
}

/**
 * Idempotently write the Pi broker extension into `<agentDir>/extensions/`. Safe to call repeatedly
 * (write-if-changed). Called by the materializer for brokered Pi sessions only — direct-API-key and
 * native Pi sessions never invoke it, so their agent dirs stay free of the extension.
 */
export async function ensurePiBrokerExtensionAsset(agentDir: string): Promise<string> {
  const extensionDir = resolvePiBrokerExtensionDir(agentDir);
  await mkdir(extensionDir, { recursive: true });
  await retireVersionedPiBrokerExtensionAssets(extensionDir);
  const path = resolvePiBrokerExtensionPath(agentDir);
  await writeGeneratedTextAtomicallyIfChanged({
    path,
    contents: buildPiBrokerExtensionSource(),
    mode: 0o600,
  });
  return path;
}
