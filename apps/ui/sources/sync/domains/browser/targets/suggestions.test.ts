import type {
    BrowserViewTargetV1,
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
    },
} satisfies BrowserViewTargetV1;

const pluginTarget = {
    kind: 'externalUrl',
    targetId: 'browserTarget:acme.preview:previewPane',
    url: 'https://preview.happier.test/plugin/acme/',
} satisfies BrowserViewTargetV1;

const launcherSnapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'launcher_preview',
        source: 'registered_preview',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        kind: 'vite',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: localPreviewTarget,
    }, {
        id: 'launcher_stale',
        source: 'inventory_entry',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Old service',
        subtitle: 'localhost:4000',
        confidence: 'medium',
        state: 'stale',
        unavailableReason: 'stale_service',
        actions: ['open_preview'],
        browserTarget: {
            ...localPreviewTarget,
            targetId: 'preview_stale',
            display: {
                title: 'Old service',
                addressLabel: 'localhost:4000',
            },
        },
    }],
} satisfies LocalServiceLauncherSnapshotV1;

const pluginProjection = {
    generation: 2,
    targetsById: {
        'browserTarget:acme.preview:previewPane': {
            id: 'browserTarget:acme.preview:previewPane',
            pluginId: 'acme.preview',
            contributionKind: 'browserTarget',
            contributionId: 'previewPane',
            target: pluginTarget,
            display: {
                title: 'Plugin Preview',
                addressLabel: 'https://preview.happier.test/plugin/acme/',
            },
            currentUrl: 'https://preview.happier.test/plugin/acme/',
            launchMode: 'currentView',
            profileMode: 'session',
        },
    },
    actionsById: {},
    unknownEntriesById: {},
} satisfies PluginBrowserProjectionModel;

describe('browser launchpad suggestions', () => {
    it('builds launchpad rows from registered local preview state', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const localServicePreviewState = applyLocalServicePreviewSnapshot(
            createLocalServicePreviewState(),
            {
                generatedAt: 1_500,
                refreshState: 'idle',
                previews: [{
                    previewId: 'preview_vite',
                    accessUrl: 'https://preview.happier.test/session_1/preview_vite/',
                    expiresAt: 4_000,
                    diagnostics: [],
                    resource: {
                        previewId: 'preview_vite',
                        sessionId: 'session_1',
                        machineId: 'machine_1',
                        owner: { kind: 'session', id: 'session_1' },
                        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                        initialPath: { pathname: '/', search: '' },
                        display: {
                            title: 'Vite app',
                            addressLabel: 'localhost:5173',
                            folderLabel: 'happier',
                        },
                        originMode: 'host',
                        browserTarget: localPreviewTarget,
                    },
                }],
                diagnostics: [],
            },
        );

        const rows = buildBrowserLaunchpadRows({
            localServicePreviewState,
            nowMs: 2_000,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: 'localServicePreview:preview_vite',
            section: 'running',
            sourceKind: 'localService',
            title: 'Vite app',
            subtitle: 'localhost:5173',
            detail: 'registered_preview',
            target: localPreviewTarget,
            currentUrl: 'https://preview.happier.test/session_1/preview_vite/',
            currentUrlExpiresAt: 4_000,
            disabledReason: null,
            lastSeenAt: 1_500,
        });
    });

    it('builds ranked launchpad rows from LSV launcher snapshots, plugin browser targets, and recents', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');

        const rows = buildBrowserLaunchpadRows({
            launcherSnapshot,
            pluginBrowserProjection: pluginProjection,
            recents: [{
                target: {
                    ...localPreviewTarget,
                    targetId: 'preview_recent',
                    display: {
                        title: 'Recent app',
                        addressLabel: 'localhost:3000',
                    },
                },
                openedAt: 2_000,
            }],
            nowMs: 3_000,
        });

        expect(rows.map((row) => row.id)).toEqual([
            'localService:launcher_preview',
            'pluginExternalUrl:browserTarget:acme.preview:previewPane',
            'recent:preview_recent',
            'localService:launcher_stale',
        ]);
        expect(rows[0]).toMatchObject({
            section: 'running',
            title: 'Vite app',
            subtitle: 'localhost:5173',
            disabledReason: null,
            target: localPreviewTarget,
        });
        expect(rows[1]).toMatchObject({
            section: 'plugin',
            title: 'Plugin Preview',
            target: pluginTarget,
            currentUrl: 'https://preview.happier.test/plugin/acme/',
            sourceKind: 'pluginExternalUrl',
            launchMode: 'currentView',
            profileMode: 'session',
        });
        expect(rows[2]).toMatchObject({
            section: 'recent',
            title: 'Recent app',
        });
        expect(rows[3]).toMatchObject({
            section: 'unavailable',
            title: 'Old service',
            disabledReason: 'stale_service',
        });
    });

    it('evaluates plugin target availability with the host policy context and fails closed without it', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');
        const projection = {
            ...pluginProjection,
            targetsById: {
                'browserTarget:acme.preview:previewPane': {
                    ...pluginProjection.targetsById['browserTarget:acme.preview:previewPane'],
                    availability: {
                        when: { fact: 'host.platform', operator: 'equals', value: 'desktop' },
                    },
                },
            },
        } satisfies PluginBrowserProjectionModel;

        expect(buildBrowserLaunchpadRows({ pluginBrowserProjection: projection })).toEqual([]);
        expect(buildBrowserLaunchpadRows({
            pluginBrowserProjection: projection,
            pluginBrowserPolicyContext: { platform: 'desktop' },
        })).toHaveLength(1);
        expect(buildBrowserLaunchpadRows({
            pluginBrowserProjection: projection,
            pluginBrowserPolicyContext: { platform: 'ios' },
        })).toEqual([]);
    });

    it('keeps a policy-disabled plugin target visible with its exact authored unavailable reason', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');
        const projection = {
            ...pluginProjection,
            targetsById: {
                [pluginTarget.targetId]: {
                    ...pluginProjection.targetsById['browserTarget:acme.preview:previewPane'],
                    availability: {
                        disabledWhen: {
                            fact: 'host.platform',
                            operator: 'equals',
                            value: 'desktop',
                        },
                        disabledReason: 'Open this target on a mobile device.',
                    },
                },
            },
        } satisfies PluginBrowserProjectionModel;

        expect(buildBrowserLaunchpadRows({
            pluginBrowserProjection: projection,
            pluginBrowserPolicyContext: { platform: 'desktop' },
        })).toEqual([
            expect.objectContaining({
                id: `pluginExternalUrl:${pluginTarget.targetId}`,
                section: 'unavailable',
                disabledReason: 'Open this target on a mobile device.',
            }),
        ]);
    });

    it('dedupes unavailable local-service launch targets by stable row identity', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');

        const rows = buildBrowserLaunchpadRows({
            launcherSnapshot: {
                ...launcherSnapshot,
                targets: [
                    launcherSnapshot.targets[1],
                    {
                        ...launcherSnapshot.targets[1],
                        unavailableReason: 'runtime_dependency_unavailable',
                    },
                ],
            },
            nowMs: 3_000,
        });

        expect(rows.map((row) => row.id)).toEqual(['localService:launcher_stale']);
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    });

    it('B-RC6: plugin row identity and lastSeenAt are stable across polls (nowMs does not churn identity)', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');

        const buildAt = (nowMs: number) => buildBrowserLaunchpadRows({
            pluginBrowserProjection: pluginProjection,
            nowMs,
        });

        const first = buildAt(1_000);
        const second = buildAt(9_999);

        const firstPlugin = first.find((row) => row.section === 'plugin');
        const secondPlugin = second.find((row) => row.section === 'plugin');
        expect(firstPlugin).toBeDefined();
        expect(secondPlugin).toBeDefined();
        // Same structural input + different nowMs → identical id AND identical lastSeenAt (no flicker).
        expect(secondPlugin?.id).toBe(firstPlugin?.id);
        expect(secondPlugin?.lastSeenAt).toBe(firstPlugin?.lastSeenAt);
    });

});
