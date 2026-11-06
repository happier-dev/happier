import { projectAccountManagedProvisioners, type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import { createPluginAccountBundledSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { StoredCredentials } from '@/persistence';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';

export async function readCliManagedProvisioners(pluginId: string,
    account: Readonly<{ credentials?: StoredCredentials | null; serverUrl: string }>, signal?: AbortSignal): Promise<readonly ManagedProvisionerDiscoveryEntry[] | null> {
    if (!account.credentials) return null;
    try {
        const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] }).loadedPlugins
            .find(plugin => plugin.pluginId === pluginId);
        const bundled = declaration ? createPluginAccountBundledSelectionV1({
            packageName: declaration.sourceSpec.locator, manifest: declaration.manifest,
        }) : undefined;
        const selection = await readCurrentAccountPluginExecutionSelection({ pluginId,
            credentials: account.credentials, serverUrl: account.serverUrl,
            ...(bundled ? { bundled } : {}), ...(signal ? { signal } : {}),
        });
        return selection.kind !== 'available' ? null : projectAccountManagedProvisioners([selection]);
    } catch {
        return null;
    }
}
