import type { Metadata } from '@/api/types';

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
  const root = (metadata as any)?.acpConfigOptionOverridesV1;
  const overridesRaw = root?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) return [];

  const out: Array<{ configId: string; valueId: ConfigOptionValueId; updatedAt: number }> = [];

  for (const [configIdRaw, entryRaw] of Object.entries(overridesRaw as Record<string, unknown>)) {
    const configId = typeof configIdRaw === 'string' ? configIdRaw.trim() : '';
    if (!configId) continue;
    const entry = entryRaw && typeof entryRaw === 'object' && !Array.isArray(entryRaw) ? (entryRaw as any) : null;
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

export function createAcpConfigOptionOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionConfigOption: (configId: string, valueId: ConfigOptionValueId) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  const lastAppliedUpdatedAtByConfigId = new Map<string, number>();
  const pendingByConfigId = new Map<string, { configId: string; valueId: ConfigOptionValueId; updatedAt: number }>();

  const syncFromMetadata = (): void => {
    const candidates = parseOverrides(params.session.getMetadataSnapshot());
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      const lastApplied = lastAppliedUpdatedAtByConfigId.get(candidate.configId) ?? 0;
      if (candidate.updatedAt <= lastApplied) continue;

      const prevPending = pendingByConfigId.get(candidate.configId);
      if (prevPending && prevPending.updatedAt >= candidate.updatedAt) {
        continue;
      }
      pendingByConfigId.set(candidate.configId, candidate);

      if (!params.isStarted()) {
        continue;
      }

      params.runtime
        .setSessionConfigOption(candidate.configId, candidate.valueId)
        .then(() => {
          lastAppliedUpdatedAtByConfigId.set(candidate.configId, candidate.updatedAt);
          const currentPending = pendingByConfigId.get(candidate.configId);
          if (currentPending?.updatedAt === candidate.updatedAt) {
            pendingByConfigId.delete(candidate.configId);
          }
        })
        .catch(() => {
          // Best-effort only. Keep newer pending values; clear the failed candidate so a later sync can retry it.
          const currentPending = pendingByConfigId.get(candidate.configId);
          if (currentPending?.updatedAt === candidate.updatedAt) {
            pendingByConfigId.delete(candidate.configId);
          }
        });
    }
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    if (pendingByConfigId.size === 0) return;
    if (!params.isStarted()) return;

    const pending = Array.from(pendingByConfigId.values()).sort(
      (a, b) => (a.updatedAt - b.updatedAt) || a.configId.localeCompare(b.configId),
    );

    for (const item of pending) {
      const currentPending = pendingByConfigId.get(item.configId);
      if (!currentPending || currentPending.updatedAt !== item.updatedAt) continue;

      const lastApplied = lastAppliedUpdatedAtByConfigId.get(item.configId) ?? 0;
      if (item.updatedAt <= lastApplied) {
        pendingByConfigId.delete(item.configId);
        continue;
      }
      try {
        await params.runtime.setSessionConfigOption(item.configId, item.valueId);
        lastAppliedUpdatedAtByConfigId.set(item.configId, item.updatedAt);
        const latestPending = pendingByConfigId.get(item.configId);
        if (latestPending?.updatedAt === item.updatedAt) {
          pendingByConfigId.delete(item.configId);
        }
      } catch {
        // Best-effort only.
      }
    }
  };

  return { syncFromMetadata, flushPendingAfterStart };
}
