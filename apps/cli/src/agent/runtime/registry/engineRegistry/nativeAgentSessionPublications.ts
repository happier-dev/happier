import type {
  AgentSessionActiveInputBinding,
  AgentSessionActiveInputStatus,
  AgentSessionHostServices,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
  AgentSessionModesSnapshot,
  AgentSessionModesSource,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { readAcpSessionModeIntentFromMetadata } from '@happier-dev/agents';
import { applyAcpSessionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import type { Metadata } from '@/api/types';

import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

type PublicationSession = Readonly<{
  updateMetadataAsCurrentPublisher?(updater: (current: Metadata) => Metadata): Promise<void> | void;
  updateAgentState(updater: Parameters<typeof updateAgentStateBestEffort>[1]): Promise<void> | void;
}>;

export type NativeAgentSessionPublications = Readonly<{
  services: Pick<AgentSessionHostServices, 'models' | 'modes' | 'activeInput' | 'publishWorkStatus'>;
  modelsSource: AgentSessionModelsSource;
  modesSource: AgentSessionModesSource;
  readActiveInputBinding(): AgentSessionActiveInputBinding | null;
  dispose(): void;
}>;

export function createNativeAgentSessionPublications(params: Readonly<{
  agentId: string;
  /** Only the main Session owns the readiness projection; Run contexts pass null. */
  session: PublicationSession | null;
  signal: AbortSignal;
  isCurrent(): boolean;
  supportsInFlightSteer: boolean;
}>): NativeAgentSessionPublications {
  let disposed = false;
  let activeInputBinding: AgentSessionActiveInputBinding | null = null;
  let workStatus: Parameters<NonNullable<AgentSessionHostServices['publishWorkStatus']>>[0] = null;
  const publishWorkStatus: NonNullable<AgentSessionHostServices['publishWorkStatus']> = (status) => {
    if (!isAvailable(status === null) || !params.session || status === workStatus) return;
    workStatus = status;
    updateAgentStateBestEffort(params.session, state => ({ ...state, workStatus: status }),
      `[${params.agentId}]`, 'native_agent_work_status');
  };

  const isAvailable = (allowAborted = false): boolean => {
    if (disposed || !allowAborted && params.signal.aborted) return false;
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
  // Both catalogs have the same one-live-source lifetime, not the same domain policy.
  const createCatalogPublication = <Snapshot,>(empty: Snapshot, project: (snapshot: Snapshot) => Snapshot) => {
    type Source = Readonly<{
      read(): Snapshot;
      subscribe(listener: (snapshot: Snapshot) => void): Readonly<{ dispose(): void | Promise<void> }>;
    }>;
    let snapshot = empty;
    let binding: Readonly<{ dispose(): void }> | null = null;
    const subscribers = new Set<(snapshot: Snapshot) => void>();
    const publish = (next: Snapshot): void => {
      snapshot = project(next);
      for (const subscriber of subscribers) subscriber(snapshot);
    };
    const source: Source = Object.freeze({
      read: () => snapshot,
      subscribe(listener) {
        subscribers.add(listener);
        listener(snapshot);
        return Object.freeze({ dispose: () => { subscribers.delete(listener); } });
      },
    });
    return Object.freeze({
      source,
      service: Object.freeze({
        bind(input: Source) {
          assertAvailable();
          if (binding) throw new Error('Native Agent session catalog already has an active publisher');
          let retired = false;
          let subscription: ReturnType<Source['subscribe']> | null = null;
          const current = Object.freeze({
            dispose() {
              if (retired) return;
              retired = true;
              void subscription?.dispose();
              subscription = null;
              if (binding !== current) return;
              binding = null;
              if (isAvailable()) publish(empty);
            },
          });
          const apply = (next: Snapshot): void => {
            if (retired || binding !== current || !isAvailable()) return;
            publish(next);
          };
          binding = current;
          try {
            apply(input.read());
            subscription = input.subscribe(apply);
            if (retired) { void subscription.dispose(); subscription = null; }
          } catch (error) {
            current.dispose();
            throw error;
          }
          return current;
        },
      }),
      dispose() {
        binding?.dispose();
        subscribers.clear();
      },
    });
  };
  const modelPublication = createCatalogPublication<AgentSessionModelsSnapshot>(Object.freeze({ models: null }), (snapshot) => Object.freeze({
    models: snapshot.models,
    ...(snapshot.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
    ...(snapshot.currentModelId === undefined ? {} : { currentModelId: snapshot.currentModelId }),
  }));
  const modePublication = createCatalogPublication<AgentSessionModesSnapshot>(Object.freeze({ modes: null }), (snapshot) => Object.freeze({
    modes: snapshot.modes,
    ...(snapshot.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
    ...(snapshot.currentModeId === undefined ? {} : { currentModeId: snapshot.currentModeId }),
  }));
  const publishActiveInputStatus = (status: AgentSessionActiveInputStatus): void => {
    assertAvailable();
    if (!activeInputBinding) {
      throw new Error('Native Agent active-input status requires an active session binding');
    }
    if (!params.session) return;
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
    publishWorkStatus(null);
    disposed = true;
    modelPublication.dispose();
    modePublication.dispose();
    activeInputBinding = null;
  };
  if (params.signal.aborted) dispose();
  else params.signal.addEventListener('abort', dispose, { once: true });

  return Object.freeze({
    services: Object.freeze({
      publishWorkStatus,
      models: modelPublication.service,
      modes: Object.freeze({
        ...modePublication.service,
        async complete(request: Readonly<{ modeId: string }>): Promise<void> {
          assertAvailable();
          if (typeof request?.modeId !== 'string' || !request.modeId.trim() || Object.keys(request).length !== 1) {
            throw new Error('Native mode completion requires only a mode id');
          }
          if (!params.session?.updateMetadataAsCurrentPublisher) {
            throw new Error('Native mode completion requires the current Session publisher');
          }
          await params.session.updateMetadataAsCurrentPublisher((metadata) => {
            assertAvailable();
            const intent = readAcpSessionModeIntentFromMetadata(metadata);
            if (intent?.modeId !== request.modeId) return metadata;
            return applyAcpSessionModeIntentSessionMetadata(metadata, {
              v: 1, modeId: null, updatedAt: Date.now(),
            });
          });
        },
      }),
      activeInput,
    }),
    modelsSource: modelPublication.source,
    modesSource: modePublication.source,
    readActiveInputBinding: () => isAvailable() ? activeInputBinding : null,
    dispose,
  });
}
