/**
 * Qwen Code ACP Backend - Qwen Code CLI agent via ACP.
 *
 * Qwen Code must be installed and available in PATH.
 * ACP mode: `qwen --acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { qwenTransport } from '@/backends/qwen/acp/transport';
import type { PermissionMode } from '@/api/types';
import { buildQwenAcpArgs } from './approvalMode';

export interface QwenBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

export function createQwenBackend(options: QwenBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: 'qwen',
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'qwen' }) ?? 'qwen',
    args: buildQwenAcpArgs(options.permissionMode),
    env: {
      ...options.env,
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: qwenTransport,
  };

  return new AcpBackend(backendOptions);
}
