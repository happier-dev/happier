import type { AcpTransportSpecV1 } from '@happier-dev/plugin-sdk';
import type { ExecRuntimeServiceV1, PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { SystemToolLaunchGrantV1 } from '@happier-dev/plugin-sdk';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import type { CatalogAgentLookupId } from '@/backends/types';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

import type { AcpRuntimeDefinitionV1 } from './_types';
import { withAcpLaunchEnvDefaults } from './env';
import { assertAcpRuntimeDefinitionSupported } from './support';
import {
  isPromiseLike,
  mapMaybePromise,
  type MaybePromise,
  resolveAcpTier2Argv,
  resolveAcpTier2Env,
} from './tier2Callbacks';

export type AcpExecutableLaunch = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  agentCliGrant?: Readonly<{
    agentId: string;
    runtimeArgsPrefix: readonly string[];
  }>;
}>;

const MAX_AUTH_ENV_ERROR_DIAGNOSTIC_CHARS = 500;

export function mergeDefinedStringEnv(
  ...sources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function hasOwnDefined(record: Readonly<Record<string, unknown>> | undefined, key: string): boolean {
  return record ? Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined : false;
}

function requireStdioLaunch(
  definition: AcpRuntimeDefinitionV1,
  cwd: string,
  pluginContext: PluginContextV1 | undefined,
  exec: Pick<ExecRuntimeServiceV1, 'systemTools'> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): MaybePromise<AcpExecutableLaunch> {
  const transport: AcpTransportSpecV1 = definition.transport;
  if (transport.kind !== 'stdio') {
    throw new Error(`ACP backend '${definition.backendId}' uses unsupported ${transport.kind} transport in the current host runtime.`);
  }
  if (transport.launch.kind === 'executable') {
    return {
      command: transport.launch.command,
      args: [...(transport.launch.args ?? [])],
      env: withAcpLaunchEnvDefaults({
        ...definition.launchEnv,
        ...(transport.launch.env ?? {}),
      }),
    };
  }
  if (transport.launch.kind === 'system-tool') {
    const systemTools = exec?.systemTools ?? pluginContext?.exec.systemTools;
    if (!systemTools) {
      throw new Error(
        `ACP backend '${definition.backendId}' system-tool launch requires a plugin runtime context or exec bridge.`,
      );
    }
    return systemTools.resolve({
      toolId: transport.launch.toolId,
      purpose: transport.launch.purpose,
      cwd,
      ...(transport.launch.preferredPath !== undefined ? { preferredPath: transport.launch.preferredPath } : {}),
      ...(transport.launch.preferredCommand !== undefined ? { preferredCommand: transport.launch.preferredCommand } : {}),
    }).then((grant) => buildSystemToolLaunch({
      definition,
      grant,
      launchArgs: transport.launch.args ?? [],
      launchEnv: transport.launch.env ?? {},
    }));
  }

  const launch = requireProviderCliLaunchSpec(transport.launch.agentId as CatalogAgentLookupId, { processEnv });
  const runtimeArgsPrefix = [...launch.args];
  return {
    command: launch.command,
    args: [
      ...runtimeArgsPrefix,
      ...(transport.launch.args ?? []),
    ],
    env: withAcpLaunchEnvDefaults({
      ...definition.launchEnv,
      ...(transport.launch.env ?? {}),
    }),
    agentCliGrant: {
      agentId: transport.launch.agentId,
      runtimeArgsPrefix,
    },
  };
}

function buildSystemToolLaunch(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  grant: SystemToolLaunchGrantV1;
  launchArgs: readonly string[];
  launchEnv: Readonly<Record<string, string>>;
}>): AcpExecutableLaunch {
  if (params.grant.launch.kind !== 'binary') {
    throw new Error(
      `ACP backend '${params.definition.backendId}' system-tool launch '${params.grant.toolId}' resolved to unsupported ${params.grant.launch.kind} launch.`,
    );
  }
  return {
    command: params.grant.launch.executablePath,
    args: [
      ...(params.grant.launch.args ?? []),
      ...params.launchArgs,
    ],
    env: withAcpLaunchEnvDefaults({
      ...params.definition.launchEnv,
      ...(params.grant.launch.env ?? {}),
      ...params.launchEnv,
    }),
  };
}

function appendPermissionModeArgs(
  args: readonly string[],
  definition: AcpRuntimeDefinitionV1,
  permissionMode?: string,
): readonly string[] {
  const mode = typeof permissionMode === 'string' ? permissionMode.trim() : '';
  const spec = definition.permissionModeArgv;
  if (!spec || mode.length === 0 || !hasOwnDefined(spec.map, mode)) {
    return args;
  }

  const mapped = spec.map[mode];
  if (mapped === null) {
    return args;
  }
  return [...args, spec.flag, mapped];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeAuthEnvDiagnostic(error: unknown): string {
  const redacted = redactBugReportSensitiveText(errorMessage(error))
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s,;]+)/gi, '$1=<redacted>');
  return redacted.length > MAX_AUTH_ENV_ERROR_DIAGNOSTIC_CHARS
    ? `${redacted.slice(0, MAX_AUTH_ENV_ERROR_DIAGNOSTIC_CHARS)}...`
    : redacted;
}

function validateAuthEnv(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  value: unknown;
}>): Readonly<Record<string, string>> {
  if (!params.value || typeof params.value !== 'object' || Array.isArray(params.value)) {
    throw new Error(`ACP backend '${params.definition.backendId}' auth.buildAuthEnv callback returned an invalid environment record.`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.value)) {
    if (typeof value !== 'string') {
      throw new Error(`ACP backend '${params.definition.backendId}' auth.buildAuthEnv callback returned a non-string environment value.`);
    }
    env[key] = value;
  }
  return Object.freeze(env);
}

function resolveAcpAuthEnv(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  pluginContext?: PluginContextV1;
}>): Readonly<Record<string, string>> {
  const callback = params.definition.auth?.buildAuthEnv;
  if (!callback) {
    return Object.freeze({});
  }
  if (!params.pluginContext) {
    throw new Error(
      `ACP backend '${params.definition.backendId}' auth.buildAuthEnv callback requires a plugin runtime context.`,
    );
  }
  try {
    return validateAuthEnv({
      definition: params.definition,
      value: callback(params.pluginContext),
    });
  } catch (error) {
    throw new Error(
      `ACP backend '${params.definition.backendId}' auth.buildAuthEnv callback failed: ${sanitizeAuthEnvDiagnostic(error)}`,
      { cause: error },
    );
  }
}

export function resolveAcpRuntimeLaunch(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
  permissionMode?: string;
  env?: Readonly<Record<string, string | undefined>>;
  processEnv?: NodeJS.ProcessEnv;
  pluginContext?: PluginContextV1;
  exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
}>): MaybePromise<AcpExecutableLaunch> {
  assertAcpRuntimeDefinitionSupported(params.definition);
  const launch = requireStdioLaunch(
    params.definition,
    params.cwd,
    params.pluginContext,
    params.exec,
    params.processEnv ?? mergeDefinedStringEnv(process.env, params.env),
  );
  const resolveLaunch = (resolvedLaunch: AcpExecutableLaunch): MaybePromise<AcpExecutableLaunch> => {
    const launchEnv = mergeDefinedStringEnv(
      params.env,
      resolvedLaunch.env,
      resolveAcpAuthEnv({
        definition: params.definition,
        pluginContext: params.pluginContext,
      }),
    );
    const baseArgs = appendPermissionModeArgs(resolvedLaunch.args, params.definition, params.permissionMode);
    const buildLaunch = (resolvedArgs: readonly string[], resolvedEnv: Readonly<Record<string, string>>): AcpExecutableLaunch => ({
      ...resolvedLaunch,
      args: resolvedArgs,
      env: resolvedEnv,
    });
    const resolveCallbacks = (): MaybePromise<AcpExecutableLaunch> => {
      const args = resolveAcpTier2Argv({
        definition: params.definition,
        baseArgs,
        cwd: params.cwd,
        env: launchEnv,
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
      });
      const env = mapMaybePromise(args, () => resolveAcpTier2Env({
        definition: params.definition,
        cwd: params.cwd,
        env: launchEnv,
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
      }));
      if (isPromiseLike(args) || isPromiseLike(env)) {
        return Promise.all([args, env]).then(([resolvedArgs, resolvedEnv]) => buildLaunch(resolvedArgs, resolvedEnv));
      }
      return buildLaunch(args, env);
    };
    return params.definition.callbacks.argvBuilder || params.definition.callbacks.envBuilder
      ? Promise.resolve().then(resolveCallbacks)
      : resolveCallbacks();
  };
  return isPromiseLike(launch)
    ? launch.then(resolveLaunch)
    : resolveLaunch(launch);
}
