import type { Metadata } from '@/api/types';
import type {
  AgentSessionHostServices,
} from '@happier-dev/plugin-sdk/agent-runtime';

type AgentSessionModelsSource = Parameters<AgentSessionHostServices['models']['bind']>[0];
type AgentSessionModelsSnapshot = ReturnType<AgentSessionModelsSource['read']>;

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModel = SessionModelsState['availableModels'][number];

type ModelPublisherSession = Readonly<{
  getMetadataSnapshot(): Metadata | null;
  updateMetadata(updater: (current: Metadata) => Metadata): Promise<void> | void;
  on(event: 'metadata-updated', listener: () => void): unknown;
  off(event: 'metadata-updated', listener: () => void): unknown;
}>;

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
): SessionModel['modelOptions'] {
  const output: NonNullable<SessionModel['modelOptions']> = [];
  const seen = new Set<string>();
  for (const option of [...(runtime ?? []), ...(base ?? [])]) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    output.push({
      id: option.id,
      name: option.name,
      ...(option.description === undefined ? {} : { description: option.description }),
      type: option.type,
      currentValue: option.currentValue,
      ...(option.options === undefined ? {} : { options: [...option.options] }),
    });
  }
  return output.length > 0 ? output : undefined;
}

function mergeState(params: Readonly<{
  agentId: string;
  base: SessionModelsState | null;
  previous: SessionModelsState | null;
  runtime: AgentSessionModelsSnapshot;
}>): SessionModelsState | null {
  if (params.runtime.models === null) return params.base;
  const availableModels: SessionModel[] = [];
  const indexById = new Map<string, number>();
  for (const model of params.runtime.models) {
    if (indexById.has(model.id)) continue;
    indexById.set(model.id, availableModels.length);
    availableModels.push({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
      ...(model.modelOptions?.length ? { modelOptions: mergeOptions(model.modelOptions, undefined) } : {}),
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
    const modelOptions = mergeOptions(existing.modelOptions, model.modelOptions);
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
      ...(modelOptions ? { modelOptions } : {}),
    };
  }
  if (availableModels.length === 0) return params.base;
  const candidates = [
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
  };
}

export function createSessionRuntimeModelsPublisher(params: Readonly<{
  agentId: string;
  session: ModelPublisherSession;
  source: AgentSessionModelsSource;
}>): Readonly<{ flush(): Promise<void>; stopAndDrain(): Promise<void>; dispose(): void }> {
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

  const stopAcceptingPublications = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe.dispose();
    params.session.off('metadata-updated', onMetadataUpdated);
  };

  const publish = (): void => {
    pending = pending.then(async () => {
      if (stopped) return;
      const observedCurrent =
        params.session.getMetadataSnapshot()?.sessionModelsV1 ?? null;
      const current = stateForAgent(observedCurrent, params.agentId);
      const base = mergeBaseState(canonicalBase, legacyAcpBase);
      const desired = mergeState({ agentId: params.agentId, base, previous: current, runtime });
      if (stateFingerprint(observedCurrent) === stateFingerprint(desired)) {
        lastPublished = desired;
        return;
      }
      lastPublished = desired;
      await params.session.updateMetadata((metadata) => {
        if (desired) return { ...metadata, sessionModelsV1: desired };
        const { sessionModelsV1: _removed, ...rest } = metadata;
        return rest;
      });
    });
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
    flush: async () => {
      await pending;
    },
    stopAndDrain: async () => {
      stopAcceptingPublications();
      await pending;
    },
    dispose() {
      stopAcceptingPublications();
    },
  });
}
