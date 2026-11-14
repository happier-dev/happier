import type { FleetActivityFilter } from './useFleetActivityPage';

export type FleetActivityWhen = 'any' | 'today' | '7d' | '30d';
export const FLEET_ACTIVITY_WHEN: readonly FleetActivityWhen[] = [
  'any',
  'today',
  '7d',
  '30d',
];
const DAY_MS = 86_400_000;

/**
 * The read's window for a When choice, fixed when the person chooses it (a window that moved with the clock would
 * re-read on every render). Today starts at the local midnight; the others count back from the moment of choice.
 */
export function fleetActivityWhenRange(
  when: FleetActivityWhen,
  nowMs: number,
): Pick<FleetActivityFilter, 'requestedAtFromMs'> {
  switch (when) {
    case 'any':
      return {};
    case 'today': {
      const start = new Date(nowMs);
      start.setHours(0, 0, 0, 0);
      return { requestedAtFromMs: start.getTime() };
    }
    case '7d':
      return { requestedAtFromMs: nowMs - 7 * DAY_MS };
    case '30d':
      return { requestedAtFromMs: nowMs - 30 * DAY_MS };
  }
}
