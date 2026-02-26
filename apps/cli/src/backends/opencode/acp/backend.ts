/**
 * OpenCode ACP Backend - OpenCode agent via ACP
 *
 * This module provides a factory function for creating an OpenCode backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * OpenCode must be installed and available in PATH.
 * ACP mode: `opencode acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '@/agent/core';
import { openCodeTransport } from '@/backends/opencode/acp/transport';
import { logger } from '@/ui/logger';
import type { PermissionMode } from '@/api/types';
import { buildOpenCodeFamilyPermissionEnv } from '@/backends/opencode/utils/opencodeFamilyPermissionEnv';
import { parseBooleanEnv } from '@happier-dev/protocol';

export interface OpenCodeBackendOptions extends AgentFactoryOptions {
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
  /** Optional Happier permission mode (applied to provider-native permissions). */
  permissionMode?: PermissionMode;
}

export function createOpenCodeBackend(options: OpenCodeBackendOptions): AgentBackend {
  const mergedEnv: Record<string, string> = {
    // Pass through the parent process environment by default so users can configure
    // OpenCode using standard env vars (including OPENCODE_CONFIG_CONTENT).
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    // Isolation/runner env should override the parent environment.
    ...options.env,
    ...buildOpenCodeFamilyPermissionEnv(options.permissionMode),
    // Keep output clean; ACP must own stdout.
    NODE_ENV: 'production',
    DEBUG: '',
  };

  const shouldPrintLogs = parseBooleanEnv(mergedEnv['HAPPIER_OPENCODE_ACP_PRINT_LOGS'], true);

  const resolvedLogLevel = (() => {
    const raw = (mergedEnv['HAPPIER_OPENCODE_ACP_LOG_LEVEL'] ?? '').toString().trim().toUpperCase();
    if (raw === 'DEBUG' || raw === 'INFO' || raw === 'WARN' || raw === 'ERROR') return raw;
    return 'ERROR';
  })();

  const backendOptions: AcpBackendOptions = {
    agentName: 'opencode',
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'opencode' }) ?? 'opencode',
    args: [
      'acp',
      ...(shouldPrintLogs ? (['--print-logs'] as const) : []),
      '--log-level',
      resolvedLogLevel,
    ],
    env: mergedEnv,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: openCodeTransport,
  };

  logger.debug('[OpenCode] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return new AcpBackend(backendOptions);
}
