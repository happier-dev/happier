import type { HappierRuntimeWarning } from '../types.js';

export function buildRepairCommandsForHappierRuntimeWarning(code: HappierRuntimeWarning['code']): string[] {
  if (code === 'DAEMON_STARTED_WITH_DIFFERENT_CLI') {
    return ['happier service repair --yes', 'happier daemon restart'];
  }
  if (code === 'ORPHAN_DAEMON_SERVICE') {
    return ['happier service repair --yes', 'happier service list --json'];
  }
  if (
    code === 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE'
    || code === 'CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER'
    || code === 'DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT'
    || code === 'LEGACY_PINNED_DAEMON_SERVICE'
  ) {
    return ['happier service repair --dry-run', 'happier service list --json'];
  }
  if (code === 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH') {
    return ['happier service repair --dry-run', 'happier doctor --json'];
  }
  return [];
}
