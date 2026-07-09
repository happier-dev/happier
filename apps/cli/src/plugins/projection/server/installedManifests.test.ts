import { describe, expect, it } from 'vitest';

import type { PluginPermissionDeclarationV1 } from '@happier-dev/protocol';

import type { InstalledPluginManifestProjectionCatalogEntry } from './installedManifests';
import {
    buildInstalledPluginManifestProjectionSyncPlan,
    publishInstalledPluginManifestProjectionsToServer,
} from './installedManifests';

function createManifest(params: Readonly<{
    id: string;
    optionalPermissions?: readonly PluginPermissionDeclarationV1[];
}>): InstalledPluginManifestProjectionCatalogEntry['manifest'] {
    return {
        schemaVersion: 2,
        id: params.id,
        version: '1.0.0',
        displayName: params.id,
        description: `${params.id} plugin`,
        engines: {
            happier: '^0.2.0',
        },
        activationEvents: [],
        uses: [],
        entrypoints: { main: './daemon.js' },
        permissions: [],
        optionalPermissions: params.optionalPermissions ?? [],
        contributes: {
            agents: [],
            agentRuntimes: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [],
            hooks: [],
            lifecycleHandlers: [],
        },
    };
}

function createCatalogEntry(params: Readonly<{
    pluginId: string;
    enabled?: boolean;
    manifestDigest?: string | null;
    manifest?: InstalledPluginManifestProjectionCatalogEntry['manifest'];
    diagnostics?: InstalledPluginManifestProjectionCatalogEntry['diagnostics'];
}>): InstalledPluginManifestProjectionCatalogEntry {
    return {
        pluginId: params.pluginId,
        title: params.pluginId,
        version: params.manifest?.version ?? '1.0.0',
        enabled: params.enabled ?? true,
        manifestDigest: params.manifestDigest ?? `sha256:${params.pluginId}`,
        manifest: params.manifest ?? createManifest({ id: params.pluginId }),
        diagnostics: params.diagnostics ?? [],
    };
}

describe('buildInstalledPluginManifestProjectionSyncPlan', () => {
    it('upserts enabled external manifests and never deletes unknown remote projections during full reload sync', () => {
        const directWritePermission = {
            capability: 'reviews.comments.write.direct',
        } satisfies PluginPermissionDeclarationV1;
        const plan = buildInstalledPluginManifestProjectionSyncPlan({
            entries: [
                createCatalogEntry({
                    pluginId: 'acme.reviewbot',
                    manifest: createManifest({
                        id: 'acme.reviewbot',
                        optionalPermissions: [directWritePermission],
                    }),
                }),
                createCatalogEntry({
                    pluginId: 'happier.review.coderabbit',
                    manifest: createManifest({ id: 'happier.review.coderabbit' }),
                }),
                createCatalogEntry({
                    pluginId: 'acme.disabled',
                    enabled: false,
                }),
                createCatalogEntry({
                    pluginId: 'acme.invalid',
                    diagnostics: [{ code: 'plugin_manifest_invalid', message: 'invalid' }],
                }),
            ],
            pluginIds: [],
        });

        expect(plan.upserts).toEqual([
            expect.objectContaining({
                pluginId: 'acme.reviewbot',
                displayName: 'acme.reviewbot',
                manifestDigest: 'sha256:acme.reviewbot',
                optionalPermissions: [directWritePermission],
            }),
        ]);
        expect(plan.deletes).toEqual(['acme.disabled', 'acme.invalid']);
        expect(plan.skipped.map((entry) => [entry.pluginId, entry.reason])).toEqual([
            ['happier.review.coderabbit', 'reserved_plugin_id'],
            ['acme.disabled', 'disabled'],
            ['acme.invalid', 'diagnostics_present'],
        ]);
    });

    it('deletes only the affected external plugin when targeted reload can no longer project it', () => {
        const plan = buildInstalledPluginManifestProjectionSyncPlan({
            entries: [
                createCatalogEntry({
                    pluginId: 'acme.disabled',
                    enabled: false,
                }),
                createCatalogEntry({
                    pluginId: 'acme.other',
                }),
            ],
            pluginIds: ['acme.disabled'],
        });

        expect(plan.upserts).toEqual([]);
        expect(plan.deletes).toEqual(['acme.disabled']);
    });
});

describe('publishInstalledPluginManifestProjectionsToServer', () => {
    it('publishes the exact upsert and delete requests with host credentials', async () => {
        const calls: Array<Readonly<{ url: string; body: unknown; token: string | undefined; timeout: number | undefined }>> = [];
        const result = await publishInstalledPluginManifestProjectionsToServer({
            pluginIds: ['acme.reviewbot', 'acme.removed'],
            readCredentials: async () => ({
                token: 'token-1',
                encryption: { type: 'legacy', secret: new Uint8Array() },
            }),
            readInstalledPluginCatalog: async () => [
                createCatalogEntry({
                    pluginId: 'acme.reviewbot',
                    manifest: createManifest({
                        id: 'acme.reviewbot',
                        optionalPermissions: [{ capability: 'reviews.comments.write.direct' }],
                    }),
                }),
            ],
            resolveServerBaseUrl: () => 'http://server.local',
            timeoutMs: 1234,
            post: async (url, body, config) => {
                calls.push({
                    url,
                    body,
                    token: config.headers?.Authorization,
                    timeout: config.timeout,
                });
                if (url.endsWith('/upsert')) {
                    return {
                        status: 200,
                        data: {
                            manifest: {
                                v: 1,
                                accountId: 'account-1',
                                machineId: 'machine-1',
                                ...(body as Record<string, unknown>),
                                enabled: true,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        },
                    };
                }
                return {
                    status: 200,
                    data: {
                        pluginId: (body as { pluginId: string }).pluginId,
                        deleted: true,
                    },
                };
            },
            createPublisherHeader: () => 'publisher-header',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            attempted: true,
            upserted: 1,
            deleted: 1,
        }));
        expect(calls).toEqual([
            {
                url: 'http://server.local/v1/plugins/installations/manifests/upsert',
                body: expect.objectContaining({
                    pluginId: 'acme.reviewbot',
                    optionalPermissions: [{ capability: 'reviews.comments.write.direct' }],
                }),
                token: 'Bearer token-1',
                timeout: 1234,
            },
            {
                url: 'http://server.local/v1/plugins/installations/manifests/delete',
                body: { pluginId: 'acme.removed' },
                token: 'Bearer token-1',
                timeout: 1234,
            },
        ]);
    });
});
