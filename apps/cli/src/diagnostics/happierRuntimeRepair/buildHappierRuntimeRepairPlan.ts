import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '@happier-dev/cli-common/happierRuntime';
import type { HappierServiceBackend } from '@happier-dev/cli-common/happierRuntime';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import type { HappierRuntimeRepairAction, HappierRuntimeRepairPlan } from './types';

type RepairableService = Readonly<{
    id: string;
    label: string;
    platform: 'darwin' | 'linux' | 'win32';
    backend: HappierServiceBackend;
    scope: 'user' | 'system';
    targetMode: 'pinned' | 'default-following';
    ring: PublicReleaseRingLabel | null;
    instanceId: string | null;
    definitionPath: string;
    executablePath: string | null;
    serverUrl: string | null;
    running: boolean;
}>;

function normalizeComparableUrl(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.replace(/\/+$/u, '').toLowerCase();
}

function buildUninstallDaemonServicesCommand(params: Readonly<{
    services: readonly RepairableService[];
}>): string {
    if (params.services.length !== 1) {
        return 'happier service repair --yes';
    }

    const [service] = params.services;
    if (!service || service.targetMode !== 'pinned' || !service.ring || !service.instanceId) {
        return 'happier service repair --yes';
    }

    return `happier service uninstall --ring ${service.ring} --instance ${service.instanceId} --yes`;
}

function normalizeRepairableServices(snapshot: DoctorSnapshot): RepairableService[] {
    const services = snapshot.services?.happier?.services ?? [];
    return services
        .filter((service): service is typeof service & {
            platform: 'darwin' | 'linux' | 'win32';
            scope: 'user' | 'system';
            publicServerUrl?: string | null;
            serverUrl?: string | null;
        } => (
            service.serviceType === 'daemon'
            && service.verification === 'verified'
            && (service.platform === 'darwin' || service.platform === 'linux' || service.platform === 'win32')
            && (service.scope === 'user' || service.scope === 'system')
        ))
        .map((service) => {
            const normalizedTargetMode = service.targetMode === 'default-following' ? 'default-following' : 'pinned';
            return {
                id: service.id,
                label: service.label,
                platform: service.platform,
                backend: service.backend,
                scope: service.scope,
                targetMode: normalizedTargetMode,
                ring: normalizedTargetMode === 'default-following' ? null : (service.ring ?? null),
                instanceId: normalizedTargetMode === 'default-following' ? null : (service.instanceId ?? null),
                definitionPath: service.definitionPath,
                executablePath: service.executablePath ?? null,
                serverUrl: normalizeComparableUrl(service.publicServerUrl ?? service.serverUrl),
                running: service.running === true,
            };
        });
}

function collectInstallationRoots(snapshot: DoctorSnapshot): string[] {
    const installations = snapshot.installations?.happier?.installations ?? [];
    return installations
        .filter((entry) => entry.components.includes('happier-cli') || entry.components.includes('happier-daemon'))
        .flatMap((entry) => [entry.path, entry.realPath].map(normalizeHappierRuntimePath).filter(Boolean));
}

function collectOrphanServices(params: Readonly<{
    services: readonly RepairableService[];
    installationRoots: readonly string[];
}>): RepairableService[] {
    return params.services.filter((service) => {
        const executablePath = normalizeHappierRuntimePath(service.executablePath);
        if (!executablePath) {
            return false;
        }
        return !params.installationRoots.some((root) => isHappierRuntimePathWithinRoot(executablePath, root));
    });
}

function preferServiceToKeep(params: Readonly<{
    services: readonly RepairableService[];
    activeInvocationRealPath: string | null;
}>): RepairableService | null {
    const ranked = [...params.services].sort((left, right) => {
        if (left.running !== right.running) {
            return left.running ? -1 : 1;
        }

        const leftMatchesActive = params.activeInvocationRealPath != null
            && normalizeHappierRuntimePath(left.executablePath) === params.activeInvocationRealPath;
        const rightMatchesActive = params.activeInvocationRealPath != null
            && normalizeHappierRuntimePath(right.executablePath) === params.activeInvocationRealPath;
        if (leftMatchesActive !== rightMatchesActive) {
            return leftMatchesActive ? -1 : 1;
        }

        return left.label.localeCompare(right.label);
    });
    return ranked[0] ?? null;
}

export function buildHappierRuntimeRepairPlan(snapshot: DoctorSnapshot): HappierRuntimeRepairPlan {
    const actions: HappierRuntimeRepairAction[] = [];
    const warnings = snapshot.warnings ?? [];
    const services = normalizeRepairableServices(snapshot);
    const activeInvocationRealPath = normalizeHappierRuntimePath(snapshot.installations?.happier?.activeInvocation?.realPath ?? null);
    const currentServerUrl = normalizeComparableUrl(snapshot.server?.publicServerUrl ?? snapshot.server?.serverUrl ?? null);

    const daemonStartedWithVersion = String(snapshot.daemonStatus?.daemon?.startedWithCliVersion ?? '').trim();
    const activeVersion = String(snapshot.installations?.happier?.activeInvocation?.version ?? '').trim();
    if (daemonStartedWithVersion && activeVersion && daemonStartedWithVersion !== activeVersion) {
        actions.push({
            kind: 'restart-daemon',
            command: 'happier daemon restart',
        });
    }

    const removableServices = new Map<string, RepairableService>();
    const addRemovableServices = (entries: readonly RepairableService[]) => {
        for (const service of entries) {
            removableServices.set(service.id, service);
        }
    };

    addRemovableServices(collectOrphanServices({
        services,
        installationRoots: collectInstallationRoots(snapshot),
    }));

    const defaultFollowingServices = services.filter((service) => service.targetMode === 'default-following');
    if (defaultFollowingServices.length > 1) {
        const preferredDefaultService = preferServiceToKeep({
            services: defaultFollowingServices,
            activeInvocationRealPath,
        });
        if (preferredDefaultService) {
            removableServices.delete(preferredDefaultService.id);
        }
        addRemovableServices(defaultFollowingServices.filter((service) => service.id !== preferredDefaultService?.id));
    }

    const pinnedServices = services.filter((service) => service.targetMode === 'pinned');
    if (defaultFollowingServices.length === 0 && currentServerUrl) {
        const currentServerPinnedServices = pinnedServices.filter((service) => service.serverUrl === currentServerUrl);
        if (currentServerPinnedServices.length === 1) {
            const [legacyPinnedService] = currentServerPinnedServices;
            actions.push({
                kind: 'install-default-following-service',
                command: 'happier service install --yes',
                mode: legacyPinnedService.scope,
                targetServerUrl: currentServerUrl,
            });
            addRemovableServices([legacyPinnedService]);
        }
    }

    const removableServiceList = [...removableServices.values()];
    if (removableServiceList.length > 0) {
        const reason = removableServiceList.some((service) => service.targetMode === 'default-following')
            ? 'duplicate-default-following'
            : actions.some((action) => action.kind === 'install-default-following-service')
                ? 'legacy-pinned-migration'
                : 'orphan';
        actions.push({
            kind: 'uninstall-daemon-services',
            command: buildUninstallDaemonServicesCommand({ services: removableServiceList }),
            reason,
            services: removableServiceList.map((service) => ({
                id: service.id,
                label: service.label,
                platform: service.platform,
                backend: service.backend,
                scope: service.scope,
                targetMode: service.targetMode,
                ring: service.ring,
                instanceId: service.instanceId,
                definitionPath: service.definitionPath,
                serverUrl: service.serverUrl,
            })),
        });
    }

    const automaticallyHandledWarningCodes = new Set([
        'DAEMON_STARTED_WITH_DIFFERENT_CLI',
        'ORPHAN_DAEMON_SERVICE',
        'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
        'LEGACY_PINNED_DAEMON_SERVICE',
    ]);

    return {
        actions,
        manualWarnings: warnings.filter((warning) => !automaticallyHandledWarningCodes.has(warning.code)),
    };
}
