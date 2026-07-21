import type { Metadata } from '@/api/types';
import {
  computeNextMetadataConfigOptionOverrideV1,
  readNewestSessionConfigOptionOverridesMetadataStateV1,
} from '@happier-dev/agents';
import { isDefinitiveSessionControlApplyError } from './sessionControlApplyError';
import { logger } from '@/ui/logger';

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

export function resolveSessionConfigOptionOverridesFromMetadataSnapshot(opts: Readonly<{
  metadata: Metadata | null | undefined;
}>): Array<{ configId: string; valueId: ConfigOptionValueId; updatedAt: number }> {
  const root = readNewestSessionConfigOptionOverridesMetadataStateV1(opts.metadata ?? null);
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
  session: {
    getMetadataSnapshot: () => Metadata | null;
    updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
  };
  runtime: { setSessionConfigOption: (configId: string, valueId: ConfigOptionValueId) => Promise<void> };
  isStarted: () => boolean;
  autoApplyFromMetadata?: boolean;
  reportTerminalFailure?: (failure: Readonly<{ kind: 'config'; configId: string; requested: string; error: unknown }>) => void;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
  retirePendingThrough: (updatedAt: number) => Promise<void>;
  rebindSession: (session: {
    getMetadataSnapshot: () => Metadata | null;
    updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
  }) => void;
} {
  type ConfigCommand = { configId: string; valueId: ConfigOptionValueId; updatedAt: number };
  let session = params.session;
  const settledByConfigId = new Map<string, { updatedAt: number; valueIds: Set<string> }>();
  const pendingByConfigId = new Map<string, ConfigCommand>();
  const inFlightByConfigId = new Map<string, Promise<void>>();
  const cleanupByConfigId = new Map<string, ConfigCommand>();
  const cleanupPromiseByConfigId = new Map<string, Promise<void>>();

  const isSameCommand = (left: ConfigCommand | undefined, right: ConfigCommand): boolean =>
    left?.configId === right.configId
    && left.updatedAt === right.updatedAt
    && left.valueId === right.valueId;

  const isSettled = (command: ConfigCommand): boolean => {
    const settled = settledByConfigId.get(command.configId);
    return settled !== undefined && (
      command.updatedAt < settled.updatedAt
      || (command.updatedAt === settled.updatedAt && settled.valueIds.has(command.valueId))
    );
  };

  const markSettled = (command: ConfigCommand): void => {
    const settled = settledByConfigId.get(command.configId);
    if (!settled || command.updatedAt > settled.updatedAt) {
      settledByConfigId.set(command.configId, { updatedAt: command.updatedAt, valueIds: new Set([command.valueId]) });
      return;
    }
    if (command.updatedAt === settled.updatedAt) settled.valueIds.add(command.valueId);
  };

  const retryCleanupForConfigId = (configId: string): Promise<void> => {
    const existing = cleanupPromiseByConfigId.get(configId);
    if (existing) return existing;
    const obligation = cleanupByConfigId.get(configId);
    if (!obligation || !session.updateMetadata) return Promise.resolve();

    const promise = session.updateMetadata((metadata) => {
      const current = resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata })
        .find((entry) => entry.configId === obligation.configId);
      if (!current || !isSameCommand(current, obligation)) return metadata;
      return computeNextMetadataConfigOptionOverrideV1({
        metadata,
        configId: obligation.configId,
        value: null,
        updatedAt: obligation.updatedAt + 1,
      }) as Metadata;
    }).then(() => {
      if (isSameCommand(cleanupByConfigId.get(configId), obligation)) cleanupByConfigId.delete(configId);
    }).catch((cleanupError) => {
      logger.debug('[sessionConfigOptionOverrideSync] Provider rejected config option and metadata cleanup failed; cleanup will retry on the next sync', cleanupError);
    }).finally(() => {
      cleanupPromiseByConfigId.delete(configId);
    });
    cleanupPromiseByConfigId.set(configId, promise);
    return promise;
  };

  const applyPendingForConfigId = (configId: string): Promise<void> => {
    const inFlight = inFlightByConfigId.get(configId);
    if (inFlight) return inFlight;

    const candidate = pendingByConfigId.get(configId);
    if (!candidate) return Promise.resolve();
    if (!params.isStarted()) return Promise.resolve();

    if (isSettled(candidate)) {
      pendingByConfigId.delete(configId);
      return Promise.resolve();
    }

    const promise = params.runtime
      .setSessionConfigOption(candidate.configId, candidate.valueId)
      .then(() => {
        markSettled(candidate);
        const currentPending = pendingByConfigId.get(candidate.configId);
        if (isSameCommand(currentPending, candidate)) {
          pendingByConfigId.delete(candidate.configId);
        }
      })
      .catch(async (error) => {
        if (isDefinitiveSessionControlApplyError(error)) {
          markSettled(candidate);
          if (isSameCommand(pendingByConfigId.get(candidate.configId), candidate)) {
            pendingByConfigId.delete(candidate.configId);
          }
          cleanupByConfigId.set(candidate.configId, candidate);
          await retryCleanupForConfigId(candidate.configId);
          params.reportTerminalFailure?.({
            kind: 'config',
            configId: candidate.configId,
            requested: candidate.valueId,
            error,
          });
          return;
        }
        // Best-effort only. Keep the candidate pending so a later sync or flush can retry it.
      })
      .finally(() => {
        inFlightByConfigId.delete(configId);
        const nextPending = pendingByConfigId.get(configId);
        if (nextPending && !isSameCommand(nextPending, candidate) && !isSettled(nextPending) && params.isStarted()) {
          void applyPendingForConfigId(configId);
        }
      });

    inFlightByConfigId.set(configId, promise);
    return promise;
  };

  const syncFromMetadata = (): void => {
    const candidates = resolveSessionConfigOptionOverridesFromMetadataSnapshot({
      metadata: session.getMetadataSnapshot(),
    });
    for (const configId of cleanupByConfigId.keys()) void retryCleanupForConfigId(configId);
    const candidateIds = new Set(candidates.map((candidate) => candidate.configId));
    for (const pendingId of pendingByConfigId.keys()) {
      if (!candidateIds.has(pendingId)) pendingByConfigId.delete(pendingId);
    }
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      if (isSettled(candidate)) continue;

      const prevPending = pendingByConfigId.get(candidate.configId);
      if (prevPending && (prevPending.updatedAt > candidate.updatedAt || isSameCommand(prevPending, candidate))) {
        if (params.autoApplyFromMetadata !== false && params.isStarted()) {
          void applyPendingForConfigId(candidate.configId);
        }
        continue;
      }
      pendingByConfigId.set(candidate.configId, candidate);

      if (params.autoApplyFromMetadata === false || !params.isStarted()) {
        continue;
      }

      void applyPendingForConfigId(candidate.configId);
    }
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    for (const configId of Array.from(cleanupByConfigId.keys()).sort()) {
      await retryCleanupForConfigId(configId);
    }
    if (pendingByConfigId.size === 0) return;
    if (!params.isStarted()) return;

    const pending = Array.from(pendingByConfigId.values()).sort(
      (a, b) => (a.updatedAt - b.updatedAt) || a.configId.localeCompare(b.configId),
    );

    for (const item of pending) {
      await applyPendingForConfigId(item.configId);
    }
  };

  return {
    syncFromMetadata,
    flushPendingAfterStart,
    retirePendingThrough: async (updatedAt) => {
      const retired: ConfigCommand[] = [];
      for (const command of pendingByConfigId.values()) {
        if (command.updatedAt > updatedAt) continue;
        markSettled(command);
        cleanupByConfigId.set(command.configId, command);
        retired.push(command);
        if (isSameCommand(pendingByConfigId.get(command.configId), command)) {
          pendingByConfigId.delete(command.configId);
        }
      }
      for (const command of retired.sort((a, b) => a.configId.localeCompare(b.configId))) {
        await retryCleanupForConfigId(command.configId);
      }
    },
    rebindSession: (nextSession) => { session = nextSession; },
  };
}

export const createAcpConfigOptionOverrideSynchronizer = createSessionConfigOptionOverrideSynchronizer;
