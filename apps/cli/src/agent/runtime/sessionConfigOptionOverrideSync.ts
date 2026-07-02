import type { Metadata } from '@/api/types';
import {
  isRuntimeConfigUpdateOutcomeApplied,
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  readAcpConfigOptionIntentFromMetadata,
  type RuntimeConfigUpdateOutcomeV1,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/agents';

type ConfigOptionValueId = string | number | boolean | null;
type ConfigOptionOverrideCandidate = { configId: string; valueId: ConfigOptionValueId; updatedAt: number };

function normalizeValueId(raw: unknown): ConfigOptionValueId | undefined {
  if (raw === null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return undefined;
}

function collectConfigOptionIdsFromAliasRoot(metadata: Metadata | null | undefined, key: string, out: Set<string>): void {
  const root = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[key] : null;
  const rootRecord = root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : null;
  const overridesRaw = rootRecord?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) return;

  for (const configIdRaw of Object.keys(overridesRaw as Record<string, unknown>)) {
    const configId = configIdRaw.trim();
    if (configId) out.add(configId);
  }
}

function collectConfigOptionIdsFromMetadata(metadata: Metadata | null | undefined): string[] {
  const configIds = new Set<string>();
  collectConfigOptionIdsFromAliasRoot(metadata, SESSION_CONFIG_OPTION_OVERRIDES_KEY, configIds);
  collectConfigOptionIdsFromAliasRoot(metadata, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY, configIds);
  return Array.from(configIds);
}

export function resolveSessionConfigOptionOverridesFromMetadataSnapshot(opts: Readonly<{
  metadata: Metadata | null | undefined;
}>): ConfigOptionOverrideCandidate[] {
  const out: ConfigOptionOverrideCandidate[] = [];
  const configIds = collectConfigOptionIdsFromMetadata(opts.metadata);
  for (const configId of configIds) {
    const intent = readAcpConfigOptionIntentFromMetadata((opts.metadata ?? {}) as Metadata, configId);
    if (!intent) continue;
    const valueId = normalizeValueId(intent.value);
    if (valueId === undefined) continue;
    out.push({ configId: intent.configId, valueId, updatedAt: intent.updatedAt });
  }

  out.sort((a, b) => (a.updatedAt - b.updatedAt) || a.configId.localeCompare(b.configId));
  return out;
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
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: {
    setSessionConfigOption: (
      configId: string,
      valueId: ConfigOptionValueId,
    ) => Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  const lastAppliedByConfigId = new Map<string, ConfigOptionOverrideCandidate>();
  const pendingByConfigId = new Map<string, ConfigOptionOverrideCandidate>();
  const inFlightByConfigId = new Map<string, Promise<void>>();

  const applyPendingForConfigId = (configId: string): Promise<void> => {
    const inFlight = inFlightByConfigId.get(configId);
    if (inFlight) return inFlight;

    const candidate = pendingByConfigId.get(configId);
    if (!candidate) return Promise.resolve();
    if (!params.isStarted()) return Promise.resolve();

    const lastApplied = lastAppliedByConfigId.get(configId);
    if (shouldSuppressConfigOptionOverrideCandidate(candidate, lastApplied)) {
      pendingByConfigId.delete(configId);
      return Promise.resolve();
    }

    const promise = params.runtime
      .setSessionConfigOption(candidate.configId, candidate.valueId)
      .then((outcome) => {
        // gap 27: only mark the override applied when the runtime confirms it took effect. A
        // swallowed/deferred/unsupported outcome leaves the candidate pending so a later sync or
        // flush re-attempts it at the next safe boundary, instead of being marked applied forever.
        if (!isRuntimeConfigUpdateOutcomeApplied(outcome)) return;
        lastAppliedByConfigId.set(candidate.configId, candidate);
        const currentPending = pendingByConfigId.get(candidate.configId);
        if (currentPending && isSameConfigOptionOverrideCandidate(currentPending, candidate)) {
          pendingByConfigId.delete(candidate.configId);
        }
      })
      .catch(() => {
        // Best-effort only. Keep the candidate pending so a later sync or flush can retry it.
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
    const candidates = resolveSessionConfigOptionOverridesFromMetadataSnapshot({
      metadata: params.session.getMetadataSnapshot(),
    });
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      const lastApplied = lastAppliedByConfigId.get(candidate.configId);
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
    if (pendingByConfigId.size === 0) return;
    if (!params.isStarted()) return;

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
