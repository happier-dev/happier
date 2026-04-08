import type { HappierInstallationInventory, HappierRuntimeWarning, HappierService, HappierServiceInventory } from '../types.js';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '../runtimePathMatching.js';
import { buildRepairCommandsForHappierRuntimeWarning } from './buildRepairCommandsForHappierRuntimeWarning.js';

type DaemonStatusForWarnings = Readonly<{
    daemon: Readonly<{
        startedWithCliVersion?: string | null;
    }>;
}>;

function normalizeComparableUrl(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.replace(/\/+$/u, '').toLowerCase();
}

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

function getVerifiedDaemonServices(services: HappierServiceInventory): HappierService[] {
    return services.services.filter((entry) => entry.serviceType === 'daemon' && entry.verification === 'verified');
}

function buildDefaultFollowingDuplicateWarnings(services: HappierServiceInventory): HappierRuntimeWarning[] {
    const defaultFollowingServices = getVerifiedDaemonServices(services)
        .filter((service) => service.targetMode === 'default-following');
    if (defaultFollowingServices.length <= 1) {
        return [];
    }
    return [{
        code: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
        severity: 'warning',
        message: 'Multiple verified default-following Happier background services were detected.',
        repairCommands: buildRepairCommandsForHappierRuntimeWarning('DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE'),
    }];
}

function buildPinnedConflictWarnings(services: HappierServiceInventory): HappierRuntimeWarning[] {
    const pinnedServices = getVerifiedDaemonServices(services).filter((service) => service.targetMode !== 'default-following');
    const servicesByServer = new Map<string, HappierService[]>();
    for (const service of pinnedServices) {
        const serverUrl = normalizeComparableUrl(service.publicServerUrl ?? service.serverUrl);
        if (!serverUrl) {
            continue;
        }
        servicesByServer.set(serverUrl, [...(servicesByServer.get(serverUrl) ?? []), service]);
    }

    const warnings: HappierRuntimeWarning[] = [];
    if ([...servicesByServer.values()].some((entries) => entries.length > 1)) {
        warnings.push({
            code: 'CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER',
            severity: 'warning',
            message: 'Multiple verified pinned Happier background services target the same server.',
            repairCommands: buildRepairCommandsForHappierRuntimeWarning('CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER'),
        });
    }
    if (pinnedServices.length > 0) {
        warnings.push({
            code: 'LEGACY_PINNED_DAEMON_SERVICE',
            severity: 'warning',
            message: 'Pinned Happier background services were detected and may need migration to the default-following model.',
            repairCommands: buildRepairCommandsForHappierRuntimeWarning('LEGACY_PINNED_DAEMON_SERVICE'),
        });
    }
    return warnings;
}

function buildPinnedAndDefaultConflictWarnings(services: HappierServiceInventory): HappierRuntimeWarning[] {
    const verifiedDaemons = getVerifiedDaemonServices(services);
    const hasDefaultFollowing = verifiedDaemons.some((service) => service.targetMode === 'default-following');
    const hasPinned = verifiedDaemons.some((service) => service.targetMode !== 'default-following');
    if (!hasDefaultFollowing || !hasPinned) {
        return [];
    }
    return [{
        code: 'DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT',
        severity: 'warning',
        message: 'Pinned and default-following Happier background services are both installed.',
        repairCommands: buildRepairCommandsForHappierRuntimeWarning('DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT'),
    }];
}

function buildOrphanServiceWarnings(params: Readonly<{
    installations: HappierInstallationInventory;
    services: HappierServiceInventory;
}>): HappierRuntimeWarning[] {
    const installationRoots = params.installations.installations
        .filter((entry) => entry.components.includes('happier-cli') || entry.components.includes('happier-daemon'))
        .flatMap((entry) => [entry.path, entry.realPath].map(normalizeHappierRuntimePath).filter(Boolean));
    const hasOrphan = getVerifiedDaemonServices(params.services).some((service) => {
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
        ...buildDefaultFollowingDuplicateWarnings(params.services),
        ...buildPinnedConflictWarnings(params.services),
        ...buildPinnedAndDefaultConflictWarnings(params.services),
        ...buildOrphanServiceWarnings({
            installations: params.installations,
            services: params.services,
        }),
    ];
}
