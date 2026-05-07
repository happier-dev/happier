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

    it('resolves workspace agent imports to source files so vitest does not load stale dist exports', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            plugins?: Array<{ name?: string; resolveId?: (id: string) => string | null | undefined }>;
        };
        const plugins = Array.isArray(config.plugins)
            ? config.plugins
            : [];
        const resolver = plugins.find((plugin) => plugin.name === 'happier-vitest-expo-node-module-stubs');

        expect(resolver?.resolveId?.('@happier-dev/agents')).toContain('/packages/agents/src/index.ts');
        expect(resolver?.resolveId?.('@happier-dev/agents/permissions')).toContain(
            '/packages/agents/src/permissions/index.ts',
        );
    });

    it('stubs react-native-enriched-markdown so MarkdownView tests do not load native modules', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            resolve?: { alias?: Array<{ find: unknown; replacement: string }> };
        };
        const aliasEntries = Array.isArray(config.resolve?.alias)
            ? config.resolve.alias
            : [];

        const enrichedMarkdownAlias = aliasEntries.find((entry) => entry.find === 'react-native-enriched-markdown');

        expect(enrichedMarkdownAlias, 'expected enriched markdown to use a node-safe test stub').toBeTruthy();
        expect(enrichedMarkdownAlias?.replacement).toContain('reactNativeEnrichedMarkdownStub.tsx');
    });
});
