import type { AcpTransportSpecV1 } from '@happier-dev/plugin-sdk';

import type { CatalogAgentLookupId } from '@/backends/types';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

import type { AcpRuntimeDefinitionV1 } from './_types';
import { withAcpLaunchEnvDefaults } from './env';
import { assertAcpRuntimeDefinitionSupported } from './support';

export type AcpExecutableLaunch = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

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
  processEnv: NodeJS.ProcessEnv = process.env,
): AcpExecutableLaunch {
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

  const launch = requireProviderCliLaunchSpec(transport.launch.agentId as CatalogAgentLookupId, { processEnv });
  return {
    command: launch.command,
    args: [
      ...launch.args,
      ...(transport.launch.args ?? []),
    ],
    env: withAcpLaunchEnvDefaults({
      ...definition.launchEnv,
      ...(transport.launch.env ?? {}),
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

export function resolveAcpRuntimeLaunch(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
  permissionMode?: string;
  env?: Readonly<Record<string, string | undefined>>;
  processEnv?: NodeJS.ProcessEnv;
}>): AcpExecutableLaunch {
  assertAcpRuntimeDefinitionSupported(params.definition);
  const launch = requireStdioLaunch(
    params.definition,
    params.processEnv ?? mergeDefinedStringEnv(process.env, params.env),
  );
  return {
    ...launch,
    args: appendPermissionModeArgs(launch.args, params.definition, params.permissionMode),
  };
}
