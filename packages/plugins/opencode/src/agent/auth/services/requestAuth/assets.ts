import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomicTextFileIfChanged } from '@happier-dev/plugin-sdk/fs';

import {
  buildConnectedAccountRequestAuthClientSource,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/agents/request-auth';

import type { OpenCodeRequestAuthPurposeMap } from './env.js';
import {
  buildOpenCodeRequestAuthPluginSource,
  type OpenCodeRequestAuthProvider,
} from './source.js';

export function resolveOpenCodeConnectedConfigHomeDir(rootDir: string): string {
  return join(rootDir, 'opencode-config');
}

export function resolveOpenCodeRequestAuthPluginDir(configHome: string): string {
  return join(configHome, 'opencode', 'plugin');
}

export function resolveOpenCodeRequestAuthPluginPath(
  configHome: string,
  provider: OpenCodeRequestAuthProvider,
): string {
  return join(
    resolveOpenCodeRequestAuthPluginDir(configHome),
    `happier-request-auth-${provider}.js`,
  );
}

export async function retireCompetingOpenCodeAuthAssets(
  rootDir: string,
  configHome: string,
): Promise<void> {
  const pluginDir = resolveOpenCodeRequestAuthPluginDir(configHome);
  const entries = await readdir(pluginDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => (
      entry.isFile()
      && (
        /^happier-broker-(?:openai|anthropic)(?:-[^/]+)?\.js$/u.test(entry.name)
        || /^happier-request-auth-(?:openai|anthropic)-[^/]+\.js$/u.test(entry.name)
      )
    ))
    .map((entry) => rm(join(pluginDir, entry.name), { force: true })));
  await rm(join(rootDir, 'broker'), { recursive: true, force: true });
}

function buildAssetSource(
  provider: OpenCodeRequestAuthProvider,
  purpose: NonNullable<OpenCodeRequestAuthPurposeMap[OpenCodeRequestAuthProvider]>,
): string {
  return buildOpenCodeRequestAuthPluginSource({
    provider,
    purpose,
    requestAuthClientSource: buildConnectedAccountRequestAuthClientSource({
      capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    }),
  });
}

export async function ensureOpenCodeRequestAuthPluginAssets(
  configHome: string,
  purposes: OpenCodeRequestAuthPurposeMap,
): Promise<readonly string[]> {
  const pluginDir = resolveOpenCodeRequestAuthPluginDir(configHome);
  await mkdir(pluginDir, { recursive: true });
  const written: string[] = [];
  for (const provider of ['openai', 'anthropic'] as const) {
    const purpose = purposes[provider];
    if (!purpose) continue;
    const path = resolveOpenCodeRequestAuthPluginPath(configHome, provider);
    await writeAtomicTextFileIfChanged({
      path,
      contents: buildAssetSource(provider, purpose),
      mode: 0o600,
    });
    written.push(path);
  }
  return Object.freeze(written);
}
