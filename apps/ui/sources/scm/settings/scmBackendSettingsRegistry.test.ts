import { describe, expect, it } from 'vitest';
import { scmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';

describe('scmBackendSettingsRegistry', () => {
    it('registers git and sapling backend settings plugins', () => {
        const plugins = scmBackendSettingsRegistry.listPlugins();
        expect(plugins.map((plugin) => plugin.backendId).sort()).toEqual(['git', 'sapling']);
    });

    it('returns plugin by backend id', () => {
        expect(scmBackendSettingsRegistry.getPlugin('git')?.title).toBe('Git');
        expect(scmBackendSettingsRegistry.getPlugin('sapling')?.title).toBe('Sapling');
        expect(scmBackendSettingsRegistry.getPlugin('unknown')).toBeNull();
    });

    it('validates plugin registry uniqueness', () => {
        expect(() => scmBackendSettingsRegistry.assertRegistryValid()).not.toThrow();
    });
});
