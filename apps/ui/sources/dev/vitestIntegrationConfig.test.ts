import { describe, expect, it } from 'vitest';

type ResolveIdResult = string | null | undefined | false | { id?: string };

type PluginWithResolver = {
    name?: string;
    resolveId?: (id: string, importer?: string) => ResolveIdResult | Promise<ResolveIdResult>;
};

function getPlugins(value: unknown): PluginWithResolver[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((plugin) => {
        if (Array.isArray(plugin)) {
            return getPlugins(plugin);
        }

        if (plugin && typeof plugin === 'object') {
            return [plugin as PluginWithResolver];
        }

        return [];
    });
}

describe('vitest integration config', () => {
    it('does not exclude integration patterns inherited from unit config', async () => {
        const module = await import('../../vitest.integration.config');
        const testConfig = module.default.test ?? {};

        expect(testConfig.exclude ?? []).toEqual([]);
    });

    it('resolves workspace package imports through the inherited source resolver', async () => {
        const module = await import('../../vitest.integration.config');
        const plugins = getPlugins(module.default.plugins);
        const workspaceResolver = plugins.find((plugin) => (
            plugin.name === 'happier-vitest-expo-node-module-stubs'
        ));

        expect(workspaceResolver?.resolveId).toBeTypeOf('function');

        const result = await workspaceResolver?.resolveId?.('@happier-dev/connection-supervisor');
        const resolved = typeof result === 'string'
            ? result
            : result && typeof result === 'object'
                ? result.id
                : undefined;

        expect(resolved).toContain('/packages/connection-supervisor/src/index.ts');
    });
});
