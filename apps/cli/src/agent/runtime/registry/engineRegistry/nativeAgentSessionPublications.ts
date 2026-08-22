import type {
  AgentSessionActiveInputBinding,
  AgentSessionActiveInputStatus,
  AgentSessionHostServices,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

type PublicationSession = Readonly<{
  updateAgentState(updater: Parameters<typeof updateAgentStateBestEffort>[1]): Promise<void> | void;
}>;

export type NativeAgentSessionPublications = Readonly<{
  services: Pick<AgentSessionHostServices, 'models' | 'activeInput'>;
  modelsSource: AgentSessionModelsSource;
  readActiveInputBinding(): AgentSessionActiveInputBinding | null;
  dispose(): void;
}>;

export function createNativeAgentSessionPublications(params: Readonly<{
  agentId: string;
  session: PublicationSession;
  signal: AbortSignal;
  isCurrent(): boolean;
  supportsInFlightSteer: boolean;
}>): NativeAgentSessionPublications {
  let disposed = false;
  let modelBinding: Readonly<{ source: AgentSessionModelsSource; dispose(): void }> | null = null;
  let activeInputBinding: AgentSessionActiveInputBinding | null = null;
  let modelSnapshot: AgentSessionModelsSnapshot = Object.freeze({ models: null });
  const modelSubscribers = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();

  const isAvailable = (): boolean => {
    if (disposed || params.signal.aborted) return false;
    try {
      return params.isCurrent();
    } catch {
      return false;
    }
  };
  const assertAvailable = (): void => {
    if (!isAvailable()) {
      throw new Error('The native Agent session publication scope is retired or unavailable');
    }
  };
  const publishModels = (snapshot: AgentSessionModelsSnapshot): void => {
    modelSnapshot = Object.freeze({
      models: snapshot.models,
      ...(snapshot.currentModelId === undefined ? {} : { currentModelId: snapshot.currentModelId }),
    });
    for (const subscriber of modelSubscribers) subscriber(modelSnapshot);
  };
  const internalModelSource: AgentSessionModelsSource = Object.freeze({
    read: () => modelSnapshot,
    subscribe(handler) {
      modelSubscribers.add(handler);
      handler(modelSnapshot);
      return Object.freeze({
        dispose: () => {
          modelSubscribers.delete(handler);
        },
      });
    },
  });
  const publishActiveInputStatus = (status: AgentSessionActiveInputStatus): void => {
    assertAvailable();
    if (!activeInputBinding) {
      throw new Error('Native Agent active-input status requires an active session binding');
    }
    updateAgentStateBestEffort(
      params.session,
      (state) => ({
        ...state,
        capabilities: {
          ...(state.capabilities ?? {}),
          inFlightSteer: params.supportsInFlightSteer,
          inFlightSteerSupported: params.supportsInFlightSteer,
          inFlightSteerAvailable: params.supportsInFlightSteer && status.steerAvailable,
          inFlightSteerUnavailableReason: params.supportsInFlightSteer
            ? status.steerUnavailableReason
            : 'backend_unsupported',
          inFlightSteerStateAt: status.stateUpdatedAtMs,
          terminalComposerDraftPresent: status.terminalComposerDraftPresent,
          terminalComposerClearSupported: status.terminalComposerClearSupported,
          inFlightConfigApplySupported: status.inFlightConfigurationApplySupported,
          pendingInputInterruptAndRunLocalId: status.pendingInputInterruptAndRunLocalId,
          pendingInputInterruptAndRunStateAt: status.pendingInputInterruptAndRunStateAt,
        },
      }),
      `[${params.agentId}]`,
      'native_agent_active_input_status',
    );
  };

  const models: AgentSessionHostServices['models'] = Object.freeze({
    bind(source) {
      assertAvailable();
      if (modelBinding) {
        throw new Error('Native Agent session models already have an active publisher');
      }
      let bindingDisposed = false;
      let sourceDisposable: ReturnType<AgentSessionModelsSource['subscribe']> | null = null;
      const apply = (snapshot: AgentSessionModelsSnapshot): void => {
        if (bindingDisposed || !isAvailable() || modelBinding?.source !== source) return;
        publishModels(snapshot);
      };
      const binding = Object.freeze({
        source,
        dispose() {
          if (bindingDisposed) return;
          bindingDisposed = true;
          void sourceDisposable?.dispose();
          sourceDisposable = null;
          if (modelBinding !== binding) return;
          modelBinding = null;
          if (isAvailable()) publishModels({ models: null });
        },
      });
      modelBinding = binding;
      try {
        apply(source.read());
        sourceDisposable = source.subscribe(apply);
      } catch (error) {
        binding.dispose();
        throw error;
      }
      return Object.freeze({ dispose: binding.dispose });
    },
  });

  const activeInput: AgentSessionHostServices['activeInput'] = Object.freeze({
    bind(binding) {
      assertAvailable();
      if (activeInputBinding) {
        throw new Error('Native Agent session active input already has an active publisher');
      }
      let bindingDisposed = false;
      activeInputBinding = binding;
      return Object.freeze({
        dispose() {
          if (bindingDisposed) return;
          bindingDisposed = true;
          if (activeInputBinding !== binding) return;
          activeInputBinding = null;
        },
      });
    },
    publishStatus: publishActiveInputStatus,
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const currentModelBinding = modelBinding;
    modelBinding = null;
    currentModelBinding?.dispose();
    activeInputBinding = null;
    modelSubscribers.clear();
  };
  if (params.signal.aborted) dispose();
  else params.signal.addEventListener('abort', dispose, { once: true });

  return Object.freeze({
    services: Object.freeze({ models, activeInput }),
    modelsSource: internalModelSource,
    readActiveInputBinding: () => isAvailable() ? activeInputBinding : null,
    dispose,
  });
}
