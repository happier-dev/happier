import { describe, expect, it, vi } from 'vitest';

import { createPluginExtensionApiHost } from './host';

describe('createPluginExtensionApiHost', () => {
    it('records tracked disposables in the registration snapshot and disposes them once', async () => {
        const dispose = vi.fn(async () => undefined);
        const host = createPluginExtensionApiHost();

        host.api.registerAction({
            id: 'acme.action',
            title: 'Acme Action',
            surface: 'cli',
            handler: async () => null,
        });
        host.api.onDispose({ dispose });

        const registrations = host.registrations();
        expect(registrations.disposables).toHaveLength(2);

        await host.dispose();
        await host.dispose();

        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('captures backend engine registrations and disposes their removal handlers', async () => {
        const host = createPluginExtensionApiHost();

        host.api.registerBackendEngine({
            backendId: 'acme.backend',
            create: async () => ({}),
        });

        expect(host.registrations().backendEngines).toHaveLength(1);

        await host.dispose();

        expect(host.registrations().backendEngines).toHaveLength(0);
    });
});
