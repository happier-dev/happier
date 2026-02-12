import { gitScmBackendSettingsPlugin } from '@/scm/backends/git/settingsPlugin';
import { saplingScmBackendSettingsPlugin } from '@/scm/backends/sapling/settingsPlugin';
import type { ScmBackendSettingsPlugin } from '@/scm/settings/scmBackendSettingsPlugin';

const scmBackendSettingsPlugins: readonly ScmBackendSettingsPlugin[] = [
    gitScmBackendSettingsPlugin,
    saplingScmBackendSettingsPlugin,
];

function buildPluginMap() {
    const map = new Map<string, ScmBackendSettingsPlugin>();
    for (const plugin of scmBackendSettingsPlugins) {
        if (map.has(plugin.backendId)) {
            throw new Error(`Duplicate SCM backend settings plugin id: ${plugin.backendId}`);
        }
        map.set(plugin.backendId, plugin);
    }
    return map;
}

const scmBackendSettingsPluginMap = buildPluginMap();

export const scmBackendSettingsRegistry = {
    listPlugins(): readonly ScmBackendSettingsPlugin[] {
        return scmBackendSettingsPlugins;
    },
    getPlugin(backendId: string | null | undefined): ScmBackendSettingsPlugin | null {
        if (!backendId) return null;
        return scmBackendSettingsPluginMap.get(backendId) ?? null;
    },
    assertRegistryValid(): void {
        void buildPluginMap();
    },
};
