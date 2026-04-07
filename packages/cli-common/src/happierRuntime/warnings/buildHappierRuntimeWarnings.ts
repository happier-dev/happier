import type { HappierInstallationInventory, HappierRuntimeWarning, HappierServiceInventory } from '../types.js';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '../runtimePathMatching.js';
import { buildRepairCommandsForHappierRuntimeWarning } from './buildRepairCommandsForHappierRuntimeWarning.js';

type DaemonStatusForWarnings = Readonly<{
  daemon: Readonly<{
    startedWithCliVersion?: string | null;
  }>;
}>;

function buildPathConflictWarnings(installations: HappierInstallationInventory): HappierRuntimeWarning[] {
  const onPathCliInstallations = installations.installations.filter((entry) => entry.onPath && entry.components.includes('happier-cli'));
  if (onPathCliInstallations.length <= 1) {
    return [];
  }
  return [{
    code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
    severity: 'warning',
    message: 'Multiple Happier CLI installations were detected on PATH.',
    repairCommands: buildRepairCommandsForHappierRuntimeWarning('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH'),
  }];
}

function buildDaemonVersionWarnings(params: Readonly<{
  installations: HappierInstallationInventory;
  daemonStatus?: DaemonStatusForWarnings;
}>): HappierRuntimeWarning[] {
  const startedVersion = params.daemonStatus?.daemon.startedWithCliVersion?.trim();
  const activeVersion = params.installations.activeInvocation?.version?.trim();
  if (!startedVersion || !activeVersion || startedVersion === activeVersion) {
    return [];
  }
  return [{
    code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
    severity: 'warning',
    message: 'The running daemon was started with a different CLI version than the current invocation.',
    repairCommands: buildRepairCommandsForHappierRuntimeWarning('DAEMON_STARTED_WITH_DIFFERENT_CLI'),
  }];
}

function buildServiceTupleWarnings(services: HappierServiceInventory): HappierRuntimeWarning[] {
  const verifiedDaemons = services.services.filter((entry) => entry.serviceType === 'daemon' && entry.verification === 'verified');
  const countsByTuple = new Map<string, number>();
  for (const service of verifiedDaemons) {
    const tupleKey = [
      service.platform,
      service.backend,
      service.ring ?? 'stable',
      service.instanceId ?? 'cloud',
    ].join(':');
    countsByTuple.set(tupleKey, (countsByTuple.get(tupleKey) ?? 0) + 1);
  }
  if (![...countsByTuple.values()].some((count) => count > 1)) {
    return [];
  }
  return [{
    code: 'DUPLICATE_SERVICE_TUPLE',
    severity: 'warning',
    message: 'Multiple verified Happier daemon services map to the same service tuple.',
    repairCommands: buildRepairCommandsForHappierRuntimeWarning('DUPLICATE_SERVICE_TUPLE'),
  }];
}

function buildOrphanServiceWarnings(params: Readonly<{
  installations: HappierInstallationInventory;
  services: HappierServiceInventory;
}>): HappierRuntimeWarning[] {
  const installationRoots = params.installations.installations
    .filter((entry) => entry.components.includes('happier-cli') || entry.components.includes('happier-daemon'))
    .flatMap((entry) => [entry.path, entry.realPath].map(normalizeHappierRuntimePath).filter(Boolean));
  const hasOrphan = params.services.services.some((service) => {
    if (service.serviceType !== 'daemon' || service.verification !== 'verified') return false;
    const executablePath = normalizeHappierRuntimePath(service.executablePath);
    if (!executablePath) return false;
    return !installationRoots.some((root) => isHappierRuntimePathWithinRoot(executablePath, root));
  });
  if (!hasOrphan) {
    return [];
  }
  return [{
    code: 'ORPHAN_DAEMON_SERVICE',
    severity: 'warning',
    message: 'A verified Happier daemon service points to an executable outside the detected Happier installations.',
    repairCommands: buildRepairCommandsForHappierRuntimeWarning('ORPHAN_DAEMON_SERVICE'),
  }];
}

export function buildHappierRuntimeWarnings(params: Readonly<{
  installations: HappierInstallationInventory;
  services: HappierServiceInventory;
  daemonStatus?: DaemonStatusForWarnings;
}>): HappierRuntimeWarning[] {
  return [
    ...buildPathConflictWarnings(params.installations),
    ...buildDaemonVersionWarnings({
      installations: params.installations,
      daemonStatus: params.daemonStatus,
    }),
    ...buildServiceTupleWarnings(params.services),
    ...buildOrphanServiceWarnings({
      installations: params.installations,
      services: params.services,
    }),
  ];
}
