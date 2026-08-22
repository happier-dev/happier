import type { Metadata } from '@/api/types';
import type {
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  readExactSessionActiveModelSelectionV1,
  readSessionProviderBindingMetadataStateV1,
  type ProviderBoundModelRef,
  type SessionActiveModelSelectionV1,
} from '@happier-dev/protocol';

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModel = SessionModelsState['availableModels'][number];

type ModelPublisherSession = Readonly<{
  getMetadataSnapshot(): Metadata | null;
  updateMetadataAsCurrentPublisher(
    updater: (current: Metadata) => Metadata,
  ): Promise<void> | void;
  on(event: 'metadata-updated', listener: () => void): unknown;
  off(event: 'metadata-updated', listener: () => void): unknown;
}>;

function publisherAuthorityLostError(message: string): Error & {
  code: 'session_publisher_authority_lost';
  retryable: false;
} {
  return Object.assign(new Error(message), {
    code: 'session_publisher_authority_lost' as const,
    retryable: false as const,
  });
}

function stateFingerprint(state: SessionModelsState | null): string {
  return JSON.stringify(state);
}

function stateForAgent(
  state: SessionModelsState | null,
  agentId: string,
): SessionModelsState | null {
  return state?.agentId === agentId ? state : null;
}

function mergeOptions(
  runtime: NonNullable<NonNullable<AgentSessionModelsSnapshot['models']>[number]['modelOptions']> | undefined,
  base: SessionModel['modelOptions'],
  suppressedOptionIds: readonly string[] | undefined = undefined,
): SessionModel['modelOptions'] {
  const output: NonNullable<SessionModel['modelOptions']> = [];
  const seen = new Set<string>();
  const suppressed = new Set(suppressedOptionIds ?? []);
  for (const option of [...(runtime ?? []), ...(base ?? [])]) {
    if (seen.has(option.id) || suppressed.has(option.id)) continue;
    seen.add(option.id);
    output.push({
      id: option.id,
      name: option.name,
      ...(option.description === undefined ? {} : { description: option.description }),
      type: option.type,
      currentValue: option.currentValue,
      ...(option.options === undefined ? {} : { options: [...option.options] }),
      // Producer-declared. A runtime snapshot cannot author this fact, so dropping it here
      // would silently erase what the persisted catalog already carries.
      ...(option.overridesWhenOn === undefined
        ? {}
        : { overridesWhenOn: option.overridesWhenOn }),
    });
  }
  return output.length > 0 ? output : undefined;
}

function mergeState(params: Readonly<{
  agentId: string;
  base: SessionModelsState | null;
  previous: SessionModelsState | null;
  runtime: AgentSessionModelsSnapshot;
  authoritativeCurrentModelId?: string | null;
}>): SessionModelsState | null {
  if (params.runtime.models === null) return params.base;
  const availableModels: SessionModel[] = [];
  const indexById = new Map<string, number>();
  const suppressedOptionIdsByModelId = new Map<string, readonly string[]>();
  for (const model of params.runtime.models) {
    if (indexById.has(model.id)) continue;
    indexById.set(model.id, availableModels.length);
    if (model.suppressedModelOptionIds?.length) {
      suppressedOptionIdsByModelId.set(model.id, model.suppressedModelOptionIds);
    }
    const modelOptions = mergeOptions(
      model.modelOptions,
      undefined,
      model.suppressedModelOptionIds,
    );
    availableModels.push({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
      ...(model.extendedContextModelId === undefined
        ? {}
        : { extendedContextModelId: model.extendedContextModelId }),
      ...(modelOptions ? { modelOptions } : {}),
    });
  }
  for (const model of params.base?.availableModels ?? []) {
    const existingIndex = indexById.get(model.id);
    if (existingIndex === undefined) {
      indexById.set(model.id, availableModels.length);
      availableModels.push(model);
      continue;
    }
    const existing = availableModels[existingIndex]!;
    const modelOptions = mergeOptions(
      existing.modelOptions,
      model.modelOptions,
      suppressedOptionIdsByModelId.get(model.id),
    );
    availableModels[existingIndex] = {
      ...existing,
      ...(existing.description === undefined && model.description !== undefined
        ? { description: model.description }
        : {}),
      ...(
        existing.contextWindowTokens === undefined
        && model.contextWindowTokens !== undefined
          ? { contextWindowTokens: model.contextWindowTokens }
          : {}
      ),
      ...(
        existing.extendedContextModelId === undefined
        && model.extendedContextModelId !== undefined
          ? { extendedContextModelId: model.extendedContextModelId }
          : {}
      ),
      ...(modelOptions ? { modelOptions } : {}),
    };
  }
  if (availableModels.length === 0) return params.base;
  const candidates = [
    params.authoritativeCurrentModelId ?? undefined,
    params.runtime.currentModelId ?? undefined,
    params.previous?.currentModelId,
    params.base?.currentModelId,
  ];
  const currentModelId = candidates.find((candidate) =>
    typeof candidate === 'string' && indexById.has(candidate)) ?? availableModels[0]!.id;
  return {
    v: 1,
    agentId: params.agentId,
    updatedAt: Date.now(),
    currentModelId,
    availableModels,
    ...(params.previous?.activeSelectionV1
      ? { activeSelectionV1: params.previous.activeSelectionV1 }
      : {}),
  };
}

function mergeBaseState(
  canonical: SessionModelsState | null,
  legacyAcp: SessionModelsState | null,
): SessionModelsState | null {
  if (!canonical) return legacyAcp;
  if (!legacyAcp) return canonical;
  const availableModels: SessionModel[] = [...canonical.availableModels];
  const indexById = new Map(availableModels.map((model, index) => [model.id, index] as const));
  for (const model of legacyAcp.availableModels) {
    const existingIndex = indexById.get(model.id);
    if (existingIndex === undefined) {
      indexById.set(model.id, availableModels.length);
      availableModels.push(model);
    }
  }
  const currentModelId = [canonical.currentModelId, legacyAcp.currentModelId]
    .find((candidate) => indexById.has(candidate)) ?? availableModels[0]?.id;
  if (!currentModelId) return null;
  return {
    v: 1,
    agentId: canonical.agentId,
    updatedAt: Math.max(canonical.updatedAt, legacyAcp.updatedAt),
    currentModelId,
    availableModels,
    ...(canonical.activeSelectionV1
      ? { activeSelectionV1: canonical.activeSelectionV1 }
      : {}),
  };
}

export function createSessionRuntimeModelsPublisher(params: Readonly<{
  agentId: string;
  agentTargetKey?: string;
  runnerProcessIdentity?: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null;
  initialActiveSelection?: SessionActiveModelSelectionV1 | null;
  session: ModelPublisherSession;
  source: AgentSessionModelsSource;
}>): Readonly<{
  publishActiveSelection(input: Readonly<{
    selection: ProviderBoundModelRef;
    activeSelectionV1: SessionActiveModelSelectionV1;
    publishActive(): Promise<void>;
  }>): Promise<void>;
  releaseActiveSelectionAuthority(input: Readonly<{
    selection: ProviderBoundModelRef;
  }>): Promise<void>;
  flush(): Promise<void>;
  stopAndDrain(): Promise<void>;
  dispose(): void;
}> {
  let stopped = false;
  let runtime = params.source.read();
  const initialMetadata = params.session.getMetadataSnapshot();
  let canonicalBase = stateForAgent(
    initialMetadata?.sessionModelsV1 ?? null,
    params.agentId,
  );
  let legacyAcpBase = stateForAgent(
    initialMetadata?.acpSessionModelsV1 ?? null,
    params.agentId,
  );
  let observedLegacyAcpFingerprint = stateFingerprint(
    initialMetadata?.acpSessionModelsV1 ?? null,
  );
  let lastPublished: SessionModelsState | null = null;
  let pending: Promise<void> = Promise.resolve();
  let terminalError: unknown = null;
  let authoritativeSelection =
    params.initialActiveSelection
    && params.runnerProcessIdentity
    && params.initialActiveSelection.runner.pid
      === params.runnerProcessIdentity.pid
    && params.initialActiveSelection.runner.processStartTimeMs
      === params.runnerProcessIdentity.processStartTimeMs
    && params.initialActiveSelection.selection.agentTargetKey
      === params.agentTargetKey
      ? params.initialActiveSelection
      : null;
  let publicationSuppressed = false;
  let publicationRequestedWhileSuppressed = false;

  const stopAcceptingPublications = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe.dispose();
    params.session.off('metadata-updated', onMetadataUpdated);
  };

  const retainTerminalError = (error: unknown): void => {
    terminalError ??= error;
    if (
      typeof (error as { code?: unknown } | null)?.code === 'string'
      && (error as { code: string }).code
        === 'session_publisher_authority_lost'
    ) {
      stopAcceptingPublications();
    }
  };

  const throwTerminalError = (): void => {
    if (terminalError !== null) throw terminalError;
  };

  const ownOperation = (operation: Promise<void>): void => {
    pending = operation.catch((error: unknown) => {
      retainTerminalError(error);
    });
  };

  const createRuntimeReadbackFact = (
    metadata: Metadata,
    state: SessionModelsState,
    runtimeCurrentModelId: string,
  ): SessionActiveModelSelectionV1 | null => {
    const runner = params.runnerProcessIdentity;
    const agentTargetKey = params.agentTargetKey;
    if (!runner || !agentTargetKey) return null;
    const bindingState = readSessionProviderBindingMetadataStateV1(metadata);
    let providerConnectionId: ProviderBoundModelRef['providerConnectionId'];
    if (bindingState.kind === 'absent') {
      providerConnectionId = null;
    } else if (
      bindingState.kind === 'valid'
      && bindingState.binding.model?.id === runtimeCurrentModelId
    ) {
      providerConnectionId = bindingState.binding.connectionId;
    } else {
      return null;
    }
    const fact: SessionActiveModelSelectionV1 = {
      v: 1,
      selection: {
        agentTargetKey,
        providerConnectionId,
        modelId: runtimeCurrentModelId,
      },
      source: 'runtime_readback',
      runner,
    };
    return readExactSessionActiveModelSelectionV1({
      metadata: {
        ...metadata,
        sessionModelsV1: {
          ...state,
          activeSelectionV1: fact,
        },
      },
      agentId: params.agentId,
      agentTargetKey,
      currentRunnerProcessIdentity: runner,
    });
  };

  const publish = (): void => {
    if (publicationSuppressed) {
      publicationRequestedWhileSuppressed = true;
      return;
    }
    const operation = pending.then(async () => {
      throwTerminalError();
      if (stopped) return;
      const metadata = params.session.getMetadataSnapshot();
      const observedCurrent = metadata?.sessionModelsV1 ?? null;
      const current = stateForAgent(observedCurrent, params.agentId);
      const base = mergeBaseState(canonicalBase, legacyAcpBase);
      const merged = mergeState({
        agentId: params.agentId,
        base,
        previous: current,
        runtime,
        authoritativeCurrentModelId:
          authoritativeSelection?.selection.modelId ?? null,
      });
      const runtimeCurrentModelId =
        typeof runtime.currentModelId === 'string'
        && runtime.currentModelId.length > 0
          ? runtime.currentModelId
          : null;
      const activeSelectionV1 =
        merged && metadata
          ? authoritativeSelection
            ?? (
              runtimeCurrentModelId
                ? createRuntimeReadbackFact(
                    metadata,
                    merged,
                    runtimeCurrentModelId,
                  )
                : null
            )
          : null;
      const desired = merged
        ? {
            ...merged,
            ...(activeSelectionV1
              ? { activeSelectionV1 }
              : { activeSelectionV1: undefined }),
          }
        : null;
      if (stateFingerprint(observedCurrent) === stateFingerprint(desired)) {
        lastPublished = desired;
        return;
      }
      lastPublished = desired;
      await params.session.updateMetadataAsCurrentPublisher((metadata) => {
        if (desired) return { ...metadata, sessionModelsV1: desired };
        const { sessionModelsV1: _removed, ...rest } = metadata;
        return rest;
      });
    });
    ownOperation(operation);
  };

  const onMetadataUpdated = (): void => {
    const metadata = params.session.getMetadataSnapshot();
    const canonical = metadata?.sessionModelsV1 ?? null;
    const legacyAcp = metadata?.acpSessionModelsV1 ?? null;
    const canonicalWasPublished = stateFingerprint(canonical) === stateFingerprint(lastPublished);
    const legacyAcpFingerprint = stateFingerprint(legacyAcp);
    const legacyAcpChanged = legacyAcpFingerprint !== observedLegacyAcpFingerprint;
    if (canonicalWasPublished && !legacyAcpChanged) return;
    if (!canonicalWasPublished) {
      canonicalBase = stateForAgent(canonical, params.agentId);
    }
    if (legacyAcpChanged) {
      legacyAcpBase = stateForAgent(legacyAcp, params.agentId);
      observedLegacyAcpFingerprint = legacyAcpFingerprint;
    }
    publish();
  };
  params.session.on('metadata-updated', onMetadataUpdated);
  const unsubscribe = params.source.subscribe((snapshot) => {
    if (stopped) return;
    runtime = snapshot;
    publish();
  });

  return Object.freeze({
    publishActiveSelection: async (input) => {
      await pending;
      throwTerminalError();
      const operation = pending.then(async () => {
        if (stopped) {
          throw publisherAuthorityLostError(
            'Session runtime model publisher is stopped',
          );
        }
        const previousAuthority = authoritativeSelection;
        const ownRunner = params.runnerProcessIdentity;
        if (
          !ownRunner
          || ownRunner.pid !== input.activeSelectionV1.runner.pid
          || ownRunner.processStartTimeMs
            !== input.activeSelectionV1.runner.processStartTimeMs
          || input.selection.agentTargetKey
            !== input.activeSelectionV1.selection.agentTargetKey
          || input.selection.providerConnectionId
            !== input.activeSelectionV1.selection.providerConnectionId
          || input.selection.modelId
            !== input.activeSelectionV1.selection.modelId
        ) {
          throw new Error(
            'Active model publication requires the current host process witness and exact selection',
          );
        }
        authoritativeSelection = input.activeSelectionV1;
        publicationSuppressed = true;
        publicationRequestedWhileSuppressed = false;
        try {
          await input.publishActive();
        } catch (error) {
          authoritativeSelection = previousAuthority;
          throw error;
        } finally {
          publicationSuppressed = false;
        }
      });
      ownOperation(operation);
      await operation;
      const shouldPublish =
        publicationRequestedWhileSuppressed || authoritativeSelection !== null;
      publicationRequestedWhileSuppressed = false;
      if (shouldPublish) publish();
      await pending;
      throwTerminalError();
    },
    releaseActiveSelectionAuthority: async (input) => {
      await pending;
      throwTerminalError();
      if (stopped) {
        throw publisherAuthorityLostError(
          'Session runtime model publisher is stopped',
        );
      }
      if (
        authoritativeSelection
        && (
          authoritativeSelection.selection.agentTargetKey
            !== input.selection.agentTargetKey
          || authoritativeSelection.selection.providerConnectionId
            !== input.selection.providerConnectionId
          || authoritativeSelection.selection.modelId
            !== input.selection.modelId
        )
      ) {
        return;
      }
      authoritativeSelection = null;
      publish();
      await pending;
      throwTerminalError();
    },
    flush: async () => {
      await pending;
      throwTerminalError();
    },
    stopAndDrain: async () => {
      stopAcceptingPublications();
      await pending;
      throwTerminalError();
    },
    dispose() {
      stopAcceptingPublications();
    },
  });
}
