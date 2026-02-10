/**
 * Kimi ACP Backend - Kimi CLI agent via ACP.
 *
 * Kimi CLI must be installed and available in PATH.
 * ACP mode: `kimi acp`
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import type { PermissionMode } from '@/api/types';
import { kimiTransport } from '@/backends/kimi/acp/transport';

function buildReadOnlyAgentFilePath(): string {
  return join(tmpdir(), `happier-kimi-${process.pid}-readonly-agent.yaml`);
}

function ensureReadOnlyAgentFile(): string {
  const path = buildReadOnlyAgentFilePath();
  const content =
    `version: 1\n` +
    `agent:\n` +
    `  extend: default\n` +
    `  name: happier-read-only\n` +
    `  exclude_tools:\n` +
    `    - \"kimi_cli.tools.shell:Shell\"\n` +
    `    - \"kimi_cli.tools.file:WriteFile\"\n` +
    `    - \"kimi_cli.tools.file:StrReplaceFile\"\n`;
  writeFileSync(path, content, { encoding: 'utf8' });
  return path;
}

export interface KimiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

export function createKimiBackend(options: KimiBackendOptions): AgentBackend {
  const intent = normalizePermissionModeToIntent(options.permissionMode ?? 'default') ?? 'default';

  const args: string[] = ['--work-dir', options.cwd];

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    args.push('--yolo');
  }

  if (intent === 'read-only' || intent === 'plan') {
    args.push('--agent-file', ensureReadOnlyAgentFile());
  }

  args.push('acp');

  const backendOptions: AcpBackendOptions = {
    agentName: 'kimi',
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'kimi' }) ?? 'kimi',
    args,
    env: {
      ...options.env,
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    // Kimi ACP rejects MCP server startup; avoid attaching servers.
    mcpServers: undefined,
    permissionHandler: options.permissionHandler,
    transportHandler: kimiTransport,
  };

  return new AcpBackend(backendOptions);
}
