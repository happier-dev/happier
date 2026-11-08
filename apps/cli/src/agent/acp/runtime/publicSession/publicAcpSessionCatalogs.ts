import type {
  AgentSessionHostServices,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
  AgentSessionModesSnapshot,
  AgentSessionModesSource,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isDeepStrictEqual } from 'node:util';
import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { normalizeAvailableCommands } from '@/agent/acp/commands/publishSlashCommands';
import { resolveSessionModelConfigOption } from '@/agent/acp/sessionSettings/sessionSettingsState';

type WithoutEnvelope<Event> = Event extends unknown ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'> : never;
type CatalogEvent = WithoutEnvelope<Extract<AgentSessionRuntimeEvent, { kind: 'config-options' | 'available-commands' }>>;

/** Native catalog observations share the public Session's existing publication lifetime. */
export function createPublicAcpSessionCatalogs(params: Readonly<{
  backend: Pick<AcpBackend, 'getSessionModelState' | 'getSessionModeState' | 'getSessionConfigOptionsState'>;
  models: AgentSessionHostServices['models'];
  modes: AgentSessionHostServices['modes'];
  modelConfigOptionId?: string;
  publish(event: CatalogEvent): void;
}>) {
  let ready = false;
  let disposed = false;
  let modelPending = false;
  let modelObservedAt = 0;
  let modelSnapshot: AgentSessionModelsSnapshot = Object.freeze({ models: null });
  const modelSubscribers = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
  const modelSource: AgentSessionModelsSource = Object.freeze({
    read: () => modelSnapshot,
    subscribe(handler) {
      modelSubscribers.add(handler);
      handler(modelSnapshot);
      return Object.freeze({ dispose: () => { modelSubscribers.delete(handler); } });
    },
  });
  const publishModels = (catalogChanged = true): void => {
    const state = params.backend.getSessionModelState();
    let models = modelSnapshot.models;
    if (catalogChanged || models === null) {
      const previous = new Map((models ?? []).map(model => [model.id, model]));
      const next = (state?.availableModels ?? []).map(model => {
        const retained = previous.get(model.id);
        return retained && isDeepStrictEqual(retained, model) ? retained : Object.freeze({
          ...model,
          ...(model.modelOptions ? { modelOptions: Object.freeze(model.modelOptions.map(option => Object.freeze({ ...option }))) } : {}),
        });
      });
      models = models?.length === next.length && next.every((model, index) => model === models?.[index])
        ? models : Object.freeze(next);
    }
    modelSnapshot = Object.freeze({
      observedAt: modelObservedAt,
      models,
      ...(state ? { currentModelId: state.currentModelId }
        : modelSnapshot.currentModelId === undefined ? {} : { currentModelId: modelSnapshot.currentModelId }),
    });
    for (const subscriber of modelSubscribers) subscriber(modelSnapshot);
  };
  let modeObservedAt = 0;
  let modeSnapshot: AgentSessionModesSnapshot = Object.freeze({ modes: null });
  const modeSubscribers = new Set<(snapshot: AgentSessionModesSnapshot) => void>();
  const modeSource: AgentSessionModesSource = Object.freeze({
    read: () => modeSnapshot,
    subscribe(handler) {
      modeSubscribers.add(handler);
      handler(modeSnapshot);
      return Object.freeze({ dispose: () => { modeSubscribers.delete(handler); } });
    },
  });
  const publishModes = (catalogChanged = true): void => {
    const state = params.backend.getSessionModeState();
    let modes = modeSnapshot.modes;
    if (catalogChanged || modes === null) {
      const previous = new Map((modes ?? []).map(mode => [mode.id, mode]));
      const next = state?.availableModes.map(mode => {
        const retained = previous.get(mode.id);
        return retained && isDeepStrictEqual(retained, mode) ? retained : Object.freeze({ ...mode });
      }) ?? null;
      modes = next && modes?.length === next.length && next.every((mode, index) => mode === modes?.[index])
        ? modes : next ? Object.freeze(next) : null;
    }
    modeSnapshot = Object.freeze({
      observedAt: modeObservedAt,
      modes,
      ...(state ? { currentModeId: state.currentModeId } : {}),
    });
    for (const subscriber of modeSubscribers) subscriber(modeSnapshot);
  };
  const publishConfigOptions = (): void => {
    const configOptions = params.backend.getSessionConfigOptionsState();
    if (configOptions === null) return;
    const modelOption = resolveSessionModelConfigOption(configOptions, params.modelConfigOptionId);
    params.publish({ kind: 'config-options', configOptions,
      ...(modelOption ? { modelConfigOptionId: modelOption.id } : {}),
    });
  };
  const modelBinding = params.models.bind(modelSource);
  const modeBinding = params.modes.bind(modeSource);

  return Object.freeze({
    observe(message: AgentMessage): void {
      if (disposed || message.type !== 'event') return;
      if (message.name === 'session_models_state' || message.name === 'current_model_update') {
        if (message.name === 'session_models_state') modelObservedAt = Date.now();
        // An acknowledged option can change a row without observing a fresh native catalog.
        const payload = message.payload;
        const catalogChanged = message.name === 'session_models_state'
          || (typeof payload === 'object' && payload !== null && 'catalogChanged' in payload && payload.catalogChanged === true);
        if (ready) publishModels(catalogChanged);
        else modelPending = true;
      } else if (message.name === 'session_modes_state' || message.name === 'current_mode_update') {
        if (message.name === 'session_modes_state') modeObservedAt = Date.now();
        if (ready) publishModes(message.name === 'session_modes_state');
      } else if (message.name === 'config_options_state' || message.name === 'config_options_update') {
        if (ready) publishConfigOptions();
      } else if (message.name === 'available_commands_update') {
        const payload = message.payload;
        if (typeof payload !== 'object' || payload === null || !('availableCommands' in payload)) return;
        const commands = normalizeAvailableCommands(payload.availableCommands).map(({ command, ...detail }) => ({ name: command, ...detail }));
        params.publish({ kind: 'available-commands', commands });
      }
    },
    open(): void {
      if (disposed) return;
      ready = true;
      if (params.backend.getSessionModelState() && modelObservedAt === 0) modelObservedAt = Date.now();
      if (modelPending || params.backend.getSessionModelState()) publishModels();
      if (params.backend.getSessionModeState() && modeObservedAt === 0) modeObservedAt = Date.now();
      if (params.backend.getSessionModeState()) publishModes();
      publishConfigOptions();
    },
    async dispose(): Promise<void> {
      disposed = true;
      modelSubscribers.clear();
      modeSubscribers.clear();
      await modelBinding.dispose();
      await modeBinding.dispose();
    },
  });
}
