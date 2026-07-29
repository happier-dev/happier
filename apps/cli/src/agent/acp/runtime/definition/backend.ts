import type { ExecRuntimeServiceV1 } from '@/plugins/runtime/exec/privateContract';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { McpServerConfig } from '@/agent/core/AgentTypes';

import type { AcpRuntimeDefinition } from './_types';
import { resolveAcpAuthMethodId } from './auth';
import { mergeDefinedStringEnv, resolveAcpRuntimeLaunch } from './launch';
import { createAcpTransportHandlerFromDefinition } from './transport';
import {
  composeAcpTier2PermissionHandler,
  isPromiseLike,
  mapMaybePromise,
  type MaybePromise,
  runAcpTier2Preflight,
} from './tier2Callbacks';

export function createAcpBackendFromDefinition(params: Readonly<{
  definition: AcpRuntimeDefinition;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  unsetEnvKeys?: readonly string[];
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
}>): MaybePromise<AcpBackend> {
  const launch = resolveAcpRuntimeLaunch({
    definition: params.definition,
    cwd: params.cwd,
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.env ? { env: params.env } : {}),
    ...(params.unsetEnvKeys ? { unsetEnvKeys: params.unsetEnvKeys } : {}),
    ...(params.exec ? { exec: params.exec } : {}),
  });
  const mcpServers = params.definition.mcp.policy === 'drop'
    ? undefined
    : params.mcpServers;
  const createBackend = (resolvedLaunch: Awaited<typeof launch>): MaybePromise<AcpBackend> => {
    const preflight = runAcpTier2Preflight({
      definition: params.definition,
      cwd: params.cwd,
    });
    const backendEnv = mergeDefinedStringEnv(params.env, resolvedLaunch.env);
    const authMethodId = resolveAcpAuthMethodId({
      definition: params.definition,
    });
    return mapMaybePromise(preflight, () => createAcpBackend({
      agentName: params.definition.backendId,
      cwd: params.cwd,
      command: resolvedLaunch.command,
      args: [...resolvedLaunch.args],
      env: backendEnv,
      ...(params.unsetEnvKeys ? { unsetEnv: params.unsetEnvKeys } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(typeof params.definition.fsEnabled === 'boolean' ? { fsEnabled: params.definition.fsEnabled } : {}),
      permissionHandler: composeAcpTier2PermissionHandler({
        definition: params.definition,
        permissionHandler: params.permissionHandler,
      }),
      transportHandler: createAcpTransportHandlerFromDefinition(params.definition),
      ...(authMethodId ? { authMethodId } : {}),
    }));
  };

  return isPromiseLike(launch)
    ? launch.then(createBackend)
    : createBackend(launch);
}

export function createSynchronousAcpBackendFromDefinition(params: Readonly<{
  definition: AcpRuntimeDefinition;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  unsetEnvKeys?: readonly string[];
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
}>): AcpBackend {
  if (
    params.definition.callbacks.argvBuilder
    || params.definition.callbacks.envBuilder
    || params.definition.callbacks.preflight
  ) {
    throw new Error(
      `ACP backend '${params.definition.backendId}' uses async Tier-2 startup callbacks and must be created through the async runtime path.`,
    );
  }
  const backend = createAcpBackendFromDefinition(params);
  if (isPromiseLike(backend)) {
    throw new Error(
      `ACP backend '${params.definition.backendId}' resolved asynchronously and must be created through the async runtime path.`,
    );
  }
  return backend;
}
