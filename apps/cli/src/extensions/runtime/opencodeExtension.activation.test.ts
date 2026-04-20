import { describe, expect, it } from 'vitest';

import { createPluginExtensionApiHost } from './api/host';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

async function loadOpenCodeExtensionActivate(): Promise<(api: unknown) => unknown> {
    // Import extension source directly (not dist) so this test doesn't depend on build outputs.
    const moduleUrl = new URL(
        '../../../../../packages/extensions/opencode/src/activate.ts',
        import.meta.url,
    );
    const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isRecord(namespace) || typeof namespace.activate !== 'function') {
        throw new Error('Expected OpenCode extension module to export activate(api)');
    }
    return namespace.activate as (api: unknown) => unknown;
}

describe('extensions/opencode activate(api)', () => {
    it('always registers a backend engine for opencode', async () => {
        const activate = await loadOpenCodeExtensionActivate();
        const host = createPluginExtensionApiHost({ runtimeCapabilities: ['backends'] });

        await activate(host.api);

        const registrations = host.registrations();
        expect(registrations.backendEngines.map((engine) => engine.backendId)).toEqual(['opencode']);
    });
});
