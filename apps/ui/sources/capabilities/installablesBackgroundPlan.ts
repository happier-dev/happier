import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { InstallableDefaultPolicy, InstallableDepDataLike, InstallableRegistryEntry } from './installablesRegistry';
import { isInstallableDepUpdateAvailable } from './installablesUpdateAvailable';

export type InstallablesBackgroundAction = Readonly<{
    installableKey: string;
    request: CapabilitiesInvokeRequest;
}>;

export function planInstallablesBackgroundActions(params: {
    installables: ReadonlyArray<Readonly<{
        entry: InstallableRegistryEntry;
        status: InstallableDepDataLike | null;
        policy: InstallableDefaultPolicy;
        installSpec: string | null;
    }>>;
}): InstallablesBackgroundAction[] {
    const actions: InstallablesBackgroundAction[] = [];

    for (const item of params.installables) {
        if (item.entry.kind !== 'dep') continue;
        if (!item.status) continue;

        const installSpec = typeof item.installSpec === 'string' ? item.installSpec.trim() : '';
        const paramsObj = installSpec.length > 0 ? { installSpec } : undefined;

        if (item.status.installed !== true) {
            if (item.policy.autoInstallWhenNeeded !== true) continue;
            actions.push({
                installableKey: item.entry.key,
                request: { id: item.entry.capabilityId, method: 'install', ...(paramsObj ? { params: paramsObj } : {}) },
            });
            continue;
        }

        const updateAvailable = isInstallableDepUpdateAvailable(item.status);
        if (!updateAvailable) continue;
        if (item.policy.autoUpdateMode !== 'auto') continue;

        actions.push({
            installableKey: item.entry.key,
            request: { id: item.entry.capabilityId, method: 'upgrade', ...(paramsObj ? { params: paramsObj } : {}) },
        });
    }

    return actions;
}

