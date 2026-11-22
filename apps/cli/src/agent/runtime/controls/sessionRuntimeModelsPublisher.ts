import type { Metadata } from '@/api/types';
import type {
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { readExactSessionActiveModelSelection } from '@happier-dev/protocol/providers/active-model-selection';
import { readSessionProviderBindingMetadataStateV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { projectSessionMetadataAgentVocabularyWriteCompatibilityV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import { createSessionActiveModelSelection, type ConnectedAccountSessionModelRefV2, type SessionActiveModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { isProviderSourceModelCatalogConfidenceUsable } from '@/providers/modelManagement/sourceCatalog';
import { applyActiveModelFacts } from '@/providers/sessions/applyActiveModelFacts';
import type { AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';

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

// Compare catalogs as the Session stores them: the client's metadata view adds the
// predecessor write aliases and the owner schema's key order, neither of which this
// publisher writes. Comparing raw JSON made every unrelated metadata update a rewrite.
function stateFingerprint(state: SessionModelsState | null): string {
  const stored = projectSessionMetadataAgentVocabularyWriteCompatibilityV1({ sessionModelsV1: state }).sessionModelsV1;
  return JSON.stringify(stored ?? null, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    : value);
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
      ...(option.category === undefined ? {} : { category: option.category }),
      type: option.type,
      currentValue: option.currentValue,
      ...(option.options === undefined ? {} : { options: [...option.options] }),
      ...(option.groups === undefined ? {} : { groups: option.groups.map(group => ({ ...group, options: [...group.options] })) }),
      // Keep the producer-declared override rule with its current option contribution.
      ...(option.overridesWhenOn === undefined
        ? {}
        : { overridesWhenOn: { ...option.overridesWhenOn, optionIds: [...option.overridesWhenOn.optionIds] } }),
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
  observedAt: number;
}>): SessionModelsState | null {
  if (params.runtime.models === null) return mergeBaseState(params.previous, params.base);
  const availableModels: SessionModel[] = [];
  const indexById = new Map<string, number>();
  const suppressedOptionIdsByModelId = new Map<string, readonly string[]>();
  const preserveBaseCatalog = params.runtime.observedAt === 0
    && isProviderSourceModelCatalogConfidenceUsable(params.runtime.catalogConfidence);
  const currentFactsOnly = preserveBaseCatalog && (params.base?.updatedAt ?? 0) > 0;
  for (const runtimeModel of params.runtime.models) {
    if (currentFactsOnly && runtimeModel.id !== params.runtime.currentModelId) continue;
    const model: NonNullable<AgentSessionModelsSnapshot['models']>[number] = currentFactsOnly ? {
      id: runtimeModel.id,
      name: runtimeModel.name,
      contextWindowTokens: runtimeModel.contextWindowTokens,
      suppressedModelOptionIds: runtimeModel.suppressedModelOptionIds,
    } : runtimeModel;
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
  for (const model of preserveBaseCatalog ? params.base?.availableModels ?? [] : []) {
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
  if (availableModels.length === 0 && preserveBaseCatalog) return params.base;
  const candidates = [
    params.authoritativeCurrentModelId ?? undefined,
    params.runtime.currentModelId ?? undefined,
    params.previous?.currentModelId,
    params.base?.currentModelId,
  ];
  const currentModelId = candidates.find((candidate) =>
    typeof candidate === 'string' && candidate.length > 0);
  if (!currentModelId) return null;
  return {
    v: 1,
    agentId: params.agentId,
    updatedAt: params.runtime.observedAt === 0 ? params.base?.updatedAt ?? 0 : params.observedAt,
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
  // Compatibility aliases are observations of one catalog, not independent membership sources.
  return legacyAcp.updatedAt > canonical.updatedAt ? legacyAcp : canonical;
}

export function createSessionRuntimeModelsPublisher(params: Readonly<{
  agentId: string;
  agentTargetKey?: string;
  runnerProcessIdentity?: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null;
  initialActiveSelection?: SessionActiveModelSelection | null;
  initialActiveTarget?: AuthorizedSessionModelTransitionTarget;
  readAppliedTeamCredentialModel?: () => TeamCredentialProviderModelSelectionV1 | null | undefined;
  readAppliedConnectedAccountSelection?: () => ConnectedAccountSessionModelRefV2 | null;
  session: ModelPublisherSession;
  source: AgentSessionModelsSource;
}>): Readonly<{
  publishActiveSelection(input: Readonly<{
    selection: ProviderBoundModelRef;
    activeSelectionV1: SessionActiveModelSelection | null;
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
  const applyStartupTargetFacts = (
    metadata: Metadata,
    target: AuthorizedSessionModelTransitionTarget,
  ): Metadata => {
    const currentModelId = runtime.currentModelId;
    // The runtime owns the observation; the admitted launch target supplies
    // descriptors/binding without becoming a second current-model producer.
    const observedMetadata = !stateForAgent(metadata.sessionModelsV1 ?? null, params.agentId)
      && typeof currentModelId === 'string' && currentModelId.length > 0
      ? { ...metadata, sessionModelsV1: { v: 1 as const, agentId: params.agentId,
          updatedAt: 0, currentModelId, availableModels: [] } }
      : metadata;
    return applyActiveModelFacts(observedMetadata, target, params.agentId,
      params.initialActiveSelection ?? null);
  };
  // Current-model/context telemetry does not observe the available catalog again.
  const catalogFingerprint = (snapshot: AgentSessionModelsSnapshot): string => JSON.stringify(
    snapshot.models?.map(({ contextWindowTokens: _context, ...model }) => model) ?? null,
  );
  let runtimeCatalogFingerprint = catalogFingerprint(runtime);
  let runtimeObservedAt = runtime.observedAt ?? (runtime.models === null ? 0 : Date.now());
  // Startup's accepted binding/facts and the first runtime catalog share one
  // publisher mutation. Consume the target once so later observations cannot
  // restore a superseded startup binding.
  let initialActiveTarget = params.initialActiveTarget ?? null;
  const metadataSnapshot = params.session.getMetadataSnapshot();
  const initialMetadata = initialActiveTarget && metadataSnapshot
    ? applyStartupTargetFacts(metadataSnapshot, initialActiveTarget)
    : metadataSnapshot;
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
    && params.initialActiveSelection.source === 'runtime_apply'
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
  let providerBindingAwaitingRuntimeConfirmation = false;
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
  ): SessionActiveModelSelection | null => {
    const runner = params.runnerProcessIdentity;
    const agentTargetKey = params.agentTargetKey;
    if (!runner || !agentTargetKey) return null;
    const bindingState = readSessionProviderBindingMetadataStateV1(metadata);
    // Configuring a different Provider does not prove its materialization from
    // a shared model id. Native observations can still report their actual id.
    if (providerBindingAwaitingRuntimeConfirmation && bindingState.kind !== 'absent') return null;
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
    const fact = createSessionActiveModelSelection({
      selection: {
        agentTargetKey,
        providerConnectionId,
        modelId: runtimeCurrentModelId,
      },
      source: 'runtime_readback',
      runner,
      teamCredentialModel: params.readAppliedTeamCredentialModel ? params.readAppliedTeamCredentialModel() : null,
      connectedAccountSelection: params.readAppliedConnectedAccountSelection?.(),
    });
    if (!fact) return null;
    return readExactSessionActiveModelSelection({
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
      const startupTarget = initialActiveTarget;
      const observedMetadata = params.session.getMetadataSnapshot();
      const metadata = startupTarget && observedMetadata
        ? applyStartupTargetFacts(observedMetadata, startupTarget)
        : observedMetadata;
      const observedCurrent = observedMetadata?.sessionModelsV1 ?? null;
      const current = stateForAgent(metadata?.sessionModelsV1 ?? null, params.agentId);
      const base = mergeBaseState(canonicalBase, legacyAcpBase);
      const merged = mergeState({
        agentId: params.agentId,
        base: runtime.observedAt === 0 ? mergeBaseState(current, base) : base,
        previous: current,
        runtime,
        observedAt: runtimeObservedAt,
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
      if (!startupTarget && stateFingerprint(observedCurrent) === stateFingerprint(desired)) {
        lastPublished = desired;
        return;
      }
      lastPublished = desired;
      await params.session.updateMetadataAsCurrentPublisher((metadata) => {
        const current = startupTarget
          ? applyStartupTargetFacts(metadata, startupTarget)
          : metadata;
        if (desired) return { ...current, sessionModelsV1: desired };
        const { sessionModelsV1: _removed, ...rest } = current;
        return rest;
      });
      initialActiveTarget = null;
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
    const fingerprint = catalogFingerprint(snapshot);
    // The observation time dates the catalog, not each re-observation: a repeated identical
    // catalog keeps its time so an unchanged Turn publishes nothing. Zero (static/current-only
    // facts) and a first catalog are always taken.
    const catalogChanged = fingerprint !== runtimeCatalogFingerprint;
    if (snapshot.observedAt === 0 || (snapshot.observedAt !== undefined && (catalogChanged || runtimeObservedAt === 0))) {
      runtimeObservedAt = snapshot.observedAt;
    } else if (snapshot.observedAt === undefined && snapshot.models !== null && catalogChanged) runtimeObservedAt = Date.now();
    runtimeCatalogFingerprint = fingerprint;
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
        const previousBindingConfirmation = providerBindingAwaitingRuntimeConfirmation;
        const ownRunner = params.runnerProcessIdentity;
        if (
          input.activeSelectionV1 && (!ownRunner
          || ownRunner.pid !== input.activeSelectionV1.runner.pid
          || ownRunner.processStartTimeMs
            !== input.activeSelectionV1.runner.processStartTimeMs
          || input.selection.agentTargetKey
            !== input.activeSelectionV1.selection.agentTargetKey
          || input.selection.providerConnectionId
            !== input.activeSelectionV1.selection.providerConnectionId
          || input.selection.modelId
            !== input.activeSelectionV1.selection.modelId)
        ) {
          throw new Error(
            'Active model publication requires the current host process witness and exact selection',
          );
        }
        authoritativeSelection = input.activeSelectionV1?.source === 'runtime_apply'
          ? input.activeSelectionV1 : null;
        providerBindingAwaitingRuntimeConfirmation = input.activeSelectionV1 === null;
        publicationSuppressed = true;
        publicationRequestedWhileSuppressed = false;
        try {
          await input.publishActive();
        } catch (error) {
          authoritativeSelection = previousAuthority;
          providerBindingAwaitingRuntimeConfirmation = previousBindingConfirmation;
          throw error;
        } finally {
          publicationSuppressed = false;
        }
      });
      ownOperation(operation);
      await operation;
      const shouldPublish =
        publicationRequestedWhileSuppressed || authoritativeSelection !== null
        || providerBindingAwaitingRuntimeConfirmation;
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
      providerBindingAwaitingRuntimeConfirmation = false;
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
