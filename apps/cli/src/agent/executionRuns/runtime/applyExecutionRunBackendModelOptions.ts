import {
  readSpawnConfigOptionOverrideValue,
  type AcpConfigOptionOverridesV1,
} from '@happier-dev/protocol';

import type { AgentBackend, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';

/**
 * Canonical, provider-agnostic apply-options seam for execution-run backends.
 *
 * A run's `modelId` and canonical config-option overrides (e.g. `reasoning_effort`) are part of the
 * execution-run contract, but the ONLY place a backend can safely apply them is after the (new or
 * resumed) session id is known. This wrapper defers option application to exactly that point by
 * wrapping `startSession` / `loadSession` / `loadSessionWithReplayCapture`.
 *
 * It is capability-driven, not provider-name-driven: options are applied only when the backend
 * exposes the corresponding setter (`setSessionModel` / `setSessionConfigOption`). Backends that
 * cannot apply an option (e.g. the Codex MCP transport, which bakes the model in at construction)
 * are returned untouched — the wrapper is a no-op rather than a hard failure.
 */

type ModelConfigurableBackend = AgentBackend &
  Partial<{
    setSessionModel: (sessionId: SessionId, modelId: string) => Promise<void>;
    setSessionConfigOption: (
      sessionId: SessionId,
      configId: string,
      value: string | number | boolean | null,
    ) => Promise<void>;
    getSessionConfigOptionsState: () => ReadonlyArray<SessionConfigOption> | null;
  }>;

export function withExecutionRunBackendModelOptions(
  backend: AgentBackend,
  options: Readonly<{
    modelId?: string;
    modelApply?: Readonly<{
      method: 'set_model' | 'config_option';
      configOptionId?: string;
    }>;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    resolveSessionModelConfigUpdate?: (params: Readonly<{
      modelId: string;
      configOptions: ReadonlyArray<SessionConfigOption> | null;
    }>) => Readonly<{
      modelId: string;
      configUpdates?: ReadonlyArray<Readonly<{
        configId: string;
        value: string | number | boolean | null;
      }>>;
    }> | null;
    resolveSessionConfigOptionUpdate?: (params: Readonly<{
      configId: string;
      value: string | number | boolean | null;
      configOptions: ReadonlyArray<SessionConfigOption> | null;
    }>) => Readonly<{ modelId: string }> | Readonly<{
      configId: string;
      value: string | number | boolean | null;
    }> | null;
  }>,
): AgentBackend {
  const modelId = readNonBlankSessionControlIdentifier(options.modelId) ?? '';
  const overrides = options.sessionConfigOptionOverrides?.overrides ?? null;
  const overrideEntries = overrides
    ? Object.keys(overrides)
      .filter((configId) => readNonBlankSessionControlIdentifier(configId) !== null)
      .flatMap((configId) => {
        const value = readSpawnConfigOptionOverrideValue(options.sessionConfigOptionOverrides, configId);
        return value === undefined || value === null ? [] : [[configId, value] as const];
      })
    : [];
  if (!modelId && overrideEntries.length === 0) return backend;

  const target = backend as ModelConfigurableBackend;

  const applyOptions = async (sessionId: SessionId): Promise<void> => {
    const readConfigOptions = () => target.getSessionConfigOptionsState?.() ?? null;
    const modelConfigOptionId = readNonBlankSessionControlIdentifier(options.modelApply?.configOptionId);
    const applyModel = async (requestedModelId: string): Promise<void> => {
      const providerResolved = options.resolveSessionModelConfigUpdate?.({
        modelId: requestedModelId,
        configOptions: readConfigOptions(),
      });
      const resolved = providerResolved === undefined ? { modelId: requestedModelId } : providerResolved;
      if (!resolved) return;
      const resolvedModelId = readNonBlankSessionControlIdentifier(resolved.modelId) ?? '';
      if (!resolvedModelId) return;
      if (
        options.modelApply?.method === 'config_option'
        && modelConfigOptionId
        && typeof target.setSessionConfigOption === 'function'
        // A session that does not advertise the model option takes the model through set_model.
        && (typeof target.getSessionConfigOptionsState !== 'function'
          || (readConfigOptions() ?? []).some((option) => option.id === modelConfigOptionId))
      ) {
        await target.setSessionConfigOption(sessionId, modelConfigOptionId, resolvedModelId);
      } else if (typeof target.setSessionModel === 'function') {
        await target.setSessionModel(sessionId, resolvedModelId);
      }
      if (typeof target.setSessionConfigOption === 'function') {
        for (const update of resolved.configUpdates ?? []) {
          await target.setSessionConfigOption(sessionId, update.configId, update.value);
        }
      }
    };
    if (
      modelId
      && (typeof target.setSessionConfigOption === 'function' || typeof target.setSessionModel === 'function')
    ) {
      await applyModel(modelId);
    }
    if (overrideEntries.length > 0 && typeof target.setSessionConfigOption === 'function') {
      for (const [configId, value] of overrideEntries) {
        const providerResolved = options.resolveSessionConfigOptionUpdate?.({
          configId,
          value,
          configOptions: readConfigOptions(),
        });
        const resolved = providerResolved === undefined ? { configId, value } : providerResolved;
        if (!resolved) continue;
        if ('modelId' in resolved) {
          await applyModel(resolved.modelId);
        } else {
          await target.setSessionConfigOption(sessionId, resolved.configId, resolved.value);
        }
      }
    }
  };

  const originalStartSession = backend.startSession.bind(backend);
  target.startSession = async (initialPrompt?: string): Promise<StartSessionResult> => {
    const started = await originalStartSession(initialPrompt);
    await applyOptions(started.sessionId);
    return started;
  };

  if (typeof backend.loadSession === 'function') {
    const originalLoadSession = backend.loadSession.bind(backend);
    target.loadSession = async (existingSessionId: SessionId): Promise<StartSessionResult> => {
      const loaded = await originalLoadSession(existingSessionId);
      await applyOptions(loaded.sessionId);
      return loaded;
    };
  }

  if (typeof backend.loadSessionWithReplayCapture === 'function') {
    const originalLoadReplay = backend.loadSessionWithReplayCapture.bind(backend);
    target.loadSessionWithReplayCapture = async (
      existingSessionId: SessionId,
    ): Promise<StartSessionResult & { replay: unknown[] }> => {
      const loaded = await originalLoadReplay(existingSessionId);
      await applyOptions(loaded.sessionId);
      return loaded;
    };
  }

  return backend;
}
