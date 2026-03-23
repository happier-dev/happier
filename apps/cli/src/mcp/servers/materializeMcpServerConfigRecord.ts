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

import { tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { realpathSync } from 'node:fs';

import type { McpServerConfig } from '@/agent';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { writeSecureMcpRuntimeConfigFile } from '@/mcp/runtime/writeSecureMcpRuntimeConfigFile';
import {
  type McpServerCatalogEntryV1,
  type ResolveEffectiveServersV1Result,
  type SecretStringV1,
} from '@happier-dev/protocol';

import { normalizePackageRunnerInvocation } from './normalizePackageRunnerInvocation';
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
  resolveRemoteBridgeCommand?: () => Readonly<{ command: string; args: string[]; env?: Record<string, string> }> | Promise<Readonly<{ command: string; args: string[]; env?: Record<string, string> }>>;
  resolveStdioLauncherCommand?: () => Readonly<{ command: string; args: string[]; env?: Record<string, string> }> | Promise<Readonly<{ command: string; args: string[]; env?: Record<string, string> }>>;
}>;

async function resolveDefaultRemoteBridgeCommand(): Promise<Readonly<{ command: string; args: string[]; env?: Record<string, string> }>> {
  return resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
  });
}

async function resolveDefaultStdioLauncherCommand(): Promise<Readonly<{ command: string; args: string[]; env?: Record<string, string> }>> {
  return resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
    sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'],
  });
}

function isPackageRunnerCommand(command: string): boolean {
  const normalized = basename(command).toLowerCase();
  return new Set(['npx', 'npx.cmd', 'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'yarnpkg', 'yarnpkg.cmd', 'bunx', 'bunx.cmd'])
    .has(normalized);
}

function resolveNeutralLaunchCwd(processEnv: NodeJS.ProcessEnv): string {
  const home = typeof processEnv.HOME === 'string' && processEnv.HOME.length > 0 ? processEnv.HOME : null;
  const userProfile =
    typeof processEnv.USERPROFILE === 'string' && processEnv.USERPROFILE.length > 0 ? processEnv.USERPROFILE : null;
  const homeDrive = typeof processEnv.HOMEDRIVE === 'string' ? processEnv.HOMEDRIVE : '';
  const homePath = typeof processEnv.HOMEPATH === 'string' ? processEnv.HOMEPATH : '';

  const raw = home ?? userProfile ?? (homeDrive && homePath ? `${homeDrive}${homePath}` : tmpdir());
  const resolved = resolvePath(raw);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function materializeStdioServer(params: Readonly<{
  server: McpServerCatalogEntryV1;
  directory: string;
  resolvedEnv: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
  tmpDir: string | null;
  deps: Deps;
}>): Promise<
  | null
  | Readonly<{ ok: true; config: McpServerConfig }>
  | Readonly<{ ok: false; detail: string }>
> {
  if (params.server.transport !== 'stdio' || !params.server.stdio) return null;

  if (isPackageRunnerCommand(params.server.stdio.command)) {
    const normalizedInvocation = await normalizePackageRunnerInvocation({
      command: params.server.stdio.command,
      args: params.server.stdio.args,
      processEnv: params.processEnv,
    });
    if (!normalizedInvocation) {
      return {
        ok: false,
        detail: 'managed pnpm unavailable for package-runner command',
      };
    }
    const launcherCommand = await (params.deps.resolveStdioLauncherCommand?.() ?? resolveDefaultStdioLauncherCommand());
    const configPath = await writeSecureMcpRuntimeConfigFile({
      prefix: 'happier-mcp-stdio-launcher',
      tmpDir: params.tmpDir,
      payload: {
        command: normalizedInvocation.command,
        args: normalizedInvocation.args,
        env: params.resolvedEnv,
        cwd: normalizedInvocation.cwdPolicy === 'workspace' ? params.directory : resolveNeutralLaunchCwd(params.processEnv),
      },
    });

    return {
      ok: true,
      config: {
        command: launcherCommand.command,
        args: launcherCommand.args,
        env: {
          ...(launcherCommand.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
      },
    };
  }

  const env = Object.keys(params.resolvedEnv).length > 0 ? params.resolvedEnv : undefined;
  return {
    ok: true,
    config: {
      command: params.server.stdio.command,
      args: params.server.stdio.args,
      env,
    },
  };
}

async function materializeRemoteServer(params: Readonly<{
  server: McpServerCatalogEntryV1;
  resolvedEnv: Record<string, string>;
  resolvedHeaders: Record<string, string>;
  tmpDir: string | null;
  deps: Deps;
}>): Promise<McpServerConfig | null> {
  if (params.server.transport === 'stdio' || !params.server.remote) return null;

  const bridgeCommand = await (params.deps.resolveRemoteBridgeCommand?.() ?? resolveDefaultRemoteBridgeCommand());

  const configPath = await writeSecureMcpRuntimeConfigFile({
    prefix: 'happier-mcp-remote-bridge',
    tmpDir: params.tmpDir,
    payload: {
      transport: params.server.transport,
      url: params.server.remote.url,
      headers: params.resolvedHeaders,
    },
  });

  const env = {
    ...(bridgeCommand.env ?? {}),
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
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
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
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
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
      const cfg = await materializeStdioServer({
        server,
        directory: params.resolved.directory,
        resolvedEnv,
        processEnv,
        tmpDir: params.tmpDir,
        deps,
      });
      if (!cfg || cfg.ok !== true) {
        const warning: MaterializeMcpServerConfigRecordWarning = {
          serverName,
          code: 'invalid_server',
          detail: cfg?.detail ?? 'missing stdio config',
        };
        if (strictMode) throw new Error(`Failed to materialize MCP server ${serverName}: ${warning.detail}`);
        warnings.push(warning);
        continue;
      }
      mcpServers[serverName] = cfg.config;
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
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
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
