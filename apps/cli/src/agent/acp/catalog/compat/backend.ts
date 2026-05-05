import type { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

import type { BuiltInAcpBackendOptions } from '../builtIn/backend';
import { resolveAcpCatalogTransportHandler } from '../transport/resolveAcpCatalogTransportHandler';
import {
  LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
  LEGACY_CUSTOM_ACP_COMPAT_LAUNCH_ARGS,
  LEGACY_CUSTOM_ACP_COMPAT_TRANSPORT_PROFILE,
} from './customAcp';

export function createCustomAcpCompatBackend(options: BuiltInAcpBackendOptions): AcpBackend {
  const launch = requireProviderCliLaunchSpec(LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID, {
    processEnv: { ...process.env, ...options.env },
  });

  return createAcpBackend({
    agentName: LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, ...LEGACY_CUSTOM_ACP_COMPAT_LAUNCH_ARGS],
    env: {
      ...options.env,
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: resolveAcpCatalogTransportHandler(LEGACY_CUSTOM_ACP_COMPAT_TRANSPORT_PROFILE),
  });
}
