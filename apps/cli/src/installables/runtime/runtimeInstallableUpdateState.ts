import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';

type RuntimeInstallableUpdateState = Readonly<{
  lastCheckAtMsByInstallableKey: Record<string, number>;
}>;

function runtimeInstallableUpdateStatePath(): string {
  return join(configuration.happyHomeDir, 'installables', 'runtime-auto-update-state.json');
}

async function readRuntimeInstallableUpdateState(): Promise<RuntimeInstallableUpdateState> {
  try {
    const raw = await readFile(runtimeInstallableUpdateStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as { lastCheckAtMsByInstallableKey?: Record<string, unknown> };
    const rawMap = parsed?.lastCheckAtMsByInstallableKey;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
      return { lastCheckAtMsByInstallableKey: {} };
    }

    const lastCheckAtMsByInstallableKey = Object.fromEntries(
      Object.entries(rawMap).flatMap(([key, value]) =>
        typeof value === 'number' && Number.isFinite(value) ? [[key, Math.floor(value)]] : [],
      ),
    );
    return { lastCheckAtMsByInstallableKey };
  } catch {
    return { lastCheckAtMsByInstallableKey: {} };
  }
}

async function writeRuntimeInstallableUpdateState(next: RuntimeInstallableUpdateState): Promise<void> {
  const path = runtimeInstallableUpdateStatePath();
  const dir = dirname(path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8');
  await rename(tempPath, path);
}

export async function readRuntimeInstallableLastCheckAtMs(installableKey: string): Promise<number | null> {
  const state = await readRuntimeInstallableUpdateState();
  const value = state.lastCheckAtMsByInstallableKey[installableKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function writeRuntimeInstallableLastCheckAtMs(
  installableKey: string,
  lastCheckAtMs: number,
): Promise<void> {
  const state = await readRuntimeInstallableUpdateState();
  await writeRuntimeInstallableUpdateState({
    lastCheckAtMsByInstallableKey: {
      ...state.lastCheckAtMsByInstallableKey,
      [installableKey]: Math.floor(lastCheckAtMs),
    },
  });
}
