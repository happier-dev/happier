import type { Metadata } from '@/api/types';
import type { AgentSessionModelsSnapshot, AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  isRuntimeConfigUpdateOutcomeApplied,
  type RuntimeConfigUpdateOutcomeV1,
} from '@happier-dev/agents/runtime/session/runtimeConfigUpdateOutcome';
import {
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/agents/session/state/bindings/metadataKeys';
import { readAcpConfigOptionIntentFromMetadata, readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { readSessionModelSelectionIntentSourceV1, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import {
  readMetadataAliasValue,
  SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
} from '@happier-dev/agents/session/controls/metadataKeys';
import { clearAcpConfigOptionIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { logger } from '@/ui/logger';

type ConfigOptionValueId = string | number | boolean | null;
type ConfigOptionOverrideCandidate = { configId: string; valueId: ConfigOptionValueId; updatedAt: number };
export type SessionConfigOptionRejection = Readonly<{
  candidate: ConfigOptionOverrideCandidate;
  outcome: RuntimeConfigUpdateOutcomeV1;
}>;

function normalizeValueId(raw: unknown): ConfigOptionValueId | undefined {
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return undefined;
}

function collectConfigOptionIdsFromAliasRoot(metadata: Readonly<Record<string, unknown>> | null | undefined, key: string, out: Set<string>): void {
  const root = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[key] : null;
  const rootRecord = root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : null;
  const overridesRaw = rootRecord?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) return;

  for (const configIdRaw of Object.keys(overridesRaw as Record<string, unknown>)) {
    if (configIdRaw.trim()) out.add(configIdRaw);
  }
}

function collectConfigOptionIdsFromMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): string[] {
  const configIds = new Set<string>();
  collectConfigOptionIdsFromAliasRoot(metadata, SESSION_CONFIG_OPTION_OVERRIDES_KEY, configIds);
  collectConfigOptionIdsFromAliasRoot(metadata, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY, configIds);
  return Array.from(configIds);
}

function resolveUnavailableModelOptionIds(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  modelSelection?: Pick<ProviderBoundModelRef, 'modelId' | 'providerConnectionId'>,
  models?: AgentSessionModelsSnapshot,
): ReadonlySet<string> {
  const unavailable = new Set<string>();
  const catalog = readMetadataAliasValue<Metadata['sessionModelsV1']>(metadata,
    SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY);
  const availableModels = models?.models ?? (
    catalog?.agentId === resolveAgentIdFromSessionMetadata(metadata) ? catalog?.availableModels : undefined
  );
  if (!availableModels || (!models?.models && !Array.isArray(availableModels))) return unavailable;
  const source = readSessionModelSelectionIntentSourceV1({
    canonical: metadata?.modelSelectionIntentV1, legacy: metadata?.modelOverrideV1,
  });
  const v2Intent = readSessionModelSelectionV2FromMetadata(metadata);
  const providerBound = modelSelection
    ? modelSelection.providerConnectionId !== null
    : v2Intent ? v2Intent.ref.source !== 'native'
      : source.status === 'canonical' && source.intent.selection?.providerConnectionId != null;
  // Provider descriptors have their own exact option authority; a native row
  // with the same id cannot decide their controls (or a retained Provider row's).
  if (providerBound || catalog?.activeSelectionV1?.selection.providerConnectionId != null) return unavailable;
  const selectedModelId = modelSelection?.modelId ?? v2Intent?.ref.modelId
    ?? (source.status === 'canonical' ? source.intent.selection?.modelId
      : source.status === 'legacy' ? source.intent.modelId : undefined)
    ?? models?.currentModelId ?? catalog?.currentModelId;
  const selected = availableModels.find(model => model.id === selectedModelId
    || model.extendedContextModelId === selectedModelId);
  if (!selected) return unavailable;

  // The catalog declares which controls are model-scoped. An absent control on
  // the selected model is inapplicable; an unknown catalog supplies no decision.
  for (const model of availableModels) {
    for (const option of model.modelOptions ?? []) unavailable.add(option.id);
  }
  for (const option of selected.modelOptions ?? []) unavailable.delete(option.id);
  const sessionOptions = readMetadataAliasValue<Metadata['sessionConfigOptionsV1']>(metadata,
    SESSION_CONFIG_OPTIONS_STATE_KEY, LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY);
  if (sessionOptions?.agentId === resolveAgentIdFromSessionMetadata(metadata)) {
    for (const option of sessionOptions.configOptions) unavailable.delete(option.id);
  }
  return unavailable;
}

export function resolveSessionConfigOptionOverridesFromMetadataSnapshot(opts: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null | undefined;
}>): ConfigOptionOverrideCandidate[] {
  const out: ConfigOptionOverrideCandidate[] = [];
  const configIds = collectConfigOptionIdsFromMetadata(opts.metadata);
  for (const configId of configIds) {
    const intent = readAcpConfigOptionIntentFromMetadata(opts.metadata ?? {}, configId);
    if (!intent) continue;
    const valueId = normalizeValueId(intent.value);
    if (valueId === undefined) continue;
    out.push({ configId: intent.configId, valueId, updatedAt: intent.updatedAt });
  }

  out.sort((a, b) => (a.updatedAt - b.updatedAt) || a.configId.localeCompare(b.configId));
  return out;
}

/** Runtime projection only: retained intent remains available when models change. */
export function resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot(opts: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null | undefined;
  modelSelection?: Pick<ProviderBoundModelRef, 'modelId' | 'providerConnectionId'>;
  models?: AgentSessionModelsSnapshot;
}>): ConfigOptionOverrideCandidate[] {
  const candidates = resolveSessionConfigOptionOverridesFromMetadataSnapshot(opts);
  if (candidates.length === 0) return candidates;
  const unavailable = resolveUnavailableModelOptionIds(opts.metadata, opts.modelSelection, opts.models);
  return candidates.filter(candidate => !unavailable.has(candidate.configId));
}

function isSameConfigOptionOverrideValue(left: ConfigOptionValueId, right: ConfigOptionValueId): boolean {
  return Object.is(left, right);
}

function isSameConfigOptionOverrideCandidate(
  left: ConfigOptionOverrideCandidate,
  right: ConfigOptionOverrideCandidate,
): boolean {
  return left.updatedAt === right.updatedAt && isSameConfigOptionOverrideValue(left.valueId, right.valueId);
}

function shouldSuppressConfigOptionOverrideCandidate(
  candidate: ConfigOptionOverrideCandidate,
  lastApplied: ConfigOptionOverrideCandidate | undefined,
): boolean {
  if (!lastApplied) return false;
  if (candidate.updatedAt < lastApplied.updatedAt) return true;
  return isSameConfigOptionOverrideCandidate(candidate, lastApplied);
}

function shouldReplacePendingConfigOptionOverrideCandidate(
  candidate: ConfigOptionOverrideCandidate,
  pending: ConfigOptionOverrideCandidate | undefined,
): boolean {
  if (!pending) return true;
  if (candidate.updatedAt > pending.updatedAt) return true;
  return candidate.updatedAt === pending.updatedAt
    && !isSameConfigOptionOverrideValue(candidate.valueId, pending.valueId);
}

export function createSessionConfigOptionOverrideSynchronizer(params: Readonly<{
  session: {
    getMetadataSnapshot: () => Metadata | null;
    updateMetadataAsCurrentPublisher?: (update: (metadata: Metadata) => Metadata) => Promise<unknown>;
  };
  runtime: {
    setSessionConfigOption: (
      configId: string,
      valueId: ConfigOptionValueId,
    ) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  };
  isStarted: () => boolean;
  models?: Pick<AgentSessionModelsSource, 'read'>;
  onConfigOptionRejected?: (rejection: SessionConfigOptionRejection) => void | Promise<void>;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  const lastSettledByConfigId = new Map<string, ConfigOptionOverrideCandidate>();
  const pendingByConfigId = new Map<string, ConfigOptionOverrideCandidate>();
  const inFlightByConfigId = new Map<string, Promise<void>>();

  const applyPendingForConfigId = (configId: string): Promise<void> => {
    const inFlight = inFlightByConfigId.get(configId);
    if (inFlight) return inFlight;

    const candidate = pendingByConfigId.get(configId);
    if (!candidate) return Promise.resolve();
    if (!params.isStarted()) return Promise.resolve();

    const lastApplied = lastSettledByConfigId.get(configId);
    if (shouldSuppressConfigOptionOverrideCandidate(candidate, lastApplied)) {
      pendingByConfigId.delete(configId);
      return Promise.resolve();
    }

    const promise = params.runtime
      .setSessionConfigOption(candidate.configId, candidate.valueId)
      .then(async (outcome) => {
        const applied = isRuntimeConfigUpdateOutcomeApplied(outcome);
        const rejected = !applied && (outcome?.status === 'failed' || outcome?.status === 'unsupported');
        if (!rejected && !applied) return;
        // A definitive refusal settles this request without claiming its value became effective.
        lastSettledByConfigId.set(candidate.configId, candidate);
        const currentPending = pendingByConfigId.get(candidate.configId);
        if (currentPending && isSameConfigOptionOverrideCandidate(currentPending, candidate)) {
          pendingByConfigId.delete(candidate.configId);
        }
        if (rejected && outcome) {
          try {
            await params.session.updateMetadataAsCurrentPublisher?.(metadata => clearAcpConfigOptionIntentSessionMetadata(metadata, {
              configId: candidate.configId, value: candidate.valueId, updatedAt: candidate.updatedAt,
            }));
          } finally {
            await params.onConfigOptionRejected?.({ candidate, outcome });
          }
        }
      })
      .catch(() => {
        // Thrown transport failures remain pending. Publication failures cannot retry a settled setter.
        if (lastSettledByConfigId.get(configId) === candidate) {
          logger.infoFile('[SessionConfigOptionOverrideSync] Could not publish configuration rejection');
        }
      })
      .finally(() => {
        inFlightByConfigId.delete(configId);
        const nextPending = pendingByConfigId.get(configId);
        if (
          nextPending
          && !isSameConfigOptionOverrideCandidate(nextPending, candidate)
          && nextPending.updatedAt >= candidate.updatedAt
          && params.isStarted()
        ) {
          void applyPendingForConfigId(configId);
        }
      });

    inFlightByConfigId.set(configId, promise);
    return promise;
  };

  const syncFromMetadata = (): void => {
    const candidates = resolveApplicableSessionConfigOptionOverridesFromMetadataSnapshot({
      metadata: params.session.getMetadataSnapshot(),
      // Declarations are available before native readback can publish a current model.
      models: params.models?.read(),
    });
    const candidateIds = new Set(candidates.map(candidate => candidate.configId));
    for (const configId of pendingByConfigId.keys()) {
      if (!candidateIds.has(configId)) pendingByConfigId.delete(configId);
    }
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      const lastApplied = lastSettledByConfigId.get(candidate.configId);
      if (shouldSuppressConfigOptionOverrideCandidate(candidate, lastApplied)) continue;

      const prevPending = pendingByConfigId.get(candidate.configId);
      if (!shouldReplacePendingConfigOptionOverrideCandidate(candidate, prevPending)) {
        if (params.isStarted()) {
          void applyPendingForConfigId(candidate.configId);
        }
        continue;
      }
      pendingByConfigId.set(candidate.configId, candidate);

      if (!params.isStarted()) {
        continue;
      }

      void applyPendingForConfigId(candidate.configId);
    }
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    if (!params.isStarted()) return;
    if (pendingByConfigId.size === 0) {
      await Promise.all(inFlightByConfigId.values());
      return;
    }

    const pending = Array.from(pendingByConfigId.values()).sort(
      (a, b) => (a.updatedAt - b.updatedAt) || a.configId.localeCompare(b.configId),
    );

    for (const item of pending) {
      await applyPendingForConfigId(item.configId);
    }
  };

  return { syncFromMetadata, flushPendingAfterStart };
}

export const createAcpConfigOptionOverrideSynchronizer = createSessionConfigOptionOverrideSynchronizer;
