import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { activatePluginRuntimeRegistry } from '../manager';
import { createDatabaseEnginesService } from './databaseEngines';

describe('contributed database engine catalogue compatibility', () => {
    it('keeps mounted bundled peers without engine contributions available', async () => {
        // Build-admitted bundled JSON is the real cold declaration boundary.
        const source: CanonicalPluginManifest = JSON.parse(readFileSync(new URL('../../../../../assets/bundled-plugin-manifests/deployment-neon.json', import.meta.url), 'utf8'));
        // Preserve the omission observed in the mounted workflow/Muse startup,
        // even after the bundled publisher regenerates its new empty default.
        Reflect.deleteProperty(source.contributes, 'databaseEngines');
        const admitted = ingestCanonicalPluginManifest(source, { admission: 'build', manifestAuthority: 'bundled_first_party' });
        if (!admitted.ok) throw new Error('Expected bundled declaration');
        expect(PluginContributesV2Schema.parse({}).databaseEngines).toEqual([]);
        // A mounted registry admitted before this family existed retains its old shape.
        Reflect.deleteProperty(admitted.manifest.contributes, 'databaseEngines');
        const contributes = createResolvedContributionRegistry({ activationTargets: [{
            provenance: 'first_party', source: { kind: 'bundled' }, pluginId: source.id,
            manifestPath: '/fixture/neon/plugin.json', daemonEntryPath: '/fixture/neon/daemon.mjs',
            sourceSpec: { kind: 'path', locator: '/fixture/neon', trustPolicy: 'local_trusted', installPolicy: 'link' },
            activationEvents: [], manifest: admitted.manifest,
        }] });
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: 'fixture-neon', load: async () => {
                throw new Error('Cold engine discovery must not load an unrelated provider');
            } }),
        });
        try { expect(createDatabaseEnginesService({ targets: contributes.activationTargets, registry }).list()).toEqual([]); }
        finally { await registry.dispose(); }
    });
});
