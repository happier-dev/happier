import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions } from '@/agent/catalog/factoryOptions';
import type { McpServerConfig } from '@/agent/core/AgentTypes';
import {
  createAcpBackendFromDefinition,
  normalizeConfiguredAcpDefinition,
} from '@/agent/acp/runtime/definition';
import { createPluginExecService } from '@/plugins/runtime/exec/hostService';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export type ConfiguredAcpBackendOptions = AgentFactoryOptions & Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv: Readonly<Record<string, string>>;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: string;
}>;

function readDefinedProcessEnv(
  ...sources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
  }
  return Object.freeze(env);
}

export async function createConfiguredAcpBackend(
  options: ConfiguredAcpBackendOptions,
): Promise<AcpBackend> {
  const definition = normalizeConfiguredAcpDefinition({
    backend: options.backend,
    launchEnv: options.launchEnv,
  });

  const pluginSource = options.backend.source.kind === 'plugin_contributed'
    ? options.backend.source
    : null;
  const exec = pluginSource
      ? createPluginExecService({
        systemTools: projectPluginSystemToolContributions(pluginSource.systemTools),
        baseEnv: readDefinedProcessEnv(process.env, options.env, options.launchEnv),
      })
    : undefined;

  return await createAcpBackendFromDefinition({
    definition,
    cwd: options.cwd,
    env: {
      ...(options.env ?? {}),
      ...options.launchEnv,
    },
    permissionMode: options.permissionMode,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    ...(exec ? { exec } : {}),
  });
}
