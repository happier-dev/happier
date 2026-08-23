import { HappierTransportError } from './errors.js';

export type HappierMachine = Readonly<{
  id: string;
  active: boolean;
  revokedAt: number | null;
  replacedByMachineId: string | null;
}>;

export type MachineListOptions = Readonly<{
  signal?: AbortSignal;
}>;

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export function parseMachineListResponse(value: unknown): readonly HappierMachine[] {
  if (!Array.isArray(value)) {
    throw new HappierTransportError('The Happier machine API returned an invalid response.');
  }
  return Object.freeze(value.map((row) => {
    if (row === null || typeof row !== 'object') {
      throw new HappierTransportError('The Happier machine API returned an invalid response.');
    }
    const candidate = row as Record<string, unknown>;
    if (
      !isNonEmptyId(candidate.id)
      || typeof candidate.active !== 'boolean'
      || !isNullableTimestamp(candidate.revokedAt)
      || !(candidate.replacedByMachineId === null || isNonEmptyId(candidate.replacedByMachineId))
    ) {
      throw new HappierTransportError('The Happier machine API returned an invalid response.');
    }
    return Object.freeze({
      id: candidate.id,
      active: candidate.active,
      revokedAt: candidate.revokedAt,
      replacedByMachineId: candidate.replacedByMachineId,
    });
  }));
}
