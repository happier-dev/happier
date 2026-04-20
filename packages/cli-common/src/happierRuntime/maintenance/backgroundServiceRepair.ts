import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolvePublicReleaseRingIdForLabel } from '@happier-dev/release-runtime/releaseRings';

import type { HappierService, HappierServiceBackend, HappierServicePlatform, HappierServiceTargetMode } from '../types.js';

export type BackgroundServiceRepairMode = 'user' | 'system';

export type BackgroundServiceRepairAction =
    | Readonly<{
        kind: 'remove-service';
        service: Readonly<{
            id: string;
            label: string;
            platform: HappierServicePlatform;
            backend: HappierServiceBackend;
            scope: BackgroundServiceRepairMode;
            releaseChannel: PublicReleaseRingId;
            targetMode: HappierServiceTargetMode;
            instanceId: string;
            definitionPath: string;
        }>;
    }>
    | Readonly<{
        kind: 'install-default-following-service';
        releaseChannel: PublicReleaseRingId;
        mode: BackgroundServiceRepairMode;
    }>;

export type BackgroundServiceRepairPlan = Readonly<{
    currentReleaseChannel: PublicReleaseRingId;
    existingServices: readonly HappierService[];
    actions: readonly BackgroundServiceRepairAction[];
    manualWarnings: readonly string[];
}>;

function normalizeServiceReleaseChannel(service: HappierService): PublicReleaseRingId | null {
    return service.ring ? resolvePublicReleaseRingIdForLabel(service.ring) : null;
}

function toRepairableDaemonServices(services: readonly HappierService[]): HappierService[] {
    return services.filter((service) => (
        service.serviceType === 'daemon'
        && service.verification === 'verified'
        && (service.scope === 'user' || service.scope === 'system')
        && (service.platform === 'darwin' || service.platform === 'linux' || service.platform === 'win32')
        && typeof service.instanceId === 'string'
        && service.instanceId.trim().length > 0
        && typeof service.definitionPath === 'string'
        && service.definitionPath.trim().length > 0
        && typeof service.targetMode === 'string'
    ));
}

function isCompatibleDefaultService(params: Readonly<{
    service: HappierService;
    currentReleaseChannel: PublicReleaseRingId;
}>): boolean {
    return params.service.targetMode === 'default-following'
        && normalizeServiceReleaseChannel(params.service) === params.currentReleaseChannel;
}

export function buildBackgroundServiceRepairPlan(params: Readonly<{
    currentReleaseChannel: PublicReleaseRingId;
    preferredMode: BackgroundServiceRepairMode;
    services: readonly HappierService[];
}>): BackgroundServiceRepairPlan {
    const repairableServices = toRepairableDaemonServices(params.services);
    const missingHomeServices = repairableServices.filter((service) => (
        service.targetMode === 'default-following'
        && !service.happierHomeDir
    ));
    if (missingHomeServices.length > 0) {
        return {
            currentReleaseChannel: params.currentReleaseChannel,
            existingServices: repairableServices,
            actions: [],
            manualWarnings: [
                `Detected default-following background services with missing Happier home metadata (${missingHomeServices.map((service) => service.definitionPath).filter(Boolean).join(', ') || 'unknown path'}). Automatic repair will not replace or remove them; remove the legacy service(s) from the owning installation first.`,
            ],
        };
    }

    const compatibleDefaultServices = repairableServices.filter((service) => isCompatibleDefaultService({
        service,
        currentReleaseChannel: params.currentReleaseChannel,
    }));
    const compatibleDefaultService = compatibleDefaultServices.find((service) => service.scope === params.preferredMode)
        ?? compatibleDefaultServices[0]
        ?? null;

    const actions: BackgroundServiceRepairAction[] = [];
    const removableServices = compatibleDefaultService
        ? repairableServices.filter((service) => service.id !== compatibleDefaultService.id)
        : [...repairableServices];

    for (const service of removableServices) {
        const releaseChannel = normalizeServiceReleaseChannel(service);
        if (!releaseChannel || !service.targetMode || !service.instanceId) {
            continue;
        }
        actions.push({
            kind: 'remove-service',
            service: {
                id: service.id,
                label: service.label,
                platform: service.platform,
                backend: service.backend,
                scope: service.scope,
                releaseChannel,
                targetMode: service.targetMode,
                instanceId: service.instanceId,
                definitionPath: service.definitionPath,
            },
        });
    }

    if (!compatibleDefaultService && repairableServices.length > 0) {
        actions.push({
            kind: 'install-default-following-service',
            releaseChannel: params.currentReleaseChannel,
            mode: params.preferredMode,
        });
    }

    return {
        currentReleaseChannel: params.currentReleaseChannel,
        existingServices: repairableServices,
        actions,
        manualWarnings: [],
    };
}
