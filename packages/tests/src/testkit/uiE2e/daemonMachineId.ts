import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function collectMachineIds(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.values(value)
    .map(normalizeNonEmptyString)
    .filter((machineId): machineId is string => Boolean(machineId));
}

function collectPerAccountMachineIds(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectMachineIds);
}

function singleUniqueMachineId(machineIds: readonly string[]): string | null {
  const unique = [...new Set(machineIds)];
  return unique.length === 1 ? unique[0] ?? null : null;
}

function resolveMachineIdFromSettings(settings: unknown): string | null {
  if (!isRecord(settings)) return null;

  const activeServerId = normalizeNonEmptyString(settings.activeServerId);
  const machineIdByServerId = isRecord(settings.machineIdByServerId) ? settings.machineIdByServerId : null;
  const machineIdByServerIdByAccountId = isRecord(settings.machineIdByServerIdByAccountId)
    ? settings.machineIdByServerIdByAccountId
    : null;

  if (activeServerId && machineIdByServerId) {
    const activeMachineId = normalizeNonEmptyString(machineIdByServerId[activeServerId]);
    if (activeMachineId) return activeMachineId;
  }

  if (activeServerId && machineIdByServerIdByAccountId) {
    const activePerAccountMachineId = singleUniqueMachineId(
      collectMachineIds(machineIdByServerIdByAccountId[activeServerId]),
    );
    if (activePerAccountMachineId) return activePerAccountMachineId;
  }

  return singleUniqueMachineId([
    ...collectMachineIds(machineIdByServerId),
    ...collectPerAccountMachineIds(machineIdByServerIdByAccountId),
  ]);
}

async function readDaemonMachineIdFromCliSettings(cliHomeDir: string): Promise<string> {
  const settingsPath = join(cliHomeDir, 'settings.json');
  const raw = await readFile(settingsPath, 'utf8');
  const machineId = resolveMachineIdFromSettings(JSON.parse(raw) as unknown);
  if (machineId) return machineId;
  throw new Error(`CLI settings did not contain a resolvable daemon machine id: ${settingsPath}`);
}

export async function waitForDaemonMachineIdFromCliSettings(
  params: Readonly<{ cliHomeDir: string; timeoutMs?: number; pollIntervalMs?: number }>,
): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const pollIntervalMs = params.pollIntervalMs ?? 250;
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await readDaemonMachineIdFromCliSettings(params.cliHomeDir);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for daemon machine id in CLI settings after ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`,
  );
}
