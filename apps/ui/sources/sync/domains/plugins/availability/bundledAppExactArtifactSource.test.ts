import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS, installBundledPluginUiArtifactsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';

import type { PluginSelectedArtifactIdentity } from './artifactLease';
import {
    createBundledPluginUiAppExactArtifactSource,
    createBundledPluginUiAppExactArtifactSourceFromInventory,
    type BundledPluginUiAppArtifactInventory,
} from './bundledAppExactArtifactSource';

const INSPECTOR_TIER = 'reactNative' as const;
const INSPECTOR_PLATFORM = 'web' as const;

const INSPECTOR_ARTIFACT: PluginSelectedArtifactIdentity = Object.freeze({
    pluginId: 'happier.inspector',
    contributionId: 'inspector-app-native',
    artifactId: 'inspector-app-native',
    tier: INSPECTOR_TIER,
    platform: INSPECTOR_PLATFORM,
    digest: 'sha256:0d237046c8ce1b23a69c539ee9823e07bdbc015a32b4bd909628a595bf1a2c29',
    hostUiApiRange: '^1.0.0',
    releaseVersion: '0.0.0',
});

const INSPECTOR_ENTRY_PATH = 'react-native-web/inspector-app-native/entry.mjs.bundle';

function createInventory(): BundledPluginUiAppArtifactInventory {
    return Object.freeze([Object.freeze({
        pluginId: INSPECTOR_ARTIFACT.pluginId,
        artifactId: INSPECTOR_ARTIFACT.artifactId,
        tier: INSPECTOR_TIER,
        digest: INSPECTOR_ARTIFACT.digest,
        releaseVersion: INSPECTOR_ARTIFACT.releaseVersion,
        files: Object.freeze([Object.freeze({
            relativePath: INSPECTOR_ENTRY_PATH,
            asset: 'inspector-web-entry',
        })]),
    })]);
}

describe('bundled app-exact Plugin UI artifact source', () => {
    it('serves and restores fixture bytes installed after the app source was created', async () => {
        const source = createBundledPluginUiAppExactArtifactSourceFromInventory({
            inventory: BUNDLED_PLUGIN_UI_APP_ARTIFACTS,
            readBundledAssetBytes: async () => new Uint8Array([1, 2, 3]),
        });
        const restore = installBundledPluginUiArtifactsForTests(createInventory());
        try {
            await expect(source.fetch({ artifact: INSPECTOR_ARTIFACT }))
                .resolves.toEqual(new Map([[INSPECTOR_ENTRY_PATH, new Uint8Array([1, 2, 3])]]));
        } finally { restore(); }
        await expect(source.fetch({ artifact: INSPECTOR_ARTIFACT })).resolves.toBeNull();
    });

    it('returns unavailable for app bytes absent from the source-test inventory', async () => {
        const source = createBundledPluginUiAppExactArtifactSource();

        expect(source.kind).toBe('appExact');
        await expect(source.fetch({ artifact: INSPECTOR_ARTIFACT })).resolves.toBeNull();
    });

    it('returns the declared immutable file set for its exact selected digest', async () => {
        const readBundledAssetBytes = vi.fn(async (asset: unknown) => {
            expect(asset).toBe('inspector-web-entry');
            return new Uint8Array([1, 2, 3]);
        });
        const source = createBundledPluginUiAppExactArtifactSourceFromInventory({
            inventory: createInventory(),
            readBundledAssetBytes,
        });

        await expect(source.fetch({ artifact: INSPECTOR_ARTIFACT }))
            .resolves.toEqual(new Map([[INSPECTOR_ENTRY_PATH, new Uint8Array([1, 2, 3])]]));
        expect(source.kind).toBe('appExact');
        expect(readBundledAssetBytes).toHaveBeenCalledTimes(1);
    });

    it('matches immutable bytes shared by bundled release occurrences by digest', async () => {
        const readBundledAssetBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const inventory = createInventory();
        const source = createBundledPluginUiAppExactArtifactSourceFromInventory({
            inventory: [...inventory, ...inventory.map(entry => ({ ...entry,
                pluginId: 'happier.other', releaseVersion: '0.0.1',
            }))],
            readBundledAssetBytes,
        });

        await expect(source.fetch({
            artifact: Object.freeze({ ...INSPECTOR_ARTIFACT, releaseVersion: '0.0.1' }),
        })).resolves.toEqual(new Map([[INSPECTOR_ENTRY_PATH, new Uint8Array([1, 2, 3])]]));
        await expect(source.fetch({
            artifact: Object.freeze({ ...INSPECTOR_ARTIFACT, digest: `sha256:${'f'.repeat(64)}` as const }),
        })).resolves.toBeNull();
        expect(readBundledAssetBytes).toHaveBeenCalledTimes(1);
    });
});
