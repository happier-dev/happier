import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentPreflightJsonRpcRequestClientV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ProbedCatalogOptionValue } from '@happier-dev/protocol/capabilities';
import { normalizeSessionConfigOptionValue, readSessionConfigOptionsFromSessionResponse, readSessionModelStateFromConfigOptions, readSessionModelStateFromSessionResponse, resolveSessionModelConfigOption, type SessionConfigOption } from '@/agent/acp/sessionSettings/sessionSettingsState';
import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import { startAcpProbeSession } from './startAcpProbeSession';

export type AcpCatalogsProbeResult = Readonly<{
  commands: unknown[] | null;
  skills: unknown[] | null;
}>;

type AcpSessionControlsProbeResult = Readonly<{
  models: unknown;
  modes: unknown;
  configOptions: unknown;
  modelConfigOptionId?: string;
  refreshError?: boolean;
  refreshErrorMessage?: string;
  observedAt?: number;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

type AcpPreflightSessionParams = Readonly<{
  client: AgentPreflightJsonRpcRequestClientV1;
  cwd: string;
  signal: AbortSignal;
  authenticationMethodId?: string;
  modelConfigOptionId?: string;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
  selectAuthentication?: (initializeResult: JsonValue) => Readonly<{ methodId: string; metadata?: JsonValue }> | null;
}>;

async function withAcpPreflightSession<TResult>(
  params: AcpPreflightSessionParams,
  inspect: (session: Readonly<Record<string, unknown>>, readCommands: () => Promise<unknown[]>) => Promise<TResult> | TResult,
): Promise<TResult> {
  params.signal.throwIfAborted();
  let nativeSessionId: string | null = null;
  let supportsClose = false;
  const snapshots = new Map<string, unknown[]>();
  let resolveCommands!: (commands: unknown[]) => void;
  const commandsUpdate = new Promise<unknown[]>((resolve) => { resolveCommands = resolve; });
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(params.signal.reason ?? new Error('ACP catalog probe was aborted'));
    params.signal.addEventListener('abort', onAbort, { once: true });
  });
  const permissions = params.client.onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }));
  const notifications = params.client.onNotification((message) => {
    if (message.method !== 'session/update') return;
    const notification = asRecord(message.params);
    const update = asRecord(notification?.update);
    if (update?.sessionUpdate !== 'available_commands_update' || !Array.isArray(update.availableCommands)) return;
    const sessionId = notification?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) return;
    if (nativeSessionId === null) snapshots.set(sessionId, update.availableCommands);
    else if (nativeSessionId === sessionId) resolveCommands(update.availableCommands);
  });
  try {
    const discover = async (): Promise<TResult> => {
      const initializeResult = await params.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const initialized = asRecord(initializeResult);
      params.signal.throwIfAborted();
      const capabilities = asRecord(asRecord(initialized?.agentCapabilities)?.sessionCapabilities);
      supportsClose = asRecord(capabilities?.close) !== null;
      const authentication = params.selectAuthentication
        ? params.selectAuthentication(initializeResult)
        : params.authenticationMethodId ? { methodId: params.authenticationMethodId } : null;
      if (authentication) {
        const methods = initialized?.authMethods;
        if (!Array.isArray(methods) || !methods.some((method) => asRecord(method)?.id === authentication.methodId)) {
          throw new Error('Declared ACP authentication method was not advertised');
        }
        await params.client.request('authenticate', { methodId: authentication.methodId, ...(authentication.metadata === undefined ? {} : { _meta: authentication.metadata }) });
      }
      params.signal.throwIfAborted();
      const session = asRecord(await params.client.request('session/new', { cwd: params.cwd, mcpServers: [] }));
      const sessionId = session?.sessionId;
      if (!session || typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('ACP session/new omitted its native session identifier');
      nativeSessionId = sessionId;
      params.signal.throwIfAborted();
      const snapshot = snapshots.get(sessionId);
      if (snapshot !== undefined) resolveCommands(snapshot);
      snapshots.clear();
      return await inspect(session, () => commandsUpdate);
    };
    return await Promise.race([discover(), cancelled]);
  } finally {
    params.signal.removeEventListener('abort', onAbort);
    try {
      // Once cancelled, the host's same bounded client cannot issue further requests.
      // Process disposal remains with the executor; no second client or cleanup budget is created.
      if (nativeSessionId !== null && supportsClose && !params.signal.aborted) {
        await params.client.request('session/close', { sessionId: nativeSessionId });
      }
    } finally {
      await notifications.dispose();
      await permissions.dispose();
    }
  }
}


export async function probeAcpCatalogs(params: AcpPreflightSessionParams): Promise<AcpCatalogsProbeResult> {
  return await withAcpPreflightSession(params, async (_session, readCommands) => ({
    commands: await readCommands(), skills: null,
  }));
}

async function applyStandaloneConfigOptionOverrides(params: Readonly<{
  configOptions: ReadonlyArray<SessionConfigOption> | null;
  modelConfigOptionId?: string | null;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
  signal?: AbortSignal;
  setOption: (id: string, value: string) => Promise<unknown>;
  onConfigOptionsAccepted?: (configOptions: ReadonlyArray<SessionConfigOption>) => void;
}>) {
  let configOptions = params.configOptions;
  let applied = false;
  let observedAt: number | undefined;
  const attempted = new Set<string>();
  const overrides = params.configOptionOverrides;
  while (configOptions && overrides) {
    params.signal?.throwIfAborted();
    const selector = params.modelConfigOptionId === null ? null : resolveSessionModelConfigOption(configOptions, params.modelConfigOptionId);
    const modelState = params.modelConfigOptionId === null ? null : readSessionModelStateFromConfigOptions({ configOptions }, params.modelConfigOptionId);
    const modelScopedIds = new Set(modelState?.availableModels.flatMap((model) => model.modelOptions?.map((option) => option.id) ?? []) ?? []);
    // Re-read the accepted catalog after each setter. A scope change can remove
    // controls and choices; stale model-specific draft values are never replayed.
    const option = configOptions.find((candidate) => !attempted.has(candidate.id)
      && candidate.id !== selector?.id && !modelScopedIds.has(candidate.id)
      && Object.hasOwn(overrides, candidate.id));
    if (!option) break;
    attempted.add(option.id);
    const value = normalizeSessionConfigOptionValue(overrides[option.id]);
    if (value === option.currentValue) continue;
    if (value === null) return { configOptions, applied, observedAt, refreshError: true as const };
    try {
      const next = readSessionConfigOptionsFromSessionResponse(await params.setOption(option.id, value));
      if (next === null) return { configOptions, applied, observedAt, refreshError: true as const };
      configOptions = next;
      applied = true;
      observedAt = Date.now();
      params.onConfigOptionsAccepted?.(next);
    } catch (error) {
      params.signal?.throwIfAborted();
      return { configOptions, applied, observedAt, refreshError: true as const,
        ...(error instanceof Error ? { refreshErrorMessage: error.message } : {}) };
    }
  }
  return { configOptions, applied, observedAt };
}

/** Configured ACP uses the same draft scope projection through its owning backend. */
export async function probeAcpSessionControlsFromBackend(params: Readonly<{
  backend: AcpProbeBackend;
  timeoutMs: number;
  signal?: AbortSignal;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
}>): Promise<AcpSessionControlsProbeResult> {
  const { sessionId } = await startAcpProbeSession(params);
  let modelCatalogObserved = Array.isArray(params.backend.getSessionModelState?.()?.availableModels);
  const { configOptions, applied, observedAt, refreshError, refreshErrorMessage } = await applyStandaloneConfigOptionOverrides({
    ...params, configOptions: readSessionConfigOptionsFromSessionResponse({ configOptions: params.backend.getSessionConfigOptionsState?.() }),
    modelConfigOptionId: params.backend.getSessionModelConfigOptionId?.() ?? null,
    setOption: async (configId, value) => {
      if (!params.backend.setSessionConfigOption) throw new Error('ACP backend does not support configuration changes');
      await params.backend.setSessionConfigOption(sessionId, configId, value);
      if (Array.isArray(params.backend.getSessionModelState?.()?.availableModels)) modelCatalogObserved = true;
      return { configOptions: params.backend.getSessionConfigOptionsState?.() };
    },
  });
  const modelConfigOptionId = params.backend.getSessionModelConfigOptionId?.() ?? undefined;
  return {
    // The backend remains the authority. A lost previously observed model state
    // after an accepted setter is a withdrawal, not an unobserved catalog.
    models: params.backend.getSessionModelState?.()?.availableModels ?? (applied && modelCatalogObserved ? [] : null),
    modes: params.backend.getSessionModeState?.()?.availableModes ?? null,
    configOptions,
    ...(modelConfigOptionId === undefined ? {} : { modelConfigOptionId }),
    ...(refreshError ? { refreshError } : {}),
    ...(refreshErrorMessage === undefined ? {} : { refreshErrorMessage }),
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

/** Session controls require no command update; draft scopes reuse this temporary session. */
export async function probeAcpSessionControls(params: AcpPreflightSessionParams): Promise<AcpSessionControlsProbeResult> {
  return await withAcpPreflightSession(params, async (session) => {
    const initialConfigOptions = readSessionConfigOptionsFromSessionResponse(session);
    const legacyModelState = readSessionModelStateFromSessionResponse(session);
    const configModelState = readSessionModelStateFromConfigOptions({ configOptions: initialConfigOptions }, params.modelConfigOptionId);
    let models: unknown = legacyModelState?.availableModels ?? configModelState?.availableModels ?? asRecord(session.models)?.availableModels ?? null;
    let modelsDerivedFromConfigOptions = legacyModelState === null && configModelState !== null;
    const { configOptions, applied, observedAt, refreshError, refreshErrorMessage } = await applyStandaloneConfigOptionOverrides({
      ...params, configOptions: initialConfigOptions,
      onConfigOptionsAccepted: (next) => {
        const state = readSessionModelStateFromConfigOptions({ configOptions: next }, params.modelConfigOptionId);
        if (state) {
          models = state.availableModels;
          modelsDerivedFromConfigOptions = true;
        } else if (modelsDerivedFromConfigOptions) {
          models = [];
          modelsDerivedFromConfigOptions = false;
        }
      },
      setOption: async (configId, value) => await params.client.request('session/set_config_option', {
        sessionId: session.sessionId as string, configId, value,
      }),
    });
    const modelConfigOptionId = configOptions ? resolveSessionModelConfigOption(configOptions, params.modelConfigOptionId)?.id : undefined;
    return {
      // Config snapshots replace derived models; independently reported legacy
      // models retain authority until a config selector actually owns the fact.
      models: applied ? models : asRecord(session.models)?.availableModels ?? null,
      modes: asRecord(session.modes)?.availableModes ?? null,
      configOptions,
      ...(modelConfigOptionId === undefined ? {} : { modelConfigOptionId }),
      ...(refreshError ? { refreshError } : {}),
      ...(refreshErrorMessage === undefined ? {} : { refreshErrorMessage }),
      ...(observedAt === undefined ? {} : { observedAt }),
    };
  });
}
