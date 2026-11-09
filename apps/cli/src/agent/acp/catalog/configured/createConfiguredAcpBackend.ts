import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions } from '@/agent/catalog/factoryOptions';
import type { McpServerConfig } from '@/agent/core/AgentTypes';
import {
  createAcpBackendFromDefinition,
  normalizeConfiguredAcpDefinition,
} from '@/agent/acp/runtime/definition';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';
import { resolveAcpLaunch } from './resolveAcpLaunch';

export type ConfiguredAcpBackendOptions = AgentFactoryOptions & Readonly<{
  accountId?: string;
  backend: ResolvedConfiguredAcpBackend;
  launchEnv: Readonly<Record<string, string>>;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: string;
}>;

export async function createConfiguredAcpBackend(
  options: ConfiguredAcpBackendOptions,
): Promise<AcpBackend> {
  const launch = await resolveAcpLaunch({
    accountId: options.accountId,
    definition: { id: options.backend.backendId, title: options.backend.title, launch: options.backend.launch },
    platform: process.platform, arch: process.arch, env: { ...process.env, ...options.env },
    launchEnv: options.launchEnv,
    cwd: options.cwd,
  });
  if (launch.kind !== 'ready') throw new Error('Configured ACP launch is not installed or cannot run on this machine');
  const definition = normalizeConfiguredAcpDefinition({
    backend: options.backend,
    launch,
    launchEnv: options.launchEnv,
  });

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
  });
}
