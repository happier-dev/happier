import { normalizeCursorApiEndpoint } from '@happier-dev/agents';

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { buildCursorExtensionHandlers } from '@/backends/cursor/acp/cursorExtensionHandlers';
import { cursorTransport } from '@/backends/cursor/acp/transport';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export interface CursorBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
  parameterizedModelPicker?: boolean;
}

function buildCursorAcpArgs(
  baseArgs: readonly string[],
  processEnv: NodeJS.ProcessEnv,
  permissionMode: PermissionMode | undefined,
): string[] {
  const cursorApiEndpoint = normalizeCursorApiEndpoint(processEnv.HAPPIER_CURSOR_API_ENDPOINT);
  return [
    ...baseArgs,
    ...(cursorApiEndpoint ? ['-e', cursorApiEndpoint] : []),
    ...buildCursorPermissionModeArgs(permissionMode),
    'acp',
  ];
}

function buildCursorPermissionModeArgs(permissionMode: PermissionMode | undefined): string[] {
  switch (permissionMode) {
    case 'safe-yolo':
      return ['--force', '--sandbox', 'enabled'];
    case 'yolo':
    case 'bypassPermissions':
      return ['--force'];
    default:
      return [];
  }
}

export function buildCursorAcpBackendOptions(options: CursorBackendOptions): AcpBackendOptions {
  const processEnv = { ...process.env, ...options.env };
  const launch = requireProviderCliLaunchSpec('cursor', { processEnv });

  return {
    agentName: 'cursor',
    cwd: options.cwd,
    command: launch.command,
    args: buildCursorAcpArgs(launch.args, processEnv, options.permissionMode),
    env: {
      ...options.env,
    },
    authentication: { kind: 'static', methodId: 'cursor_login' },
    ...(options.parameterizedModelPicker === true
      ? { initializeClientCapabilitiesMeta: { parameterizedModelPicker: true } }
      : {}),
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: cursorTransport,
    ...(options.permissionHandler
      ? { extensionHandlers: buildCursorExtensionHandlers({ permissionHandler: options.permissionHandler }) }
      : {}),
  };
}

export function createCursorBackend(options: CursorBackendOptions): AgentBackend {
  return new AcpBackend(buildCursorAcpBackendOptions(options));
}
