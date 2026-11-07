import type { DemoWorld } from '../world/buildDemoWorld';
import { getDemoModeServerId, isSeededDemoHome } from './enterExitDemoMode';
import { resolveHomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import type { ServerSettingsController } from '@/components/settings/server/hooks/useServerSettingsScreenController';

let secretMetadata: DemoWorld['savedSecretMetadata'] | null = null;
export function setDemoSettingsReadProjection(world: DemoWorld | null): void {
    secretMetadata = world?.savedSecretMetadata ?? null;
}
export function getDemoSavedSecretMetadata() {
    return getDemoModeServerId() ? secretMetadata : null;
}

/** The local demo's Homes collection has one healthy Home, never the capture browser's bootstrap relay. */
export function projectDemoHomesController(controller: ServerSettingsController): ServerSettingsController {
    const serverId = getDemoModeServerId();
    if (!serverId) return controller;
    return { ...controller, servers: controller.servers.filter(profile => isSeededDemoHome(profile.id)),
        serverGroups: [], homeConnectionSummaryByServerId: {
            [serverId]: resolveHomeConnectionSummary({ healthKind: 'healthy' }),
        } };
}
