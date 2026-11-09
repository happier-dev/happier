import { readFileSync } from 'node:fs';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/channels/src/manifest.js';
import { compactActionSchemas } from './actionSchemas';

/**
 * The tracked declaration consumed by clean-checkout bundled-plugin discovery.
 *
 * The canonical bundled publisher owns this projection. The ignored
 * `.happier-plugin/plugin.json` is an on-demand package output and may be stale
 * on an AUTO worker; distribution packaging verifies that artifact separately.
 */
function readBundledManifest(): unknown {
    return JSON.parse(
        readFileSync(new URL('../../../assets/bundled-plugin-manifests/channels.json', import.meta.url), 'utf8'),
    ) as unknown;
}

describe('bundled Conversation Channels declaration', () => {
    it('matches the source manifest projection, fact for fact', () => {
        // Deliberately the whole artifact rather than a hand-picked fact: this
        // fails for any fact the source projection adds, drops or renames,
        // so a source/consumer seam mismatch cannot be hidden by cherry-picking.
        const projected = parsePluginManifest(PLUGIN_MANIFEST);
        if (!projected.ok) {
            throw new Error(projected.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
        }

        // Bundled assets use the publisher's compact representation, unlike
        // authored/package declarations. Compare every fact after that same
        // owner projection, not raw authored schemas against published refs.
        const admitted = ingestPluginManifestV2(projected.manifest);
        if (!admitted.ok) {
            throw new Error(admitted.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
        }
        expect(compactActionSchemas(admitted.manifest)).toEqual(readBundledManifest());
    });
});
