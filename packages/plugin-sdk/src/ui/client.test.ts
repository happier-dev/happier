import { afterEach, describe, expect, it } from 'vitest';

import type { PluginUiHostApiWireEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import { createPluginUiHostApiClient } from './client.js';
import { PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, type PluginUiHostApiClientBootstrap } from './clientBootstrap.js';
import type { PluginUiSurfaceContext } from './hostApi.js';

const surface: PluginUiSurfaceContext = {
    placement: 'app.settingsPage', platform: 'web', locale: 'en', direction: 'ltr',
    colorScheme: 'light', contrast: 'normal', textScale: 1, reducedMotion: false,
    screenReaderEnabled: false, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};
const identity = { pluginId: 'com.acme.fixture', pluginVersion: '1.0.0', viewId: 'settings', generation: 'g1' } as const;

describe('hosted-web plugin UI public client factory', () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY);
    });

    it('constructs the domain API through the host-private bootstrap and canonical wire negotiation', async () => {
        let listener: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const bootstrap: PluginUiHostApiClientBootstrap = {
            identity,
            transport: {
                subscribe(next) { listener = next; return { dispose: () => { listener = undefined; } }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') listener?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'], surface,
                    });
                },
            },
        };
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, bootstrap);

        const api = await createPluginUiHostApiClient();
        expect(api.version().wireVersion).toBe(1);
        await expect(api.context()).resolves.toEqual(surface);
        expect(sent).toEqual([expect.objectContaining({ kind: 'negotiate', identity })]);
    });

    it('fails explicitly when loaded outside a Happier hosted-web surface', async () => {
        await expect(createPluginUiHostApiClient()).rejects.toMatchObject({ code: 'ui_host_bootstrap_missing' });
    });

    it('fails with the same typed bootstrap error for a malformed host-private adapter', async () => {
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, { identity: {}, transport: {} });
        await expect(createPluginUiHostApiClient()).rejects.toMatchObject({ code: 'ui_host_bootstrap_missing' });
    });
});
