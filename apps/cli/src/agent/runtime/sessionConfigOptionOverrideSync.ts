import type { Metadata } from '@/api/types';
import {
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  readMetadataAliasValue,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/agents';

type ConfigOptionValueId = string;

function normalizeValueId(raw: unknown): ConfigOptionValueId | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

function parseOverrides(metadata: Metadata | null): Array<{ configId: string; valueId: ConfigOptionValueId; updatedAt: number }> {
  const root = readMetadataAliasValue<Record<string, unknown>>(
    metadata,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  ) ?? null;
  const overridesRaw = root?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) return [];

  const out: Array<{ configId: string; valueId: ConfigOptionValueId; updatedAt: number }> = [];

  for (const [configIdRaw, entryRaw] of Object.entries(overridesRaw as Record<string, unknown>)) {
    const configId = typeof configIdRaw === 'string' ? configIdRaw.trim() : '';
    if (!configId) continue;
    const entry = entryRaw && typeof entryRaw === 'object' && !Array.isArray(entryRaw) ? (entryRaw as Record<string, unknown>) : null;
    if (!entry) continue;
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
    if (updatedAt === null) continue;

    const valueId = normalizeValueId(entry.value);
    if (!valueId) continue;

    out.push({ configId, valueId, updatedAt });
  }

  out.sort((a, b) => (a.updatedAt - b.updatedAt) || a.configId.localeCompare(b.configId));
  return out;
}

export function createSessionConfigOptionOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionConfigOption: (configId: string, valueId: ConfigOptionValueId) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  const lastAppliedUpdatedAtByConfigId = new Map<string, number>();
  const pendingByConfigId = new Map<string, { configId: string; valueId: ConfigOptionValueId; updatedAt: number }>();
  const inFlightByConfigId = new Map<string, Promise<void>>();

  const applyPendingForConfigId = (configId: string): Promise<void> => {
    const inFlight = inFlightByConfigId.get(configId);
    if (inFlight) return inFlight;

    const candidate = pendingByConfigId.get(configId);
    if (!candidate) return Promise.resolve();
    if (!params.isStarted()) return Promise.resolve();

    const lastApplied = lastAppliedUpdatedAtByConfigId.get(configId) ?? 0;
    if (candidate.updatedAt <= lastApplied) {
      pendingByConfigId.delete(configId);
      return Promise.resolve();
    }

    const promise = params.runtime
      .setSessionConfigOption(candidate.configId, candidate.valueId)
      .then(() => {
        lastAppliedUpdatedAtByConfigId.set(candidate.configId, candidate.updatedAt);
        const currentPending = pendingByConfigId.get(candidate.configId);
        if (currentPending?.updatedAt === candidate.updatedAt) {
          pendingByConfigId.delete(candidate.configId);
        }
      })
      .catch(() => {
        // Best-effort only. Keep the candidate pending so a later sync or flush can retry it.
      })
      .finally(() => {
        inFlightByConfigId.delete(configId);
        const nextPending = pendingByConfigId.get(configId);
        if (nextPending && nextPending.updatedAt > candidate.updatedAt && params.isStarted()) {
          void applyPendingForConfigId(configId);
        }
      });

    inFlightByConfigId.set(configId, promise);
    return promise;
  };

  const syncFromMetadata = (): void => {
    const candidates = parseOverrides(params.session.getMetadataSnapshot());
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      const lastApplied = lastAppliedUpdatedAtByConfigId.get(candidate.configId) ?? 0;
      if (candidate.updatedAt <= lastApplied) continue;

      const prevPending = pendingByConfigId.get(candidate.configId);
      if (prevPending && prevPending.updatedAt >= candidate.updatedAt) {
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
