import type { SystemdUnitStatus } from './serviceDiscoveryTypes.js';
import { parseKeyValueLines } from './_shared.js';

function parseIntOrNull(value: string | undefined): number | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function readSystemdUnitStatus(params: Readonly<{
  output: string;
}>): SystemdUnitStatus {
  const raw = parseKeyValueLines(params.output);

  return {
    loadState: raw.LoadState ?? null,
    activeState: raw.ActiveState ?? null,
    subState: raw.SubState ?? null,
    result: raw.Result ?? null,
    execMainStatus: parseIntOrNull(raw.ExecMainStatus),
    nRestarts: parseIntOrNull(raw.NRestarts),
    unitFileState: raw.UnitFileState ?? null,
    fragmentPath: raw.FragmentPath ?? null,
    mainPid: parseIntOrNull(raw.MainPID),
  };
}
