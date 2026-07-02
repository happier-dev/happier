import type { ExecRuntimeServiceV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { McpServerConfig } from '@/agent/core';

import type { AcpRuntimeDefinitionV1 } from './_types';
import { resolveAcpAuthenticateMeta } from './auth';
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
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  pluginContext?: PluginContextV1;
  exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
}>): MaybePromise<AcpBackend> {
  const launch = resolveAcpRuntimeLaunch({
    definition: params.definition,
    cwd: params.cwd,
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.env ? { env: params.env } : {}),
    ...(params.pluginContext ? { pluginContext: params.pluginContext } : {}),
    ...(params.exec ? { exec: params.exec } : {}),
  });
  const mcpServers = params.definition.mcp.policy === 'drop'
    ? undefined
    : params.mcpServers;
  const authMeta = resolveAcpAuthenticateMeta({
    definition: params.definition,
    ...(params.pluginContext ? { pluginContext: params.pluginContext } : {}),
  });
  const createBackend = (resolvedLaunch: Awaited<typeof launch>): MaybePromise<AcpBackend> => {
    const preflight = runAcpTier2Preflight({
      definition: params.definition,
      cwd: params.cwd,
    });
    return mapMaybePromise(preflight, () => createAcpBackend({
      agentName: params.definition.backendId,
      cwd: params.cwd,
      command: resolvedLaunch.command,
      args: [...resolvedLaunch.args],
      env: mergeDefinedStringEnv(params.env, resolvedLaunch.env),
      ...(mcpServers ? { mcpServers } : {}),
      ...(typeof params.definition.fsEnabled === 'boolean' ? { fsEnabled: params.definition.fsEnabled } : {}),
      permissionHandler: composeAcpTier2PermissionHandler({
        definition: params.definition,
        permissionHandler: params.permissionHandler,
      }),
      transportHandler: createAcpTransportHandlerFromDefinition(params.definition),
      ...(params.definition.auth?.methodId ? { authMethodId: params.definition.auth.methodId } : {}),
      ...(authMeta ? { authMeta } : {}),
    }));
  };

  return isPromiseLike(launch)
    ? launch.then(createBackend)
    : createBackend(launch);
}

export function createSynchronousAcpBackendFromDefinition(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  pluginContext?: PluginContextV1;
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
