import { afterEach, describe, expect, it, vi } from 'vitest';

const { fromModule } = vi.hoisted(() => ({ fromModule: vi.fn() }));
// Expo asset acquisition and HTTP are native/network boundaries.
vi.mock('expo-asset', () => ({ Asset: { fromModule } }));

import { readBundledAssetBytes } from './readBundledAssetBytes';
import { readBundledPluginUiDeclarationAsset } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactAssetReader';

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function remoteAsset() {
    fromModule.mockReturnValue({ downloadAsync: async () => {}, uri: 'https://assets.example/declaration.json' });
}

describe('bundled asset acquisition cause', () => {
    it('reads a declaration through the real byte owner', async () => {
        remoteAsset();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        await expect(readBundledPluginUiDeclarationAsset('declaration')).resolves.toEqual({});
    });

    it('keeps the HTTP failure at the declaration consumer without exposing the URL or body', async () => {
        remoteAsset();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('private body', { status: 503 })));
        await expect(readBundledPluginUiDeclarationAsset('declaration')).rejects.toMatchObject({
            code: 'bundled_asset_http_error', status: 503,
        });
    });

    it('retains a download exception as the acquisition cause', async () => {
        const cause = Object.assign(new Error('download failed'), { code: 'ENETUNREACH' });
        fromModule.mockReturnValue({ downloadAsync: async () => { throw cause; } });
        await expect(readBundledAssetBytes('declaration')).rejects.toMatchObject({
            code: 'bundled_asset_read_failed', cause,
        });
    });

    it('reports an asset with no usable URI at the shared owner', async () => {
        fromModule.mockReturnValue({ downloadAsync: async () => {}, uri: '' });
        await expect(readBundledPluginUiDeclarationAsset('declaration')).rejects.toMatchObject({
            code: 'bundled_asset_uri_missing',
        });
    });
});
