import { afterEach, describe, expect, it } from 'vitest';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as PluginUiHostApiClient from '@happier-dev/plugin-sdk/ui/client';

import { PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY, isPluginUiHostRuntimeExternalGlobalInstalled } from '@happier-dev/protocol/plugins/ui';

import {
    installPluginUiHostRuntimeExternalsGlobal,
    resetPluginUiHostRuntimeExternalsGlobalForTesting,
} from './hostRuntimeExternals';

describe('installPluginUiHostRuntimeExternalsGlobal', () => {
    afterEach(() => {
        resetPluginUiHostRuntimeExternalsGlobalForTesting();
        delete (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
    });

    it('installs the real react and react-native-web module namespaces on the well-known global', () => {
        installPluginUiHostRuntimeExternalsGlobal();

        const runtime = (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] as Record<string, unknown>;
        expect(runtime.react).toBeDefined();
        expect(typeof (runtime.react as { createElement?: unknown }).createElement).toBe('function');
        expect(runtime['react/jsx-runtime']).toBe(ReactJsxRuntime);
        expect(runtime['react/jsx-dev-runtime']).toBe(ReactJsxDevRuntime);
        expect(runtime['react-native-web']).toBeDefined();
        expect(isPluginUiHostRuntimeExternalGlobalInstalled()).toBe(true);
    });

    it('is idempotent — a second call does not replace the installed runtime object', () => {
        installPluginUiHostRuntimeExternalsGlobal();
        const first = (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
        installPluginUiHostRuntimeExternalsGlobal();
        const second = (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
        expect(second).toBe(first);
    });

    it('installs the canonical hosted-web client module without changing its public call shape', async () => {
        installPluginUiHostRuntimeExternalsGlobal();
        const runtime = (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] as Record<string, unknown>;
        const hostApiClient = runtime['@happier-dev/plugin-sdk/ui/client'] as {
            createPluginUiHostApiClient: () => Promise<unknown>;
        };
        expect(hostApiClient).toBe(PluginUiHostApiClient);
        expect(typeof hostApiClient.createPluginUiHostApiClient).toBe('function');
        const client = hostApiClient.createPluginUiHostApiClient();
        expect(client).toBeInstanceOf(Promise);
        await expect(client).rejects.toMatchObject({ code: 'ui_host_bootstrap_missing' });
    });

    it('can install into an injected global scope for isolated tests', () => {
        const fakeGlobal: Record<string, unknown> = {};
        installPluginUiHostRuntimeExternalsGlobal(fakeGlobal);

        expect(isPluginUiHostRuntimeExternalGlobalInstalled(fakeGlobal)).toBe(true);
        expect((globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]).toBeUndefined();
    });
});
