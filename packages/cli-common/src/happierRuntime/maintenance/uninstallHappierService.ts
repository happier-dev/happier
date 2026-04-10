import { unlink } from 'node:fs/promises';

import { applyServicePlan, planServiceAction, type ServiceBackend } from '../../service/index.js';
import type { HappierServiceBackend, HappierServicePlatform } from '../types.js';

function resolveServiceManagerBackend(params: Readonly<{
    backend: HappierServiceBackend;
    scope: 'user' | 'system';
}>): ServiceBackend {
    if (params.backend === 'launchd') {
        return params.scope === 'system' ? 'launchd-system' : 'launchd-user';
    }
    if (
        params.backend === 'systemd-user'
        || params.backend === 'systemd-system'
        || params.backend === 'schtasks-user'
        || params.backend === 'schtasks-system'
    ) {
        return params.backend;
    }
    throw new Error(`Unsupported Happier service backend for uninstall: ${params.backend}`);
}

export async function uninstallHappierService(params: Readonly<{
    platform: HappierServicePlatform;
    backend: HappierServiceBackend;
    scope: 'user' | 'system';
    label: string;
    definitionPath: string;
    runCommands?: boolean;
}>): Promise<void> {
    const servicePlan = planServiceAction({
        backend: resolveServiceManagerBackend({
            backend: params.backend,
            scope: params.scope,
        }),
        action: 'uninstall',
        label: params.label,
        definitionPath: params.definitionPath,
        persistent: true,
    });

    await applyServicePlan(servicePlan, { runCommands: params.runCommands });

    try {
        await unlink(params.definitionPath);
    } catch {
        // ignore
    }
}
