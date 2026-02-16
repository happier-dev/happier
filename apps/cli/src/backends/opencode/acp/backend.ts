/**
 * OpenCode ACP Backend - OpenCode agent via ACP
 *
 * This module provides a factory function for creating an OpenCode backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * OpenCode must be installed and available in PATH.
 * ACP mode: `opencode acp`
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '@/agent/core';
import { openCodeTransport } from '@/backends/opencode/acp/transport';
import { logger } from '@/ui/logger';
import type { PermissionMode } from '@/api/types';
import { buildOpenCodeFamilyPermissionEnv } from '@/backends/opencode/utils/opencodeFamilyPermissionEnv';

/**
 * Get the platform-specific path to the OpenCode configuration file.
 *
 * Follows platform-specific conventions:
 * - Linux/macOS: $XDG_CONFIG_HOME/opencode/opencode.json (defaults to ~/.config when unset)
 * - Windows: %APPDATA%\opencode\opencode.json
 */
function getOpenCodeConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'opencode', 'opencode.json');
  }
  // Linux, macOS, and others respect XDG_CONFIG_HOME
  const homeDir = process.env.HOME || homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');
  return join(xdgConfigHome, 'opencode', 'opencode.json');
}

/**
 * Read the user's OpenCode configuration file and return it as a JSON string.
 *
 * OpenCode ACP mode does not read from ~/.config/opencode/opencode.json by default.
 * Instead, it expects the full config to be passed via OPENCODE_CONFIG_CONTENT.
 * This function bridges that gap by reading the user's config file and formatting
 * it for the ACP backend.
 *
 * Precedence (highest to lowest):
 * 1. process.env.OPENCODE_CONFIG_CONTENT (user's shell-level override)
 * 2. optionsEnv.OPENCODE_CONFIG_CONTENT (runtime-provided config)
 * 3. ~/.config/opencode/opencode.json (user's config file)
 */
function readOpenCodeConfig(optionsEnv?: Record<string, string>): string | undefined {
  // Highest priority: process-level env var (user's shell override)
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    return process.env.OPENCODE_CONFIG_CONTENT;
  }

  // Second priority: options env (runtime-provided config)
  if (optionsEnv?.OPENCODE_CONFIG_CONTENT) {
    return optionsEnv.OPENCODE_CONFIG_CONTENT;
  }

  // Lowest priority: read from config file
  const configPath = getOpenCodeConfigPath();
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    // Validate it's valid JSON
    JSON.parse(content);
    return content;
  } catch (error) {
    logger.debug(`[OpenCode] Failed to read config from ${configPath}:`, error);
    return undefined;
  }
}

export interface OpenCodeBackendOptions extends AgentFactoryOptions {
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
  /** Optional Happier permission mode (applied to provider-native permissions). */
  permissionMode?: PermissionMode;
}

export function createOpenCodeBackend(options: OpenCodeBackendOptions): AgentBackend {
  const openCodeConfig = readOpenCodeConfig(options.env);

  const backendOptions: AcpBackendOptions = {
    agentName: 'opencode',
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'opencode' }) ?? 'opencode',
    args: ['acp'],
    env: {
      ...options.env,
      ...buildOpenCodeFamilyPermissionEnv(options.permissionMode),
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
      // Pass OpenCode config if available (respects user's ~/.config/opencode/opencode.json)
      ...(openCodeConfig ? { OPENCODE_CONFIG_CONTENT: openCodeConfig } : {}),
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: openCodeTransport,
  };

  logger.debug('[OpenCode] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
    hasConfig: !!openCodeConfig,
  });

  return new AcpBackend(backendOptions);
}
