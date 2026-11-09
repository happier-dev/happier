import { isAbsolute } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { PluginAgentAcpTransport } from '@happier-dev/protocol';

import {
  resolvePluginExecManagedDependencyForHost,
  resolvePluginExecSystemToolForHost,
} from '@/plugins/runtime/invocation/services/exec';
import { normalizeUnsetEnvKeys, stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';

/**
 * One owner for turning a declared ACP transport into an executable launch.
 *
 * Every ACP connection the host opens — the Session composer and the auxiliary
 * `session/list` source alike — resolves its executable here, so plugin-identity
 * custody, exact-grant validation, managed-dependency release ownership and
 * launch-environment merging cannot drift between them.
 */

type PublicAcpSystemToolGrant = Readonly<{
  toolId: string;
  launch: Readonly<{
    kind: string;
    executablePath: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>;
}>;

export type PublicAcpSystemTools = Readonly<{
  resolve(request: Readonly<{
    toolId: string;
    purpose: string;
    cwd?: string;
    preferredPath?: string | null;
    signal?: AbortSignal;
  }>): Promise<PublicAcpSystemToolGrant>;
}>;

export type PublicAcpManagedDependencies = Readonly<{
  resolve(request: Readonly<{
    pluginId: string;
    dependencyId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release(): void;
  }>>;
}>;

export type PublicAcpTransportTimeouts = Readonly<{
  initializeMs?: number;
  idleMs?: number;
}>;

export type PublicAcpHostLaunch = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  unsetEnv: readonly string[];
  timeouts: PublicAcpTransportTimeouts;
  release?: () => void;
}>;

export type PublicAcpResolvedTransport =
  | (PublicAcpHostLaunch & Readonly<{ kind: 'stdio' }>)
  | Readonly<{
      kind: 'webSocket';
      url: string;
      headers?: Readonly<Record<string, string>>;
      timeouts: PublicAcpTransportTimeouts;
    }>
  | Readonly<{
      kind: 'tcp';
      host: string;
      port: number;
      timeouts: PublicAcpTransportTimeouts;
    }>;

export type AcpLaunchEnvironmentOverrides = Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}>;

const NO_LAUNCH_ENVIRONMENT: AcpLaunchEnvironmentOverrides = Object.freeze({
  values: Object.freeze({}),
  unset: Object.freeze([]),
});

export function createPublicAcpSystemTools(
  exec: ExecService,
  pluginId: string,
): PublicAcpSystemTools {
  return Object.freeze({
    async resolve(request) {
      const resolved = await resolvePluginExecSystemToolForHost(exec, request);
      const executable = resolved.executable;
      const localId = executable.kind === 'systemTool'
        ? typeof executable.id === 'string'
          ? executable.id
          : executable.id.pluginId === pluginId
            ? executable.id.localId
            : null
        : null;
      if (executable.kind !== 'systemTool' || localId !== request.toolId) {
        throw new PluginError({
          code: 'plugin_exec_system_tool_resolution_invalid',
          message: `ACP system tool '${request.toolId}' did not resolve to its exact declared executable`,
        });
      }
      return Object.freeze({
        toolId: request.toolId,
        launch: Object.freeze({
          kind: 'binary',
          executablePath: resolved.command,
          ...(resolved.args ? { args: resolved.args } : {}),
          ...(resolved.env ? { env: resolved.env } : {}),
        }),
      });
    },
  });
}

export function createPublicAcpManagedDependencies(
  exec: ExecService,
  pluginId: string,
): PublicAcpManagedDependencies {
  return Object.freeze({
    async resolve(request) {
      if (request.pluginId !== pluginId) {
        throw new PluginError({
          code: 'plugin_exec_managed_dependency_denied',
          message: 'ACP managed-dependency resolution cannot cross plugin identity',
        });
      }
      return await resolvePluginExecManagedDependencyForHost(
        exec,
        request.dependencyId,
        { signal: request.signal },
      );
    },
  });
}

function readLocalExecutableId(
  executable: Extract<PluginAgentAcpTransport, { kind: 'stdio' }>['executable'],
  pluginId: string,
): string {
  if (typeof executable.id === 'string') return executable.id;
  if (executable.id.pluginId !== pluginId) {
    throw new Error(
      `Public ACP composition cannot launch another plugin's ${
        executable.kind === 'systemTool' ? 'system tool' : 'managed dependency'
      }`,
    );
  }
  return executable.id.localId;
}

/**
 * Resolves the declared transport into the launch the ACP client will use.
 *
 * `cwd` is the caller's authoritative working directory and is forwarded to
 * system-tool resolution only when one exists; an auxiliary call that has no
 * Session workspace omits it rather than substituting the daemon's own cwd.
 */
export async function resolveAcpTransportLaunch(params: Readonly<{
  transport: PluginAgentAcpTransport;
  pluginId: string;
  /** Audit purpose recorded by system-tool custody. */
  purpose: string;
  cwd?: string;
  launchEnvironment?: AcpLaunchEnvironmentOverrides;
  systemTools: PublicAcpSystemTools;
  managedDependencies?: PublicAcpManagedDependencies;
  signal: AbortSignal;
  /** Throws when the caller's generation stopped being current mid-resolution. */
  assertCurrent?: () => void;
  resolveHostLaunch?: () => PublicAcpHostLaunch | Promise<PublicAcpHostLaunch>;
}>): Promise<PublicAcpResolvedTransport> {
  const transport = params.transport;
  const launchEnvironment = params.launchEnvironment ?? NO_LAUNCH_ENVIRONMENT;
  const assertCurrent = params.assertCurrent ?? (() => { params.signal.throwIfAborted(); });
  if (params.resolveHostLaunch) {
    const resolved = await params.resolveHostLaunch();
    assertCurrent();
    const command = resolved.command.trim();
    if (!command) {
      resolved.release?.();
      throw new Error('Host-resolved ACP launch requires a non-empty command');
    }
    const unsetEnv = normalizeUnsetEnvKeys([...resolved.unsetEnv, ...launchEnvironment.unset]);
    const environment = stripUnsetEnvironmentVariables({
      ...resolved.env,
      ...launchEnvironment.values,
    }, unsetEnv);
    return Object.freeze({
      kind: 'stdio' as const,
      command,
      args: Object.freeze([...resolved.args]),
      env: Object.freeze(environment),
      unsetEnv,
      timeouts: resolved.timeouts,
      ...(resolved.release ? { release: resolved.release } : {}),
    });
  }
  if (transport.kind !== 'stdio') {
    return Object.freeze({
      ...transport,
      timeouts: transport.timeouts ?? Object.freeze({}),
    });
  }
  const executableId = readLocalExecutableId(transport.executable, params.pluginId);
  let command: string;
  let args: readonly string[] | undefined;
  let env: Readonly<Record<string, string>> | undefined;
  let release: (() => void) | undefined;
  if (transport.executable.kind === 'systemTool') {
    const grant = await params.systemTools.resolve({
      toolId: executableId,
      purpose: params.purpose,
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      preferredPath: transport.preferredPath,
      signal: params.signal,
    });
    assertCurrent();
    if (grant.toolId !== executableId || grant.launch.kind !== 'binary') {
      throw new Error(`ACP system tool '${executableId}' did not resolve to its exact binary grant`);
    }
    command = grant.launch.executablePath;
    args = grant.launch.args;
    env = grant.launch.env;
  } else {
    if (transport.preferredPath !== undefined && transport.preferredPath !== null) {
      throw new Error('Managed-dependency ACP transports cannot override their resolved executable path');
    }
    if (!params.managedDependencies) {
      throw new Error('Managed-dependency ACP resolution is unavailable in this host');
    }
    const resolved = await params.managedDependencies.resolve({
      pluginId: params.pluginId,
      dependencyId: executableId,
      signal: params.signal,
    });
    try {
      assertCurrent();
      if (!isAbsolute(resolved.command)) {
        throw new Error(`ACP managed dependency '${executableId}' did not resolve to an absolute executable path`);
      }
    } catch (error) {
      resolved.release();
      throw error;
    }
    command = resolved.command;
    args = resolved.args;
    env = resolved.env;
    release = resolved.release;
  }
  const environment = stripUnsetEnvironmentVariables({
    ...(env ?? {}),
    ...(transport.env ?? {}),
    ...launchEnvironment.values,
  }, launchEnvironment.unset);
  return Object.freeze({
    kind: 'stdio' as const,
    command,
    args: Object.freeze([...(args ?? []), ...(transport.args ?? [])]),
    env: Object.freeze(environment),
    unsetEnv: launchEnvironment.unset,
    timeouts: transport.timeouts ?? Object.freeze({}),
    ...(release ? { release } : {}),
  });
}
