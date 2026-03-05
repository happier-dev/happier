/**
 * MCP server materialization (CLI/runtime)
 *
 * Converts protocol-level MCP server settings (value refs + bindings already resolved)
 * into runtime `McpServerConfig` records with plaintext env/header values.
 *
 * - `stdio` servers pass through as-is (command/args/env).
 * - `http`/`sse` servers are materialized as stdio servers by spawning a local bridge.
 *
 * Strict mode:
 * - when enabled, any missing/invalid materialization for an enabled server throws.
 * - when disabled, invalid servers are skipped and surfaced as warnings.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServerConfig } from '@/agent';
import { projectPath } from '@/projectPath';
import {
  type McpServerCatalogEntryV1,
  type ResolveEffectiveServersV1Result,
  type SecretStringV1,
} from '@happier-dev/protocol';

import { resolveMcpValueRefPlaintext } from './resolveMcpValueRefPlaintext';

export type MaterializeMcpServerConfigRecordWarning = Readonly<{
  serverName: string;
  code: 'missing_value_ref' | 'invalid_server';
  detail: string;
}>;

export type MaterializeMcpServerConfigRecordResult = Readonly<{
  mcpServers: Record<string, McpServerConfig>;
  warnings: ReadonlyArray<MaterializeMcpServerConfigRecordWarning>;
}>;

type Deps = Readonly<{
  resolveRemoteBridgeCommand?: () => Readonly<{ command: string; args: string[] }>;
}>;

function resolveDefaultRemoteBridgeCommand(): Readonly<{ command: string; args: string[] }> {
  const bridgeBin = join(projectPath(), 'bin', 'happier-mcp-remote-bridge.mjs');
  return { command: process.execPath, args: [bridgeBin] };
}

function materializeStdioServer(params: Readonly<{
  server: McpServerCatalogEntryV1;
  resolvedEnv: Record<string, string>;
}>): McpServerConfig | null {
  if (params.server.transport !== 'stdio' || !params.server.stdio) return null;
  const env = Object.keys(params.resolvedEnv).length > 0 ? params.resolvedEnv : undefined;
  return {
    command: params.server.stdio.command,
    args: params.server.stdio.args,
    env,
  };
}

async function writeRemoteBridgeConfigFile(params: Readonly<{
  tmpDir: string | null;
  payload: unknown;
}>): Promise<string> {
  const baseDir = params.tmpDir ?? join(tmpdir(), 'happier-mcp-remote-bridge');
  await mkdir(baseDir, { recursive: true });
  const path = join(baseDir, `remote-bridge.${Date.now()}.${Math.random().toString(16).slice(2)}.json`);
  await writeFile(path, JSON.stringify(params.payload), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function materializeRemoteServer(params: Readonly<{
  server: McpServerCatalogEntryV1;
  resolvedEnv: Record<string, string>;
  resolvedHeaders: Record<string, string>;
  tmpDir: string | null;
  deps: Deps;
}>): Promise<McpServerConfig | null> {
  if (params.server.transport === 'stdio' || !params.server.remote) return null;

  const bridgeCommand = params.deps.resolveRemoteBridgeCommand?.() ?? resolveDefaultRemoteBridgeCommand();

  const configPath = await writeRemoteBridgeConfigFile({
    tmpDir: params.tmpDir,
    payload: {
      transport: params.server.transport,
      url: params.server.remote.url,
      headers: params.resolvedHeaders,
    },
  });

  const env = {
    ...params.resolvedEnv,
    HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
  };

  return {
    command: bridgeCommand.command,
    args: bridgeCommand.args,
    env,
  };
}

export async function materializeMcpServerConfigRecord(params: Readonly<{
  resolved: ResolveEffectiveServersV1Result;
  savedSecretsById: ReadonlyMap<string, SecretStringV1>;
  settingsSecretsKey: Uint8Array | null;
  processEnv?: NodeJS.ProcessEnv;
  tmpDir: string | null;
  strictMode?: boolean;
  deps?: Deps;
}>): Promise<MaterializeMcpServerConfigRecordResult> {
  const strictMode = params.strictMode ?? params.resolved.strictMode;
  const processEnv = params.processEnv ?? process.env;
  const deps: Deps = params.deps ?? {};

  const mcpServers: Record<string, McpServerConfig> = {};
  const warnings: MaterializeMcpServerConfigRecordWarning[] = [];

  for (const [serverName, item] of Object.entries(params.resolved.serversByName)) {
    if (item.enabled !== true) continue;
    const server = item.config;

    const resolvedEnv: Record<string, string> = {};
    let missingDetail: string | null = null;

    for (const [envKey, valueRef] of Object.entries(server.env)) {
      const resolved = resolveMcpValueRefPlaintext({
        valueRef,
        savedSecretsById: params.savedSecretsById,
        settingsSecretsKey: params.settingsSecretsKey,
        processEnv,
      });
      if (resolved === null) {
        missingDetail = `env:${envKey}`;
        break;
      }
      resolvedEnv[envKey] = resolved;
    }

    if (missingDetail) {
      const warning: MaterializeMcpServerConfigRecordWarning = {
        serverName,
        code: 'missing_value_ref',
        detail: missingDetail,
      };
      if (strictMode) {
        throw new Error(`Failed to materialize MCP server ${serverName}: missing ${missingDetail}`);
      }
      warnings.push(warning);
      continue;
    }

    if (server.transport === 'stdio') {
      const cfg = materializeStdioServer({ server, resolvedEnv });
      if (!cfg) {
        const warning: MaterializeMcpServerConfigRecordWarning = {
          serverName,
          code: 'invalid_server',
          detail: 'missing stdio config',
        };
        if (strictMode) throw new Error(`Failed to materialize MCP server ${serverName}: ${warning.detail}`);
        warnings.push(warning);
        continue;
      }
      mcpServers[serverName] = cfg;
      continue;
    }

    if (!server.remote) {
      const warning: MaterializeMcpServerConfigRecordWarning = {
        serverName,
        code: 'invalid_server',
        detail: 'missing remote config',
      };
      if (strictMode) throw new Error(`Failed to materialize MCP server ${serverName}: ${warning.detail}`);
      warnings.push(warning);
      continue;
    }

    const resolvedHeaders: Record<string, string> = {};
    for (const [headerKey, valueRef] of Object.entries(server.remote.headers)) {
      const resolved = resolveMcpValueRefPlaintext({
        valueRef,
        savedSecretsById: params.savedSecretsById,
        settingsSecretsKey: params.settingsSecretsKey,
        processEnv,
      });
      if (resolved === null) {
        missingDetail = `header:${headerKey}`;
        break;
      }
      resolvedHeaders[headerKey] = resolved;
    }

    if (missingDetail) {
      const warning: MaterializeMcpServerConfigRecordWarning = {
        serverName,
        code: 'missing_value_ref',
        detail: missingDetail,
      };
      if (strictMode) {
        throw new Error(`Failed to materialize MCP server ${serverName}: missing ${missingDetail}`);
      }
      warnings.push(warning);
      continue;
    }

    const remoteCfg = await materializeRemoteServer({
      server,
      resolvedEnv,
      resolvedHeaders,
      tmpDir: params.tmpDir,
      deps,
    });

    if (!remoteCfg) {
      const warning: MaterializeMcpServerConfigRecordWarning = {
        serverName,
        code: 'invalid_server',
        detail: 'remote bridge unavailable',
      };
      if (strictMode) throw new Error(`Failed to materialize MCP server ${serverName}: ${warning.detail}`);
      warnings.push(warning);
      continue;
    }

    mcpServers[serverName] = remoteCfg;
  }

  return { mcpServers, warnings };
}
