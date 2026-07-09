import { describe, expect, it } from 'vitest';

import { createPluginApiHost } from './api/host';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

async function loadOpenCodePluginActivate(): Promise<(api: unknown) => unknown> {
    // Import plugin source directly (not dist) so this test doesn't depend on build outputs.
    const moduleUrl = new URL(
        '../../../../../packages/plugins/opencode/src/activate.ts',
        import.meta.url,
    );
    const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isRecord(namespace) || typeof namespace.activate !== 'function') {
        throw new Error('Expected OpenCode plugin module to export activate(api)');
    }
    return namespace.activate as (api: unknown) => unknown;
}

describe('plugins/opencode activate(api)', () => {
    it('always registers an agent runtime for opencode', async () => {
        const activate = await loadOpenCodePluginActivate();
        const host = createPluginApiHost({ runtimeCapabilities: ['agents'] });

        await activate(host.api);

        const registrations = host.registrations();
        expect(registrations.agentRuntimes.map((runtime) => runtime.agentId)).toEqual(['opencode']);
    });
});
