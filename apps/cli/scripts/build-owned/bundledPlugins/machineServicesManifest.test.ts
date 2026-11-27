import { readIndexedBundledDeclarationManifest } from '../../../src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/machine-services/src/manifest.js';
import { compactActionSchemas } from './actionSchemas';

function readBundledManifest(): unknown {
    return readIndexedBundledDeclarationManifest(new URL('../../../assets/bundled-plugin-manifests/machine-services.json', import.meta.url));
}

describe('bundled Machine services declaration', () => {
    it('publishes the current source declaration to the tracked bundled artifact', () => {
        const parsed = parsePluginManifest(PLUGIN_MANIFEST);
        if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnostic => diagnostic.message).join('; '));
        const admitted = ingestPluginManifestV2(parsed.manifest);
        if (!admitted.ok) throw new Error(admitted.diagnostics.map(diagnostic => diagnostic.message).join('; '));

        expect(compactActionSchemas(admitted.manifest)).toEqual(readBundledManifest());
    });
});
