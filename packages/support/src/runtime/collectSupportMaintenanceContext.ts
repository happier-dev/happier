import { happierRuntime as cliHappierRuntime } from '@happier-dev/cli-common';

import type { SupportWarning } from '../types.js';

export type SupportMaintenanceContext = Readonly<{
    preferredCliCommand: 'happier' | 'hprev' | 'hdev' | null;
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
    return {
        preferredCliCommand: resolvePreferredCliCommand(installations),
        warnings: warnings.map(mapWarning),
    };
}
