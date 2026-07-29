import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import * as publicApi from './index.js';
import { createSaplingScmBackendRegistration } from './backend.js';

describe('scm-sapling public API', () => {
    it('does not expose internal backend, operation, or parser modules from the package root', () => {
        expect(publicApi).toHaveProperty('activate');
        expect(publicApi).toHaveProperty('SAPLING_SCM_BACKEND_CAPABILITIES');
        expect(publicApi).toHaveProperty('PLUGIN_MANIFEST');
        expect(publicApi).not.toHaveProperty('registerSaplingScmBackend');
        expect(publicApi).not.toHaveProperty('saplingRemoteFetch');
        expect(publicApi).not.toHaveProperty('parseSaplingRemotePaths');
    });

    it('declares the strict target backend and exact executable access', () => {
        expect(publicApi.PLUGIN_MANIFEST).toMatchObject({
            entrypoints: { daemon: './dist/index.js' },
            hostAccess: { required: [{ capability: 'process', scope: { executables: [{ kind: 'managedDependency', id: 'sapling-cli' }] } }], optional: [] },
            contributes: {
                scmBackends: [{ id: 'sapling', title: 'Sapling', kind: 'sapling', capabilities: expect.arrayContaining(['detect', 'status', 'diff', 'commit']) }],
                managedDependencies: [{ id: 'sapling-cli', executable: 'sl' }],
            },
        });
        expect(publicApi.PLUGIN_MANIFEST).not.toHaveProperty('source');
        expect(publicApi.PLUGIN_MANIFEST).not.toHaveProperty('uses');
        expect(publicApi.PLUGIN_MANIFEST).not.toHaveProperty('permissions');
        expect(publicApi.PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
        expect(ingestPluginManifestV2(publicApi.PLUGIN_MANIFEST)).toMatchObject({ ok: true });
        expect(createSaplingScmBackendRegistration().id).toBe(publicApi.PLUGIN_MANIFEST.contributes.scmBackends[0]?.id);
    });
});
