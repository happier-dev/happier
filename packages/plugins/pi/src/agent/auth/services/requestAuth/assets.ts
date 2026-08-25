import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomicTextFileIfChanged } from '@happier-dev/plugin-sdk/fs';

import {
  buildConnectedAccountRequestAuthClientSource,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
  buildPiRequestAuthExtensionSource,
  type PiRequestAuthPurposeMap,
} from './source.js';

const PI_REQUEST_AUTH_EXTENSION_FILE_NAME = 'happier-pi-request-auth.js';
const LEGACY_PI_BROKER_EXTENSION_FILE_PATTERN =
  /^happier-pi-broker(?:-[^/]+)?\.js$/u;
const VERSIONED_PI_REQUEST_AUTH_EXTENSION_FILE_PATTERN =
  /^happier-pi-request-auth-[^/]+\.js$/u;

export function resolvePiRequestAuthExtensionDir(agentDir: string): string {
  return join(agentDir, 'extensions');
}

export function resolvePiRequestAuthExtensionPath(agentDir: string): string {
  return join(
    resolvePiRequestAuthExtensionDir(agentDir),
    PI_REQUEST_AUTH_EXTENSION_FILE_NAME,
  );
}

export async function retireLegacyPiRequestAuthAssets(
  input: Readonly<{
    rootDir: string;
    agentDir: string;
    retainCurrent: boolean;
  }>,
): Promise<void> {
  const extensionDir = resolvePiRequestAuthExtensionDir(input.agentDir);
  const entries = await readdir(extensionDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    },
  );
  await Promise.all([
    ...entries
    .filter((entry) => (
      entry.isFile()
      && (
        LEGACY_PI_BROKER_EXTENSION_FILE_PATTERN.test(entry.name)
        || VERSIONED_PI_REQUEST_AUTH_EXTENSION_FILE_PATTERN.test(entry.name)
        || (!input.retainCurrent && entry.name === PI_REQUEST_AUTH_EXTENSION_FILE_NAME)
      )
    ))
    .map((entry) => rm(join(extensionDir, entry.name), { force: true })),
    rm(join(input.rootDir, 'broker'), { recursive: true, force: true }),
  ]);
}

export function buildPiRequestAuthExtensionAssetSource(
  purposes: PiRequestAuthPurposeMap,
): string {
  return buildPiRequestAuthExtensionSource({
    purposes,
    requestAuthClientSource: buildConnectedAccountRequestAuthClientSource({
      capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    }),
  });
}

export async function ensurePiRequestAuthExtensionAsset(
  agentDir: string,
  purposes: PiRequestAuthPurposeMap,
): Promise<string> {
  await mkdir(resolvePiRequestAuthExtensionDir(agentDir), { recursive: true });
  const path = resolvePiRequestAuthExtensionPath(agentDir);
  await writeAtomicTextFileIfChanged({
    path,
    contents: buildPiRequestAuthExtensionAssetSource(purposes),
    mode: 0o600,
  });
  return path;
}
