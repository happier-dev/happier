import { readFileSync } from 'node:fs';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

/**
 * The packaged artifact, not the source module.
 *
 * A host installs `.happier-plugin/plugin.json`; `src/manifest.ts` being right
 * proves nothing about those bytes. `yarn test:migration:bundled-plugin-projections`
 * owns the repository verdict for every bundled plugin, but it regenerates the
 * whole bundled projection and runs neither in this package's suite nor in
 * seconds — so an author changing the manifest, or moving the package onto a
 * different author path, learns nothing here until CI.
 */
function readPackagedManifest(): unknown {
    return JSON.parse(
        readFileSync(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as unknown;
}

describe('packaged Conversation Channels manifest', () => {
    it('ships exactly what the source manifest projects, fact for fact', () => {
        // Deliberately the whole artifact rather than a hand-picked fact: this
        // fails for any fact the source projection adds, drops or renames,
        // which is what makes it evidence that an author-path migration changed
        // nothing the host installs.
        const projected = parsePluginManifest(PLUGIN_MANIFEST);
        if (!projected.ok) {
            throw new Error(projected.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
        }

        expect(projected.manifest).toEqual(readPackagedManifest());
    });
});
