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
    }>>;
}): InstallablesBackgroundAction[] {
    const actions: InstallablesBackgroundAction[] = [];

    for (const item of params.installables) {
        if (item.entry.kind !== 'dep') continue;
        if (!item.status) continue;

        if (item.status.installed !== true) {
            if (item.policy.autoInstallWhenNeeded !== true) continue;
            actions.push({
                installableKey: item.entry.key,
                request: { id: item.entry.capabilityId, method: 'install' },
            });
            continue;
        }

        const updateAvailable = isInstallableDepUpdateAvailable(item.status);
        if (!updateAvailable) continue;
        if (item.policy.autoUpdateMode !== 'auto') continue;

        actions.push({
            installableKey: item.entry.key,
            request: { id: item.entry.capabilityId, method: 'upgrade' },
        });
    }

    return actions;
}
