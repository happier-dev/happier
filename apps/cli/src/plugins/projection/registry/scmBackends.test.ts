import { describe, expect, it } from 'vitest';

import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type ScmBackendContribution,
} from '@happier-dev/protocol';

import { buildPluginContributionRegistry } from './normalize/package';
import { buildPluginProjectionV2 } from './projection/v2';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from './types';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-scm-backend',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function createScmBackendDefinition(id: string): ScmBackendContribution {
    return {
        id,
        title: 'Acme VCS',
        kind: 'acme-vcs',
        capabilities: ['detect', 'status'],
    };
}

describe('SCM backend plugin contributions', () => {
    it('flattens non-agent backend descriptors with plugin contribution identity', () => {
        const registry = buildPluginContributionRegistry({
            loadedPlugins: [
                {
                    pluginId: 'acme.scm.backend',
                    pluginRootPath: '/plugins/acme-scm-backend',
                    manifestPath: '/plugins/acme-scm-backend/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: '/plugins/acme-scm-backend/daemon.js',
                    sourceSpec,
                    devDaemonEntryPath: null,
                    manifest: readCanonicalPluginManifest(createPluginManifestV2Fixture({
                        schemaVersion: 2,
                        id: 'acme.scm.backend',
                        version: '1.0.0',
                        displayName: 'Acme SCM Backend',
                        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
                        entrypoints: { daemon: './daemon.js' },
                        contributes: {
                            agents: [],
                            actions: [],
                            tools: [],
                            commands: [],
                            resources: [],
                            scmBackends: [createScmBackendDefinition('acme-vcs')],
                            hooks: [],
                        },
                    }))!,
                },
            ],
        });

        const scmBackends = (registry as unknown as {
            scmBackends?: readonly {
                definition: { id: string };
                identity?: {
                    pluginId: string;
                    localId: string;
                };
            }[];
        }).scmBackends;

        expect(scmBackends).toEqual([
            expect.objectContaining({
                definition: expect.objectContaining({ id: 'acme-vcs' }),
                identity: {
                    pluginId: 'acme.scm.backend',
                    localId: 'acme-vcs',
                },
            }),
        ]);
        expect(registry.agents).toEqual([]);
    });

    it('keeps same-local-id backends from distinct plugin namespaces addressable', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
                        scmBackends: [
                {
                    id: 'git',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.one',
                    definition: createScmBackendDefinition('git'),
                },
                {
                    id: 'git',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.two',
                    manifestPath: '/plugins/acme-shadow/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:shadow',
                    daemonEntryPath: '/plugins/acme-shadow/daemon.js',
                    sourceSpec,
                    devDaemonEntryPath: null,
                    definition: createScmBackendDefinition('git'),
                },
            ],
        } as Parameters<typeof createResolvedContributionRegistry>[0] & {
            scmBackends: readonly unknown[];
        });

        const projected = registry as ResolvedContributionRegistry & {
            scmBackends?: readonly { id: string; pluginId?: string }[];
            scmBackendsById?: ReadonlyMap<string, { pluginId?: string }>;
        };

        const firstKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: 'acme.scm.one',
            localId: 'git',
        }));
        const secondKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: 'acme.scm.two',
            localId: 'git',
        }));
        expect(projected.scmBackendsById?.get(firstKey)?.pluginId).toBe('acme.scm.one');
        expect(projected.scmBackendsById?.get(secondKey)?.pluginId).toBe('acme.scm.two');
        expect(projected.scmBackends).toHaveLength(2);
        expect(registry.pluginDiagnosticsByPluginId['acme.scm.two']).toBeUndefined();
        const projection = buildPluginProjectionV2({ registry: projected, generation: 9 });
        expect(Object.keys(projection.familiesById.scmBackends?.entriesById ?? {})).toEqual([
            'acme.scm.one/git',
            'acme.scm.two/git',
        ]);
    });

    it('projects only backends backed by the current authoritative runtime lease when runtime facts are supplied', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
                        scmBackends: [
                {
                    id: 'active',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.active',
                    definition: {
                        ...createScmBackendDefinition('active'),
                        description: 'Active backend',
                        metadata: { routing: 'stacked' },
                    },
                },
                {
                    id: 'stale',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm.stale',
                    definition: createScmBackendDefinition('stale'),
                },
            ],
        } as Parameters<typeof createResolvedContributionRegistry>[0] & {
            scmBackends: readonly unknown[];
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 11,
            scmRuntimeAvailability: {
                backendIds: new Set(['acme.scm.active/active']),
                hostingProviderIds: new Set(),
            },
        });

        expect(projection.familiesById.scmBackends?.entriesById).toEqual({
            'acme.scm.active/active': expect.objectContaining({
                id: 'acme.scm.active/active',
                localId: 'active',
                pluginId: 'acme.scm.active',
                displayName: 'Acme VCS',
                description: 'Active backend',
                operations: ['detect', 'status'],
                metadata: { routing: 'stacked' },
            }),
        });
    });
});
