import { describe, expect, it } from 'vitest';
import { PluginProjectNativeAdapterContributionV1Schema } from './projectNativeAdapters.js';

describe('Machine-native lifecycle declaration', () => {
    it('admits a root-free lifecycle without manufacturing a Project file', () => {
        expect(PluginProjectNativeAdapterContributionV1Schema.safeParse({ id: 'systemd', files: [], roles: ['nativeServiceLifecycle'] }).success).toBe(true);
    });

    it.each(['detect', 'resolveCommand', 'prepareToolchain'] as const)('retains file admission for the Project %s role', role => {
        expect(PluginProjectNativeAdapterContributionV1Schema.safeParse({ id: 'native', files: [], roles: ['nativeServiceLifecycle', role] }).success).toBe(false);
        expect(PluginProjectNativeAdapterContributionV1Schema.safeParse({ id: 'native', files: ['native.toml'], roles: [role] }).success).toBe(true);
    });
});
