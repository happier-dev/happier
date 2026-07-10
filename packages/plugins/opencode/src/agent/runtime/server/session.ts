import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import {
  readOpenCodeServerEndpoint,
  readOpenCodeSessionEnvironment,
} from './endpoint.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { createOpenCodeStartupDeferredSessionRuntime } from './startupDeferredSessionRuntime.js';

function readDirectory(sessionParams: unknown): string {
  const record = asRecord(sessionParams);
  return normalizeString(record?.cwd)
    || normalizeString(record?.directory)
    || process.cwd();
}

function readSessionId(sessionParams: unknown): string {
  const record = asRecord(sessionParams);
  return normalizeString(record?.sessionId) || `opencode-${Date.now().toString(36)}`;
}

function readPermissionMode(sessionParams: unknown): string | null {
  return normalizeString(asRecord(sessionParams)?.permissionMode) || null;
}

function readModelId(sessionParams: unknown): string | null {
  const modelId = normalizeString(asRecord(sessionParams)?.modelId);
  return modelId && modelId !== 'default' ? modelId : null;
}

export async function createOpenCodeServerSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<SessionRuntimeV1> {
  const initialDirectory = readDirectory(params.sessionParams);
  const initialSessionId = readSessionId(params.sessionParams);
  const permissionMode = readPermissionMode(params.sessionParams);
  const env = composeSessionIsolationEnvironment({
    inheritedEnvironment: params.ctx.env.list(),
    isolationEnvironment: params.sessionParams.isolation?.env,
    environment: params.sessionParams.env,
    unsetEnvKeys: params.sessionParams.isolation?.unsetEnvKeys,
  });
  const endpoint = readOpenCodeServerEndpoint(params.ctx, { env });

  const runtime = createOpenCodeStartupDeferredSessionRuntime({
    ctx: params.ctx,
    directory: initialDirectory,
    happierSessionId: initialSessionId,
    endpoint,
    env,
    permissionMode,
    mcpServers: params.sessionParams.mcpServers,
  });
  const modelId = readModelId(params.sessionParams);
  if (modelId) await runtime.updateConfig?.({ modelId });
  return runtime;
}
