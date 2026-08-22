import { describe, expect, it, vi } from 'vitest';

import type { PluginSelectedArtifactIdentity } from './artifactLease';
import {
    createBundledPluginUiAppExactArtifactSourceFromInventory,
    type BundledPluginUiAppArtifactInventory,
} from './bundledAppExactArtifactSource';

const INSPECTOR_TIER = 'reactNative' as const;
const INSPECTOR_PLATFORM = 'web' as const;

const INSPECTOR_ARTIFACT: PluginSelectedArtifactIdentity = Object.freeze({
    pluginId: 'happier.inspector',
    contributionId: 'inspector-app-native',
    tier: INSPECTOR_TIER,
    platform: INSPECTOR_PLATFORM,
    digest: 'sha256:0d237046c8ce1b23a69c539ee9823e07bdbc015a32b4bd909628a595bf1a2c29',
    releaseVersion: '0.0.0',
    availabilityCursor: 7,
});

const INSPECTOR_ENTRY_PATH = 'react-native-web/inspector-app-native/entry.mjs.bundle';

function createInventory(): BundledPluginUiAppArtifactInventory {
    return Object.freeze([Object.freeze({
        pluginId: INSPECTOR_ARTIFACT.pluginId,
        contributionId: INSPECTOR_ARTIFACT.contributionId,
        tier: INSPECTOR_TIER,
        platform: INSPECTOR_PLATFORM,
        digest: INSPECTOR_ARTIFACT.digest,
        releaseVersion: INSPECTOR_ARTIFACT.releaseVersion,
        files: Object.freeze([Object.freeze({
            relativePath: INSPECTOR_ENTRY_PATH,
            asset: 'inspector-web-entry',
        })]),
    })]);
}

describe('bundled app-exact Plugin UI artifact source', () => {
    it('serves only the declared immutable Inspector byte for its exact selected Artifact', async () => {
        const readBundledAssetBytes = vi.fn(async (asset: unknown) => {
            expect(asset).toBe('inspector-web-entry');
            return new Uint8Array([1, 2, 3]);
        });
        const source = createBundledPluginUiAppExactArtifactSourceFromInventory({
            inventory: createInventory(),
            readBundledAssetBytes,
        });

        await expect(source.readFile({
            artifact: INSPECTOR_ARTIFACT,
            relativePath: INSPECTOR_ENTRY_PATH,
        })).resolves.toEqual(new Uint8Array([1, 2, 3]));
        expect(source.kind).toBe('appExact');
        expect(readBundledAssetBytes).toHaveBeenCalledTimes(1);
    });

    it('returns no bytes for a different immutable Artifact or undeclared path, but ignores Account-hosted source provenance', async () => {
        const readBundledAssetBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const source = createBundledPluginUiAppExactArtifactSourceFromInventory({
            inventory: createInventory(),
            readBundledAssetBytes,
        });

        await expect(source.readFile({
            artifact: Object.freeze({ ...INSPECTOR_ARTIFACT, releaseVersion: '0.0.1' }),
            relativePath: INSPECTOR_ENTRY_PATH,
        })).resolves.toBeNull();
        await expect(source.readFile({
            artifact: INSPECTOR_ARTIFACT,
            relativePath: INSPECTOR_ENTRY_PATH,
            accountHostedArtifactId: 'account-hosted-artifact',
        })).resolves.toEqual(new Uint8Array([1, 2, 3]));
        await expect(source.readFile({
            artifact: INSPECTOR_ARTIFACT,
            relativePath: '../undeclared.mjs',
        })).resolves.toBeNull();
        expect(readBundledAssetBytes).toHaveBeenCalledTimes(1);
    });
});
