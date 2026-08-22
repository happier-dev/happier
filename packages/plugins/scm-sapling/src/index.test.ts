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
            entrypoints: { daemon: './.happier-plugin/daemon.js' },
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

    it('registers only the manifest-local backend through the public activation ABI', () => {
        const registrations: Array<Readonly<{ id: string; runtime: unknown }>> = [];

        publicApi.activate({
            scm: {
                registerBackend(id: string, runtime: unknown) {
                    registrations.push({ id, runtime });
                },
            },
        } as Parameters<typeof publicApi.activate>[0]);

        expect(registrations.map(({ id }) => id))
            .toEqual(publicApi.PLUGIN_MANIFEST.contributes.scmBackends.map(({ id }) => id));
        expect(registrations[0]?.runtime).toEqual(expect.objectContaining({
            runtime: expect.objectContaining({ repoModes: ['.sl', '.git'] }),
            handlers: expect.objectContaining({ detection: expect.any(Object) }),
        }));
    });
});
