import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import type { RuntimeInstallableAdapter } from './runtimeInstallablesRegistry';
import {
  readRuntimeInstallableLastCheckAtMs,
  writeRuntimeInstallableLastCheckAtMs,
} from './runtimeInstallableUpdateState';

type Deps = Readonly<{
  readLastCheckAtMs: (installableKey: string) => Promise<number | null>;
  writeLastCheckAtMs: (installableKey: string, lastCheckAtMs: number) => Promise<void>;
  autoUpdateCheckIntervalMs: number;
}>;

const inMemoryBlockedUntilMsByInstallableKey = new Map<string, number>();

function isBlockedInMemory(installableKey: string, nowMs: number): boolean {
  const blockedUntilMs = inMemoryBlockedUntilMsByInstallableKey.get(installableKey);
  if (blockedUntilMs == null) return false;
  if (blockedUntilMs > nowMs) return true;
  inMemoryBlockedUntilMsByInstallableKey.delete(installableKey);
  return false;
}

export async function startBackgroundRuntimeInstallableUpdate(
  params: Readonly<{
    installableKey: string;
    adapter: RuntimeInstallableAdapter;
  }>,
  depsOverrides: Partial<Deps> = {},
): Promise<void> {
  const deps: Deps = {
    readLastCheckAtMs: depsOverrides.readLastCheckAtMs ?? readRuntimeInstallableLastCheckAtMs,
    writeLastCheckAtMs: depsOverrides.writeLastCheckAtMs ?? writeRuntimeInstallableLastCheckAtMs,
    autoUpdateCheckIntervalMs:
      depsOverrides.autoUpdateCheckIntervalMs ?? configuration.installablesRuntimeAutoUpdateCheckIntervalMs,
  };

  const nowMs = Date.now();
  if (isBlockedInMemory(params.installableKey, nowMs)) return;

  let lastCheckAtMs: number | null = null;
  try {
    lastCheckAtMs = await deps.readLastCheckAtMs(params.installableKey);
  } catch (error) {
    logger.warn(
      `[installables] failed to read background auto-update state for ${params.installableKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof lastCheckAtMs === 'number' &&
    Number.isFinite(lastCheckAtMs) &&
    nowMs - lastCheckAtMs < deps.autoUpdateCheckIntervalMs
  ) {
    inMemoryBlockedUntilMsByInstallableKey.set(
      params.installableKey,
      lastCheckAtMs + deps.autoUpdateCheckIntervalMs,
    );
    return;
  }

  const nextBlockedUntilMs = nowMs + deps.autoUpdateCheckIntervalMs;
  inMemoryBlockedUntilMsByInstallableKey.set(params.installableKey, nextBlockedUntilMs);
  try {
    await deps.writeLastCheckAtMs(params.installableKey, nowMs);
  } catch (error) {
    logger.warn(
      `[installables] failed to persist background auto-update state for ${params.installableKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    await params.adapter.runBackgroundAutoUpdateCheck();
  } catch (error) {
    logger.warn(
      `[installables] background auto-update check failed for ${params.installableKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
