import type { PluginPermissionCapabilityV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createPluginApiHost } from './api/host';

type ReviewPluginNamespace = Readonly<{
    activate: (api: unknown) => unknown;
    PLUGIN_MANIFEST: Readonly<{
        uses: readonly string[];
        contributes: Readonly<{
            agents: readonly Readonly<{ id: string }>[];
        }>;
    }>;
}>;

function isReviewPluginNamespace(value: unknown): value is ReviewPluginNamespace {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).activate === 'function'
        && Boolean((value as Record<string, unknown>).PLUGIN_MANIFEST);
}

type HookPluginNamespace = Readonly<{
    activate: (api: unknown) => unknown;
    PLUGIN_MANIFEST: Readonly<{
        uses: readonly string[];
        permissions: Readonly<{ required: readonly Readonly<{ capability: PluginPermissionCapabilityV1 }>[] }>;
        contributes: Readonly<{
            hooks: readonly Readonly<{ id: string }>[];
        }>;
    }>;
}>;

function isHookPluginNamespace(value: unknown): value is HookPluginNamespace {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).activate === 'function'
        && Boolean((value as Record<string, unknown>).PLUGIN_MANIFEST);
}

async function loadHookPluginSource(packageFolder: string): Promise<HookPluginNamespace> {
    const moduleUrl = new URL(
        `../../../../../packages/plugins/${packageFolder}/src/index.ts`,
        import.meta.url,
    );
    const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isHookPluginNamespace(namespace)) {
        throw new Error(`Expected ${packageFolder} plugin source to export activate(api) and PLUGIN_MANIFEST`);
    }
    return namespace;
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
    ] as const)('allows %s to register its declared agent runtime', async (packageFolder, agentId) => {
        const plugin = await loadReviewPluginSource(packageFolder);
        const manifest = plugin.PLUGIN_MANIFEST;
        const host = createPluginApiHost({
            runtimeCapabilities: manifest.uses,
            declaredAgentIds: manifest.contributes.agents.map((agent) => agent.id),
        });

        await plugin.activate(host.api);

        const registrations = host.registrations();
        expect(registrations.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_runtime_capability_missing' }),
        ]));
        expect(registrations.agentRuntimes.map((runtime) => runtime.agentId)).toEqual([agentId]);
    });
});

describe('first-party hook plugin activation policy', () => {
    it('allows the inspector plugin to register its declared reload hook without a runtime-capability diagnostic', async () => {
        const plugin = await loadHookPluginSource('inspector');
        const manifest = plugin.PLUGIN_MANIFEST;
        const host = createPluginApiHost({
            runtimeCapabilities: manifest.uses,
            permissions: manifest.permissions.required.map((declaration) => declaration.capability),
            declaredHookIds: manifest.contributes.hooks.map((hook) => hook.id),
        });

        await plugin.activate(host.api);

        const registrations = host.registrations();
        expect(registrations.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_runtime_capability_missing' }),
        ]));
        expect(registrations.hooks.map((hook) => hook.hookId)).toEqual(['plugin.reload.after']);
    });
});
