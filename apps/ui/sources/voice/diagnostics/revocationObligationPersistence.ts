import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import {
  serverAccountScopedStorageKey,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

const STORAGE_KEY_PREFIX = 'voice-diagnostics-machine-revocations-v1';
const MAX_MACHINE_ID_LENGTH = 1024;
const MAX_OBLIGATIONS = 64;

function storageKey(scope: ServerAccountScope): string {
  return serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope);
}

function normalizeMachineId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_MACHINE_ID_LENGTH) return null;
  return normalized;
}

function parseMachineIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || !Array.isArray(record.machineIds)) return [];
    const machineIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of record.machineIds) {
      const machineId = normalizeMachineId(candidate);
      if (!machineId || seen.has(machineId)) continue;
      seen.add(machineId);
      machineIds.push(machineId);
      if (machineIds.length >= MAX_OBLIGATIONS) break;
    }
    return machineIds;
  } catch {
    return [];
  }
}

function writeMachineIds(scope: ServerAccountScope, machineIds: readonly string[]): void {
  const storage = getPersistenceStorage();
  const key = storageKey(scope);
  if (machineIds.length === 0) {
    storage.delete(key);
    return;
  }
  storage.set(key, JSON.stringify({ v: 1, machineIds }));
}

export function readPersistedVoiceDiagnosticsMachineRevocations(
  scope: ServerAccountScope,
): readonly string[] {
  return parseMachineIds(getPersistenceStorage().getString(storageKey(scope)));
}

export function addPersistedVoiceDiagnosticsMachineRevocation(
  scope: ServerAccountScope,
  rawMachineId: string,
): void {
  const machineId = normalizeMachineId(rawMachineId);
  if (!machineId) return;
  const current = readPersistedVoiceDiagnosticsMachineRevocations(scope);
  if (current.includes(machineId)) return;
  writeMachineIds(scope, [...current, machineId].slice(-MAX_OBLIGATIONS));
}

export function clearPersistedVoiceDiagnosticsMachineRevocation(
  scope: ServerAccountScope,
  rawMachineId: string,
): void {
  const machineId = normalizeMachineId(rawMachineId);
  if (!machineId) return;
  const current = readPersistedVoiceDiagnosticsMachineRevocations(scope);
  const next = current.filter((candidate) => candidate !== machineId);
  if (next.length === current.length) return;
  writeMachineIds(scope, next);
}
