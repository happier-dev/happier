import type { SystemdUnitStatus } from './serviceDiscoveryTypes.js';
import { parseKeyValueLines } from './_shared.js';

function parseIntOrNull(value: string | undefined): number | null {
  const parsed = Number(String(value ?? '').trim());
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
    unitFileState: raw.UnitFileState ?? null,
    fragmentPath: raw.FragmentPath ?? null,
    mainPid: parseIntOrNull(raw.MainPID),
  };
}
