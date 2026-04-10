import * as cliHappierRuntime from '@happier-dev/cli-common/happierRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { SupportWarning } from '../types.js';

export type SupportMaintenanceContext = Readonly<{
    preferredCliCommand: 'happier' | 'hprev' | 'hdev' | null;
    currentReleaseChannel: PublicReleaseRingId;
    installations?: cliHappierRuntime.HappierInstallationInventory;
    selectedInstallation?: cliHappierRuntime.HappierInstallation | null;
    services?: readonly cliHappierRuntime.HappierService[];
    warnings: readonly SupportWarning[];
}>;

const CLI_SHIM_PRIORITY = ['happier', 'hprev', 'hdev'] as const;

function resolvePreferredCliCommand(
    inventory: cliHappierRuntime.HappierInstallationInventory,
): SupportMaintenanceContext['preferredCliCommand'] {
    for (const shimName of CLI_SHIM_PRIORITY) {
        const match = inventory.installations.find((entry) =>
            entry.onPath
            && entry.components.includes('happier-cli')
            && entry.shimName === shimName,
        );
        if (match) {
            return shimName;
        }
    }
    return null;
}

function resolveCurrentReleaseChannel(
    preferredCliCommand: SupportMaintenanceContext['preferredCliCommand'],
): PublicReleaseRingId {
    if (preferredCliCommand === 'hprev') return 'preview';
    if (preferredCliCommand === 'hdev') return 'publicdev';
    return 'stable';
}

function mapWarning(entry: cliHappierRuntime.HappierRuntimeWarning): SupportWarning {
    return {
        code: entry.code,
        title: entry.message,
        severity: entry.severity,
        details: entry.repairCommands,
    };
}

export async function collectSupportMaintenanceContext(input: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    platform?: string;
}> = {}): Promise<SupportMaintenanceContext> {
    const processEnv = input.processEnv ?? process.env;
    const platform = String(input.platform ?? process.platform).trim() || process.platform;
    const installations = await cliHappierRuntime.discoverHappierInstallations({ processEnv });
    const services = await cliHappierRuntime.discoverHappierServices({
        processEnv,
        platform: platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : undefined,
    });
    const warnings = cliHappierRuntime.buildHappierRuntimeWarnings({ installations, services });
    const preferredCliCommand = resolvePreferredCliCommand(installations);
    return {
        preferredCliCommand,
        currentReleaseChannel: resolveCurrentReleaseChannel(preferredCliCommand),
        installations,
        selectedInstallation: cliHappierRuntime.resolvePreferredHappierCliInstallation({
            inventory: installations,
            preferredCliCommand,
        }),
        services: services.services,
        warnings: warnings.map(mapWarning),
    };
}
