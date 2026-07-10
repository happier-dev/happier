import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  buildBackendTargetKeyV2,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

import {
  createCodexAppServerRuntime,
  startCodexAppServerRuntime,
} from './runtime.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = readRecord(value);
  const output: Record<string, string> = {};
  if (!record) return output;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') output[key] = child;
  }
  return output;
}

function readDirectory(value: unknown): string {
  const record = readRecord(value);
  return readString(record?.directory) ?? readString(record?.cwd) ?? process.cwd();
}

function readProcessEnv(ctx: PluginContextV1, value: unknown): Readonly<Record<string, string>> {
  const record = readRecord(value);
  const isolation = readRecord(record?.isolation);
  const unsetEnvKeys = Array.isArray(isolation?.unsetEnvKeys)
    ? isolation.unsetEnvKeys.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return composeSessionIsolationEnvironment({
    inheritedEnvironment: ctx.env.list(),
    isolationEnvironment: readStringRecord(isolation?.env),
    environment: readStringRecord(record?.env),
    unsetEnvKeys,
  });
}

function readHappierSessionId(value: unknown): string {
  const record = readRecord(value);
  const session = readRecord(record?.session);
  return readString(session?.sessionId)
    ?? readString(record?.sessionId)
    ?? 'codex-plugin-session';
}

function readInitialProviderSessionId(value: unknown): string | null {
  const record = readRecord(value);
  const initialRuntimeState = readRecord(record?.initialRuntimeState);
  return readString(initialRuntimeState?.providerSessionId)
    ?? readString(initialRuntimeState?.resumeSessionId)
    ?? readString(record?.resume)
    ?? readString(record?.resumeSessionId)
    ?? readString(record?.existingSessionId);
}

function normalizeModelOverride(value: unknown): string | null {
  const modelId = readString(value);
  return modelId && modelId !== 'default' ? modelId : null;
}

function readInitialModelId(sessionParams: CreateSessionRuntimeParamsV1): string | null {
  const sessionParamsRecord = readRecord(sessionParams);
  const metadata = readRecord(sessionParams.metadata);
  const targetKey = buildBackendTargetKeyV2({
    kind: 'backend',
    backendId: 'codex',
    sourceKind: 'built_in',
  });
  const hasExplicitSelection = sessionParams.modelSelection !== undefined;
  const explicitSelection = SessionModelSelectionV1Schema.safeParse(sessionParams.modelSelection);
  if (explicitSelection.success) {
    if (explicitSelection.data.ref.agentTargetKey !== targetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
    }
    return explicitSelection.data.ref.modelId;
  }
  if (hasExplicitSelection) {
    throw new Error('Invalid session model selection');
  }
  const explicitLegacyModelId = normalizeModelOverride(sessionParamsRecord?.modelId);
  if (explicitLegacyModelId) return explicitLegacyModelId;
  const intent = resolveSessionModelSelectionIntentV1({
    canonical: metadata?.modelSelectionIntentV1,
    legacy: metadata?.modelOverrideV1,
    agentTargetKey: targetKey,
  });
  return intent?.selection?.modelId ?? null;
}

function readImportHistory(value: unknown): boolean {
  const record = readRecord(value);
  const initialRuntimeState = readRecord(record?.initialRuntimeState);
  return initialRuntimeState?.importHistory === true || record?.importHistory === true;
}

function readSessionPermissionMode(sessionParams: CreateSessionRuntimeParamsV1): string {
  const serviceMode = sessionParams.services?.permissions.getMode();
  if (typeof serviceMode === 'string' && serviceMode.trim().length > 0) {
    return serviceMode.trim();
  }
  const metadata = readRecord(sessionParams.metadata);
  return readString(sessionParams.permissionMode)
    ?? readString(metadata?.permissionMode)
    ?? 'default';
}

export async function createCodexAppServerSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<SessionRuntimeV1> {
  const initialDirectory = readDirectory(params.sessionParams);
  const initialProcessEnv = readProcessEnv(params.ctx, params.sessionParams);
  const initialHappierSessionId = readHappierSessionId(params.sessionParams);
  const initialProviderSessionId = readInitialProviderSessionId(params.sessionParams);
  const initialModelId = readInitialModelId(params.sessionParams);

  const runtime = createCodexAppServerRuntime({
    ctx: params.ctx,
    directory: initialDirectory,
    happierSessionId: initialHappierSessionId,
    initialProviderSessionId,
    initialModelId,
    processEnv: initialProcessEnv,
    mcpServers: params.sessionParams.mcpServers,
    resolveCurrentPolicy: () => resolveCodexTerminalPermissionPolicy(readSessionPermissionMode(params.sessionParams)),
  });

  await startCodexAppServerRuntime(runtime, {
    ...(initialProviderSessionId ? { resumeId: initialProviderSessionId } : {}),
    importHistory: readImportHistory(params.sessionParams),
    preserveRequestedThreadId: Boolean(initialProviderSessionId),
  });

  return runtime;
}
