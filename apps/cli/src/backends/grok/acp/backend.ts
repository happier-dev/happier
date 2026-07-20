import {
  AcpBackend,
  type AcpBackendOptions,
  type AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

import { createGrokAcpAuthentication } from './auth';
import { buildGrokExtensionHandlers } from './extensionHandlers';
import { GROK_ACP_ARGS } from './launch';
import { grokTransport } from './transport';

export interface GrokBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}

function inspectEnvironmentValuePresence(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): Readonly<{ found: boolean; nonBlank: boolean }> {
  if (platform !== 'win32') {
    const found = Object.prototype.hasOwnProperty.call(env, key);
    const value = found ? env[key] : undefined;
    return { found, nonBlank: typeof value === 'string' && value.trim().length > 0 };
  }

  const normalizedKey = key.toLowerCase();
  const matchedKey = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toLowerCase() === normalizedKey);
  const value = matchedKey === undefined ? undefined : env[matchedKey];
  return {
    found: matchedKey !== undefined,
    nonBlank: typeof value === 'string' && value.trim().length > 0,
  };
}

export function resolveGrokXaiApiKeyPresence(params: Readonly<{
  inheritedEnv: NodeJS.ProcessEnv;
  overrideEnv?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}>): Readonly<{
  hasXaiApiKey: boolean;
  unsetInheritedXaiApiKey: boolean;
}> {
  const override = params.overrideEnv === undefined
    ? { found: false, nonBlank: false }
    : inspectEnvironmentValuePresence(params.overrideEnv, 'XAI_API_KEY', params.platform);
  const hasXaiApiKey = override.found
    ? override.nonBlank
    : inspectEnvironmentValuePresence(params.inheritedEnv, 'XAI_API_KEY', params.platform).nonBlank;

  return {
    hasXaiApiKey,
    // AcpBackend removes inherited variants before applying the override so the
    // Windows child environment observes the same case-insensitive precedence.
    unsetInheritedXaiApiKey: params.platform === 'win32' && override.found,
  };
}

export function buildGrokAcpBackendOptions(options: GrokBackendOptions): AcpBackendOptions {
  const processEnv = { ...process.env, ...options.env };
  const launch = requireProviderCliLaunchSpec('grok', { processEnv });
  const xaiApiKeyPresence = resolveGrokXaiApiKeyPresence({
    inheritedEnv: process.env,
    overrideEnv: options.env,
    platform: process.platform,
  });

  return {
    agentName: 'grok',
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, ...GROK_ACP_ARGS],
    env: { ...options.env },
    unsetEnv: xaiApiKeyPresence.unsetInheritedXaiApiKey ? ['XAI_API_KEY'] : undefined,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: grokTransport,
    authentication: createGrokAcpAuthentication({ hasXaiApiKey: xaiApiKeyPresence.hasXaiApiKey }),
    extensionHandlers: buildGrokExtensionHandlers({ permissionHandler: options.permissionHandler }),
  };
}

export function createGrokBackend(options: GrokBackendOptions): AgentBackend {
  return new AcpBackend(buildGrokAcpBackendOptions(options));
}
