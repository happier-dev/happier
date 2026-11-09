import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomicTextFileIfChanged } from '@happier-dev/plugin-sdk/fs';

import {
  buildConnectedAccountRequestAuthClientSource,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type { OpenCodeRequestAuthPurposeMap } from './env.js';
import type { OpenCodeConfigPart } from '../../../runtime/server/opencodeConfigContent.js';
import {
  buildOpenCodeRequestAuthPluginSource,
  buildOpenCodeRequestAuthV2PluginSource,
  OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL,
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

export function resolveOpenCodeRequestAuthV2PluginDir(
  configHome: string,
  provider: OpenCodeRequestAuthProvider,
): string {
  return join(configHome, 'happier-v2-plugins', `happier-request-auth-${provider}`);
}

export function resolveOpenCodeRequestAuthV2PluginSourcePath(
  configHome: string,
  provider: OpenCodeRequestAuthProvider,
): string {
  return join(resolveOpenCodeRequestAuthV2PluginDir(configHome, provider), 'index.js');
}

export function buildOpenCodeV2ConnectedAuthConfigPart(input: Readonly<{
  configHome: string;
  requestAuthProviders: readonly OpenCodeRequestAuthProvider[];
  directApiKeys: Readonly<Partial<Record<OpenCodeRequestAuthProvider, string>>>;
}>): OpenCodeConfigPart {
  const connectedProviders: Record<string, unknown> = {};
  const legacyProviders: Record<string, unknown> = {};
  for (const provider of ['openai', 'anthropic'] as const) {
    const directKey = input.directApiKeys[provider];
    if (typeof directKey === 'string' && directKey.trim().length > 0) {
      connectedProviders[provider] = { settings: { apiKey: directKey } };
    } else if (input.requestAuthProviders.includes(provider)) {
      connectedProviders[provider] = provider === 'openai'
        ? { settings: { baseURL: OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL } }
        : {};
      if (provider === 'openai') legacyProviders[provider] = { options: { baseURL: OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL } };
    }
  }
  return {
    // V1 reapplies native config after its auth loader; both dialects must report
    // the same effective route used by the generated request-auth fetch adapter.
    ...(Object.keys(legacyProviders).length > 0 ? { provider: legacyProviders } : {}),
    providers: connectedProviders,
    plugins: [
      ...input.requestAuthProviders.map((provider) => (
        resolveOpenCodeRequestAuthV2PluginDir(input.configHome, provider)
      )),
    ],
  };
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
  await rm(join(configHome, 'happier-v2-plugins'), { recursive: true, force: true });
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
    const v2Path = resolveOpenCodeRequestAuthV2PluginSourcePath(configHome, provider);
    await mkdir(resolveOpenCodeRequestAuthV2PluginDir(configHome, provider), { recursive: true });
    const clientSource = buildConnectedAccountRequestAuthClientSource({
      capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    });
    await Promise.all([
      writeAtomicTextFileIfChanged({
        path,
        contents: buildAssetSource(provider, purpose),
        mode: 0o600,
      }),
      writeAtomicTextFileIfChanged({
        path: v2Path,
        contents: buildOpenCodeRequestAuthV2PluginSource({
          provider,
          purpose,
          requestAuthClientSource: clientSource,
        }),
        mode: 0o600,
      }),
    ]);
    written.push(path);
  }
  return Object.freeze(written);
}
