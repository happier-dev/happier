import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { randomUUID } from 'node:crypto';
import { parseConnectedAccountRequestAuthCapabilityDocument } from '@happier-dev/agents/request-auth';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readProtectedLocalStateFile } from '@/utils/fs/protectedLocalState';

/**
 * MCP server materialization (CLI/runtime)
 *
 * Converts protocol-level MCP server settings (value refs + bindings already resolved)
 * into runtime `McpServerConfig` records with plaintext env/header values.
 *
 * - `stdio` env values stay in a private launcher configuration file.
 * - `http`/`sse` servers are materialized as stdio servers by spawning a local bridge.
 *
 * Strict mode:
 * - when enabled, any missing/invalid materialization for an enabled server throws.
 * - when disabled, invalid servers are skipped and surfaced as warnings.
 *
 * An explicitly selected Saved Secret is not an optional invalid server: its
 * canonical catalog failure is always thrown as `SavedSecretResolutionError`,
 * including in non-strict mode, so callers cannot silently drop the server.
 */

import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { realpathSync } from 'node:fs';

import type { McpServerConfig } from '@/agent';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { AgentLaunchMaterializationTarget } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { removeWrittenMcpRuntimeConfigFile, writeSecureMcpRuntimeConfigFile } from '@/mcp/runtime/writeSecureMcpRuntimeConfigFile';
import { listValueRefSecretIdsV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import type { McpServerCatalogEntryV1, McpServerMaterializationV1 } from '@happier-dev/protocol';
import {
  SavedSecretResolutionError,
  type SavedSecretMaterializerV1,
} from '@/settings/secrets/savedSecretCatalog';

import { isPackageRunnerCommand, normalizePackageRunnerInvocation } from '@/packagedRuntime/packageRunner/normalizePackageRunnerInvocation';
import { resolveValueRefPlaintext } from '@/settings/valueRefs/resolveValueRefPlaintext';
import { isSharedSavedSecretReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecretOperationReferenceV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { McpRequestAuthCapability, McpRequestAuthFailureCode } from '@/mcp/runtime/mcpRequestAuth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { createProviderRedactionLease, type ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

export function listSelectedMcpSharedSecretReferences(
  serversByName: McpServerMaterializationV1['serversByName'],
): readonly SavedSecretOperationReferenceV1[] {
  const references = new Map<string, SavedSecretOperationReferenceV1>();
  for (const item of Object.values(serversByName)) {
    if (item.enabled !== true) continue;
    for (const valueRef of [...Object.values(item.config.env), ...Object.values(item.config.remote?.headers ?? {}),
      ...(item.config.remote?.urlTemplate ? [item.config.remote.urlTemplate] : [])]) {
      for (const secretId of listValueRefSecretIdsV1(valueRef)) {
        if (isSharedSavedSecretReferenceV1(secretId)) references.set(secretId, { ref: secretId });
      }
    }
  }
  return [...references.values()];
}

export type MaterializeMcpServerConfigRecordWarning = Readonly<{
  serverName: string;
  code: 'missing_value_ref' | 'invalid_server';
  detail: string;
}>;

export type MaterializeMcpServerConfigRecordResult = Readonly<{
  mcpServers: Record<string, McpServerConfig>;
  warnings: ReadonlyArray<MaterializeMcpServerConfigRecordWarning>;
  cleanup: () => void;
  sanitizeDiagnosticText: (value: string) => string;
  createDiagnosticStreamingSanitizer: () => ProviderStreamingSanitizer;
  selectedMaterials?: readonly AgentLaunchSelectedMaterial[];
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

function resolveNeutralLaunchCwd(processEnv: ProcessEnvInput): string {
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

type PrivateConfigMaterialization = Readonly<{
  target: AgentLaunchMaterializationTarget;
  selectedMaterials: AgentLaunchSelectedMaterial[];
}>;

async function materializePrivateRuntimeConfig(params: Readonly<{
  prefix: string;
  payload: unknown;
  tmpDir: string | null;
  writtenPaths: string[];
  assertCurrent?: () => Promise<void>;
  agentLaunchMaterials?: PrivateConfigMaterialization;
}>): Promise<string> {
  if (params.agentLaunchMaterials) {
    await params.assertCurrent?.();
    const relativePath = `files/${params.prefix}.${randomUUID()}.json`;
    params.agentLaunchMaterials.selectedMaterials.push(Object.freeze({
      relativePath,
      contentBase64: Buffer.from(JSON.stringify(params.payload), 'utf8').toString('base64'),
    }));
    return join(params.agentLaunchMaterials.target.runtimeHome, relativePath);
  }
  const configPath = await writeSecureMcpRuntimeConfigFile(params);
  params.writtenPaths.push(configPath);
  return configPath;
}

async function materializePrivateStdioLaunch(params: Readonly<{
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  tmpDir: string | null;
  deps: Deps;
  writtenPaths: string[];
  assertCurrent?: () => Promise<void>;
  agentLaunchMaterials?: PrivateConfigMaterialization;
}>): Promise<McpServerConfig> {
  const launcherCommand = await (params.deps.resolveStdioLauncherCommand?.() ?? resolveDefaultStdioLauncherCommand());
  const configPath = await materializePrivateRuntimeConfig({
    prefix: 'happier-mcp-stdio-launcher',
    tmpDir: params.tmpDir,
    writtenPaths: params.writtenPaths,
    agentLaunchMaterials: params.agentLaunchMaterials,
    assertCurrent: params.assertCurrent,
    payload: { command: params.command, args: params.args, env: params.env,
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }) },
  });
  return {
    command: launcherCommand.command,
    args: launcherCommand.args,
    env: { ...(launcherCommand.env ?? {}), HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath },
  };
}

async function materializeStdioServer(params: Readonly<{
  server: McpServerCatalogEntryV1;
  directory: string;
  resolvedEnv: Record<string, string>;
  processEnv: ProcessEnvInput;
  tmpDir: string | null;
  deps: Deps;
  writtenPaths: string[];
  assertCurrent?: () => Promise<void>;
  agentLaunchMaterials?: PrivateConfigMaterialization;
}>): Promise<
  | null
  | Readonly<{ ok: true; config: McpServerConfig }>
  | Readonly<{ ok: false; detail: string }>
> {
  if (params.server.transport !== 'stdio' || !params.server.stdio) return null;

  let command = params.server.stdio.command;
  let args = params.server.stdio.args;
  let launchEnv = params.resolvedEnv;
  const configuredCwd = params.server.stdio.cwd;
  let cwd = configuredCwd?.t === 'session' ? params.directory
    : configuredCwd?.t === 'path' ? resolvePath(params.directory, expandHomeDirPath(configuredCwd.path, params.processEnv))
      : undefined;
  if (isPackageRunnerCommand(params.server.stdio.command)) {
    const normalizedInvocation = await normalizePackageRunnerInvocation({
      command: params.server.stdio.command,
      args: params.server.stdio.args,
      processEnv: params.processEnv,
      launchEnv: params.resolvedEnv,
    });
    if (!normalizedInvocation) {
      return {
        ok: false,
        detail: 'managed runtime unavailable for package-runner command',
      };
    }
    command = normalizedInvocation.command;
    args = normalizedInvocation.args;
    launchEnv = buildScopedProcessEnv({ baseEnv: params.resolvedEnv, explicitEnv: normalizedInvocation.env });
    cwd ??= normalizedInvocation.cwdPolicy === 'workspace' ? params.directory : resolveNeutralLaunchCwd(params.processEnv);
  } else if (Object.keys(params.resolvedEnv).length === 0 && cwd === undefined && !params.agentLaunchMaterials) {
    return { ok: true, config: { command, args } };
  }

  return {
    ok: true,
    config: await materializePrivateStdioLaunch({ command, args, env: launchEnv, cwd,
      tmpDir: params.tmpDir, deps: params.deps, writtenPaths: params.writtenPaths, assertCurrent: params.assertCurrent,
      agentLaunchMaterials: params.agentLaunchMaterials }),
  };
}

async function materializeRemoteServer(params: Readonly<{
  server: McpServerCatalogEntryV1;
  resolvedUrl: string;
  urlRedactionValues: readonly string[];
  resolvedEnv: Record<string, string>;
  resolvedHeaders: Record<string, string>;
  tmpDir: string | null;
  deps: Deps;
  writtenPaths: string[];
  assertCurrent?: () => Promise<void>;
  requestAuth?: McpRequestAuthCapability;
  agentLaunchMaterials?: PrivateConfigMaterialization;
}>): Promise<McpServerConfig | null> {
  if (params.server.transport === 'stdio' || !params.server.remote) return null;

  const bridgeCommand = await (params.deps.resolveRemoteBridgeCommand?.() ?? resolveDefaultRemoteBridgeCommand());

  const configPath = await materializePrivateRuntimeConfig({
    prefix: 'happier-mcp-remote-bridge',
    tmpDir: params.tmpDir,
    writtenPaths: params.writtenPaths,
    agentLaunchMaterials: params.agentLaunchMaterials,
    assertCurrent: params.assertCurrent,
    payload: {
      transport: params.server.transport,
      url: params.resolvedUrl,
      ...(params.urlRedactionValues.length > 0 ? { redactionValues: params.urlRedactionValues } : {}),
      headers: params.resolvedHeaders,
      ...(params.requestAuth ? { auth: params.requestAuth } : {}),
    },
  });

  const env = {
    ...(bridgeCommand.env ?? {}),
    HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
  };

  if (Object.keys(params.resolvedEnv).length > 0) {
    return materializePrivateStdioLaunch({
      command: bridgeCommand.command,
      args: bridgeCommand.args,
      env: { ...env, ...params.resolvedEnv, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath },
      tmpDir: params.tmpDir,
      deps: params.deps,
      writtenPaths: params.writtenPaths,
      assertCurrent: params.assertCurrent,
      agentLaunchMaterials: params.agentLaunchMaterials,
    });
  }
  return {
    command: bridgeCommand.command,
    args: bridgeCommand.args,
    env,
  };
}

export async function materializeMcpServerConfigRecord(params: Readonly<{
  resolved: McpServerMaterializationV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  session?: Parameters<typeof resolveValueRefPlaintext>[0]['session'];
  processEnv?: ProcessEnvInput;
  tmpDir: string | null;
  strictMode?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => Promise<void>;
  deps?: Deps;
  requestAuthByServerId?: Readonly<Record<string, McpRequestAuthCapability>>;
  requestAuthFailuresByServerId?: Readonly<Record<string, McpRequestAuthFailureCode>>;
  agentLaunchTarget?: AgentLaunchMaterializationTarget;
}>): Promise<MaterializeMcpServerConfigRecordResult> {
  const strictMode = params.strictMode ?? params.resolved.strictMode;
  const processEnv = params.processEnv ?? process.env;
  const deps: Deps = params.deps ?? {};
  const assertCurrent = async () => {
    params.signal?.throwIfAborted();
    await params.assertCurrent?.();
    params.signal?.throwIfAborted();
  };

  const mcpServers: Record<string, McpServerConfig> = {};
  const warnings: MaterializeMcpServerConfigRecordWarning[] = [];
  const writtenPaths: string[] = [];
  const agentLaunchMaterials: PrivateConfigMaterialization | undefined = params.agentLaunchTarget
    ? { target: params.agentLaunchTarget, selectedMaterials: [] }
    : undefined;
  const diagnosticRedaction = createProviderRedactionLease({ values: [] });
  const cleanup = () => {
    diagnosticRedaction.close();
    let firstError: unknown = null;
    for (const path of writtenPaths.splice(0)) {
      try {
        removeWrittenMcpRuntimeConfigFile(path, params.tmpDir === null);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };

  try {
    for (const [serverName, item] of Object.entries(params.resolved.serversByName)) {
      if (item.enabled !== true) continue;
      await assertCurrent();
      const server = item.config;

      const resolvedEnv: Record<string, string> = {};
      let missingDetail: string | null = null;

      for (const [envKey, valueRef] of Object.entries(server.env)) {
        const resolved = resolveValueRefPlaintext({
          valueRef,
          savedSecretMaterializer: params.savedSecretMaterializer,
          processEnv,
          onResolvedValue: value => { if (value) diagnosticRedaction.add([value]); },
        });
        if (
          resolved.status !== 'ready'
          && resolved.status !== 'literal_unavailable'
          && resolved.status !== 'session_attested_unavailable'
        ) {
          throw new SavedSecretResolutionError({
            status: resolved.status,
            reference: resolved.reference,
            consumer: 'mcp',
            field: `env:${envKey}`,
          });
        }
        if (resolved.status !== 'ready') {
          missingDetail = `env:${envKey}`;
          break;
        }
        resolvedEnv[envKey] = resolved.value;
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
          writtenPaths,
          assertCurrent,
          agentLaunchMaterials,
        });
        if (!cfg || cfg.ok !== true) {
          const warning: MaterializeMcpServerConfigRecordWarning = {
            serverName,
            code: 'invalid_server',
            detail: cfg?.detail ?? 'missing stdio config',
          };
          if (strictMode) {
            throw new Error(`Failed to materialize MCP server ${serverName}: ${warning.detail}`);
          }
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

      let resolvedUrl = server.remote.url;
      const urlRedactionValues: string[] = [];
      if (server.remote.urlTemplate) {
        const resolved = resolveValueRefPlaintext({
          valueRef: server.remote.urlTemplate,
          savedSecretMaterializer: params.savedSecretMaterializer,
          processEnv,
          onResolvedValue: value => {
            if (value) { diagnosticRedaction.add([value]); urlRedactionValues.push(value); }
          },
        });
        if (resolved.status !== 'ready' && resolved.status !== 'literal_unavailable'
          && resolved.status !== 'session_attested_unavailable') {
          throw new SavedSecretResolutionError({ status: resolved.status, reference: resolved.reference,
            consumer: 'mcp', field: 'url' });
        }
        if (resolved.status !== 'ready') {
          if (strictMode) throw new Error(`Failed to materialize MCP server ${serverName}: missing url`);
          warnings.push({ serverName, code: 'missing_value_ref', detail: 'url' });
          continue;
        }
        resolvedUrl = resolved.value;
      }

      const resolvedHeaders: Record<string, string> = {};
      for (const [headerKey, valueRef] of Object.entries(server.remote.headers)) {
        const resolved = resolveValueRefPlaintext({
          valueRef,
          savedSecretMaterializer: params.savedSecretMaterializer,
          processEnv,
          session: params.session,
          onResolvedValue: value => { if (value) diagnosticRedaction.add([value]); },
        });
        // An unattested Session still has a usable MCP server. The integrator
        // decides whether its operation permits the omitted assertion.
        if (resolved.status === 'session_attested_unavailable') continue;
        if (
          resolved.status !== 'ready'
          && resolved.status !== 'literal_unavailable'
        ) {
          throw new SavedSecretResolutionError({
            status: resolved.status,
            reference: resolved.reference,
            consumer: 'mcp',
            field: `header:${headerKey}`,
          });
        }
        if (resolved.status !== 'ready') {
          missingDetail = `header:${headerKey}`;
          break;
        }
        resolvedHeaders[headerKey] = resolved.value;
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

      let requestAuth = server.remote.auth?.kind === 'oauth' ? params.requestAuthByServerId?.[server.id] : undefined;
      let resourceMatches = false;
      if (requestAuth) {
        try {
          resourceMatches = canonicalMcpOAuthResourceUrlV1(requestAuth.resource) === canonicalMcpOAuthResourceUrlV1(resolvedUrl);
        } catch { /* Invalid private URLs refuse auth without disclosing resolved values in parser errors. */ }
      }
      if (server.remote.auth?.kind === 'oauth' && !resourceMatches) {
        const warning: MaterializeMcpServerConfigRecordWarning = { serverName, code: 'invalid_server',
          detail: requestAuth ? 'mcp_resource_mismatch' : params.requestAuthFailuresByServerId?.[server.id] ?? 'mcp_sign_in_required' };
        if (strictMode) throw new Error(warning.detail);
        warnings.push(warning);
        continue;
      }
      if (requestAuth && agentLaunchMaterials) {
        await assertCurrent();
        let document: ReturnType<typeof parseConnectedAccountRequestAuthCapabilityDocument> = null;
        try {
          document = parseConnectedAccountRequestAuthCapabilityDocument(JSON.parse(
            await readProtectedLocalStateFile(requestAuth.capabilityFile)));
        } catch { /* A private path or malformed document is never diagnostic text. */ }
        await assertCurrent();
        if (!document) throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Selected MCP request authentication is unavailable', retryable: false,
          details: { phase: 'native_execution_preparation' } });
        const capabilityFile = await materializePrivateRuntimeConfig({
          prefix: 'happier-mcp-request-auth', payload: document, tmpDir: params.tmpDir,
          writtenPaths, assertCurrent, agentLaunchMaterials,
        });
        requestAuth = { ...requestAuth, capabilityFile };
      }
      const remoteCfg = await materializeRemoteServer({
        server,
        resolvedUrl,
        urlRedactionValues,
        resolvedEnv,
        resolvedHeaders,
        tmpDir: params.tmpDir,
        deps,
        writtenPaths,
        requestAuth,
        assertCurrent,
        agentLaunchMaterials,
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

    await assertCurrent();
    return { mcpServers, warnings, cleanup, sanitizeDiagnosticText: diagnosticRedaction.redact,
      ...(agentLaunchMaterials ? { selectedMaterials: Object.freeze([...agentLaunchMaterials.selectedMaterials]) } : {}),
      createDiagnosticStreamingSanitizer: diagnosticRedaction.createStreamingSanitizer };
  } catch (error) {
    cleanup();
    throw error;
  }
}
