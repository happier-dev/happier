import { describe, expect, it } from 'vitest';

import { createPluginApiHost } from './api/host';

type ReviewPluginNamespace = Readonly<{
    activate: (api: unknown) => unknown;
    PLUGIN_MANIFEST: Readonly<{
        runtime: Readonly<{ capabilities: readonly string[] }>;
        contributes: Readonly<{
            backends: readonly Readonly<{ id: string }>[];
        }>;
    }>;
}>;

function isReviewPluginNamespace(value: unknown): value is ReviewPluginNamespace {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).activate === 'function'
        && Boolean((value as Record<string, unknown>).PLUGIN_MANIFEST);
}

async function loadReviewPluginSource(packageFolder: string): Promise<ReviewPluginNamespace> {
    // Import plugin source directly so this test does not depend on built dist outputs.
    const moduleUrl = new URL(
        `../../../../../packages/plugins/${packageFolder}/src/index.ts`,
        import.meta.url,
    );
    const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isReviewPluginNamespace(namespace)) {
        throw new Error(`Expected ${packageFolder} plugin source to export activate(api) and PLUGIN_MANIFEST`);
    }
    return namespace;
}

describe('review plugin activation policy', () => {
    it.each([
        ['review-coderabbit', 'coderabbit'],
        ['review-deepsec', 'deepsec'],
    ] as const)('allows %s to register its declared backend engine', async (packageFolder, backendId) => {
        const plugin = await loadReviewPluginSource(packageFolder);
        const manifest = plugin.PLUGIN_MANIFEST;
        const host = createPluginApiHost({
            runtimeCapabilities: manifest.runtime.capabilities,
            declaredBackendIds: manifest.contributes.backends.map((backend) => backend.id),
        });

        await plugin.activate(host.api);

        const registrations = host.registrations();
        expect(registrations.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_runtime_capability_missing' }),
        ]));
        expect(registrations.backendEngines.map((engine) => engine.backendId)).toEqual([backendId]);
    });
});
