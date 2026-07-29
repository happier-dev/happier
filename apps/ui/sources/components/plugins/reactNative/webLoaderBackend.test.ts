import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY } from '@happier-dev/protocol/plugins/ui';

import { resetPluginUiHostRuntimeExternalsGlobalForTesting } from '../shared/hostRuntimeExternals';
import { createReactNativeWebLoaderBackend } from './webLoaderBackend.web';

function encode(source: string): Uint8Array {
    return new TextEncoder().encode(source);
}

/**
 * The production `blob:` -> `import()` path is a genuine browser-only
 * mechanism (Node's ESM loader rejects `blob:` URLs — verified directly:
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`; only `file`/`data`/`node` schemes are
 * supported). These tests inject a REAL `importModule` that performs an
 * actual dynamic `import()` of a real compiled ES module via a `data:` URI —
 * a genuine end-to-end exercise of module instantiation + coercion + the
 * forbidden-import guard, substituting Node's real `data:` URL support for
 * the browser's real `blob:` URL support (the create-blob-URL half is
 * exercised by the shared web-module loader; this backend reuses that path
 * unchanged instead of owning a second blob importer. The full browser
 * `blob:` round-trip remains a live-QA (Argent web) concern, same
 * pre-existing gap the RNWEB-SPIKE documented for embeddedWeb.
 */
function realDataUriImporter(compiledSource: string) {
    return async (_blobUrl: string) => import(
        /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiledSource)}`
    ) as Promise<Readonly<{ default?: unknown } & Record<string, unknown>>>;
}

afterEach(() => {
    resetPluginUiHostRuntimeExternalsGlobalForTesting();
    delete (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
    delete (globalThis as typeof globalThis & { __pluginAck?: unknown }).__pluginAck;
});

describe('createReactNativeWebLoaderBackend', () => {
    it('is available and identifies itself with the reactNativeWebModule backend id', () => {
        const backend = createReactNativeWebLoaderBackend({ importModule: realDataUriImporter('') });
        expect(backend.available).toBe(true);
        expect(backend.backendId).toBe('reactNativeWebModule');
    });

    it('really imports a named surface export and preserves its sibling runtime acknowledgment', async () => {
        const compiled = [
            'export function renderSurface(props) { return { proof: true, label: props?.surface?.pluginId }; }',
            'export function acknowledgeHostRuntime(input) { globalThis.__pluginAck = input; }',
        ].join('\n');
        const backend = createReactNativeWebLoaderBackend({ importModule: realDataUriImporter(compiled) });

        const module = await backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode('import { View } from "react-native";\n' + compiled),
        });

        expect(typeof module).toBe('function');
        const rendered = module({ surface: { pluginId: 'acme.example' } } as never);
        expect(rendered).toEqual({ proof: true, label: 'acme.example' });
        const acknowledgeHostRuntime = (
            module as typeof module & { acknowledgeHostRuntime?: (input: unknown) => void }
        ).acknowledgeHostRuntime;
        expect(acknowledgeHostRuntime).toBeTypeOf('function');
        acknowledgeHostRuntime?.({ surfaceId: 'surface-1' });
        expect((globalThis as typeof globalThis & { __pluginAck?: unknown }).__pluginAck)
            .toEqual({ surfaceId: 'surface-1' });
    });

    it('rejects a default-object surface because the public contract requires a named executable export', async () => {
        const compiled = 'export default { renderSurface: (props) => ({ proof: "default", props }) };';
        const backend = createReactNativeWebLoaderBackend({
            importModule: async () => ({
                default: {
                    renderSurface: (props: unknown) => ({ proof: 'default', props }),
                },
            }),
        });

        await expect(backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode(compiled),
        })).rejects.toMatchObject({ code: 'invalid_surface_module' });
    });

    it('rejects the reserved runtime acknowledgment name as the configured executable export', async () => {
        const compiled = 'export function acknowledgeHostRuntime() { return null; }';
        const backend = createReactNativeWebLoaderBackend({ importModule: realDataUriImporter(compiled) });

        await expect(backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode(compiled),
            moduleReference: {
                containerName: 'acme_preview',
                modulePath: './renderSurface',
                exportName: 'acknowledgeHostRuntime',
            },
        })).rejects.toMatchObject({ code: 'invalid_surface_module' });
    });

    it('installs the shared host-runtime externals global before instantiating (singleton react sharing)', async () => {
        expect((globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]).toBeUndefined();
        const backend = createReactNativeWebLoaderBackend({
            importModule: realDataUriImporter('export function renderSurface() { return null; }'),
        });

        await backend.loadInstalledBundle!({ identity: {} as never, bytes: encode('x') });

        expect((globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]).toBeDefined();
    });

    it('fails closed on a forbidden direct react/react-native-web/@/ import in the bundle source (same guard as embeddedWeb)', async () => {
        const backend = createReactNativeWebLoaderBackend({
            importModule: realDataUriImporter('export function renderSurface() { return null; }'),
        });

        await expect(backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode('import { useState } from "react";\nexport function renderSurface() {}'),
        })).rejects.toMatchObject({ code: 'forbidden_import' });

        await expect(backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode('import x from "@/sources/internal";\nexport function renderSurface() {}'),
        })).rejects.toMatchObject({ code: 'forbidden_import' });
    });

    it('rejects an invalid module (no renderSurface, no usable default) with invalid_surface_module', async () => {
        const backend = createReactNativeWebLoaderBackend({
            importModule: realDataUriImporter('export const notASurface = 42;'),
        });

        await expect(backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode('export const notASurface = 42;'),
        })).rejects.toMatchObject({ code: 'invalid_surface_module' });
    });

    it('loadDevServerBundle rejects a non-http(s) dev URL fail-closed', async () => {
        const backend = createReactNativeWebLoaderBackend({
            importModule: realDataUriImporter('export function renderSurface() { return null; }'),
        });

        await expect(backend.loadDevServerBundle!({
            devUrl: 'javascript:alert(1)',
            pluginId: 'acme.example',
            contributionId: 'preview',
        })).rejects.toMatchObject({ code: 'dev_server_load_failed' });
    });

    it('loadDevServerBundle really imports from the dev URL for an http(s) URL', async () => {
        const compiled = 'export function renderSurface() { return { fromDevServer: true }; }';
        const backend = createReactNativeWebLoaderBackend({
            importModule: async (url) => {
                expect(url).toBe('http://127.0.0.1:8090/dev-bundle');
                return import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled)}`) as Promise<
                    Readonly<{ default?: unknown } & Record<string, unknown>>
                >;
            },
        });

        const module = await backend.loadDevServerBundle!({
            devUrl: 'http://127.0.0.1:8090/dev-bundle',
            pluginId: 'acme.example',
            contributionId: 'preview',
        });

        expect(module({} as never)).toEqual({ fromDevServer: true });
    });
});
