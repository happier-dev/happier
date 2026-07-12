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

export function buildGrokAcpBackendOptions(options: GrokBackendOptions): AcpBackendOptions {
  const processEnv = { ...process.env, ...options.env };
  const launch = requireProviderCliLaunchSpec('grok', { processEnv });
  const hasXaiApiKey = typeof processEnv.XAI_API_KEY === 'string'
    && processEnv.XAI_API_KEY.trim().length > 0;

  return {
    agentName: 'grok',
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, ...GROK_ACP_ARGS],
    env: { ...options.env },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: grokTransport,
    authentication: createGrokAcpAuthentication({ hasXaiApiKey }),
    extensionHandlers: buildGrokExtensionHandlers({ permissionHandler: options.permissionHandler }),
  };
}

export function createGrokBackend(options: GrokBackendOptions): AgentBackend {
  return new AcpBackend(buildGrokAcpBackendOptions(options));
}
