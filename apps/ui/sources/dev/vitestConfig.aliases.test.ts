import { describe, expect, it } from 'vitest';

describe('vitest config aliases', () => {
    it('stubs expo-modules-core subpaths to avoid loading Expo TS sources in node tests', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            resolve?: { alias?: Array<{ find: unknown; replacement: string }> };
            plugins?: Array<{ name?: string }>;
        };
        const aliasEntries = Array.isArray(config.resolve?.alias)
            ? config.resolve.alias
            : [];

        const expoModulesCoreAlias = aliasEntries.find((entry) => {
            if (!(entry.find instanceof RegExp)) return false;
            return entry.find.test('expo-modules-core/src/index.ts');
        });

        expect(expoModulesCoreAlias, 'expected expo-modules-core alias to match subpaths').toBeTruthy();
        expect(expoModulesCoreAlias?.replacement).toContain('expoModulesCoreStub.ts');

        const plugins = Array.isArray(config.plugins)
            ? config.plugins
            : [];
        expect(plugins.some((plugin) => plugin.name === 'happier-vitest-expo-node-module-stubs')).toBe(true);
    });
});
