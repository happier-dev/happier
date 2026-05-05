/**
 * Kilo ACP Backend - Kilo CLI agent via ACP.
 *
 * Kilo CLI must be installed and available in PATH.
 * ACP mode: `kilo acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { kiloTransport } from '@/backends/kilo/acp/transport';
import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permissions/modeCanonical';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

export interface KiloBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

type OpenCodePermissionPolicy = Record<string, string>;

function buildOpenCodePermissionPolicy(permissionMode: PermissionMode | null | undefined): OpenCodePermissionPolicy {
  const intent = normalizePermissionModeToIntent(permissionMode ?? 'default') ?? 'default';

  const base: OpenCodePermissionPolicy = {
    '*': 'ask',
    read: 'allow',
    edit: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    change_title: 'allow',
    save_memory: 'allow',
    think: 'allow',
  };

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    return {
      ...base,
      '*': 'allow',
      edit: 'allow',
      bash: 'allow',
      external_directory: 'allow',
    };
  }

  if (intent === 'safe-yolo') {
    return {
      ...base,
      edit: 'allow',
    };
  }

  if (intent === 'read-only' || intent === 'plan') {
    return {
      ...base,
      '*': 'deny',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
    };
  }

  return base;
}

export function createKiloBackend(options: KiloBackendOptions): AgentBackend {
  const launch = requireProviderCliLaunchSpec('kilo', { processEnv: { ...process.env, ...(options.env ?? {}) } });
  const backendOptions: AcpBackendOptions = {
    agentName: 'kilo',
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, 'acp'],
    env: {
      ...(options.env ?? {}),
      OPENCODE_PERMISSION: options.env?.OPENCODE_PERMISSION ?? JSON.stringify(buildOpenCodePermissionPolicy(options.permissionMode)),
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kiloTransport,
  };

  return new AcpBackend(backendOptions);
}
