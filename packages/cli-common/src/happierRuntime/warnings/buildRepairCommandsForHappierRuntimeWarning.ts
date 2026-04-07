import type { HappierRuntimeWarning } from '../types.js';

export function buildRepairCommandsForHappierRuntimeWarning(code: HappierRuntimeWarning['code']): string[] {
  if (code === 'DAEMON_STARTED_WITH_DIFFERENT_CLI') {
    return ['happier doctor repair --yes', 'happier daemon restart'];
  }
  if (code === 'ORPHAN_DAEMON_SERVICE') {
    return ['happier doctor repair --yes', 'happier daemon service list --json'];
  }
  if (code === 'DUPLICATE_SERVICE_TUPLE') {
    return ['happier doctor repair --dry-run', 'happier daemon service list --json'];
  }
  if (code === 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH') {
    return ['happier doctor repair --dry-run', 'happier doctor --json'];
  }
  return [];
}
