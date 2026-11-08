import type {
    BrowserViewTargetV1} from '@happier-dev/protocol/browser/target/v1';
import type {
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol/local/services/launcher/v1';
import { describe, expect, it } from 'vitest';

import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';

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
        source: 'inventory_entry',
        sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry_vite' },
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        kind: 'vite',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview', 'register_preview'],
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
    it('finds the running Service preview behind a typed localhost address', async () => {
        const { buildBrowserLaunchpadRows, selectLaunchpadServiceRowForAddress } = await import('./suggestions');
        const rows = buildBrowserLaunchpadRows({ launcherSnapshot, nowMs: 3_000 });
        expect(selectLaunchpadServiceRowForAddress(rows, 'http://localhost:5173/docs')?.id).toBe('service:launcher_preview');
        expect(selectLaunchpadServiceRowForAddress(rows, 'http://127.0.0.1:5173/')?.id).toBe('service:launcher_preview');
        expect(selectLaunchpadServiceRowForAddress(rows, 'http://localhost:4000/')).toBeNull();
        expect(selectLaunchpadServiceRowForAddress(rows, 'https://example.com:5173/')).toBeNull();
    });
    it('never promotes access-only preview registration into Running or ended-preview recovery', async () => {
        const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('./suggestions');
        const registration = { ...launcherSnapshot.targets[0], id: 'preview:access-only', source: 'registered_preview',
            sourceClass: { kind: 'registered_preview', previewId: localPreviewTarget.targetId }, actions: ['open_preview'],
        } satisfies LocalServiceLauncherSnapshotV1['targets'][number];
        expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: [registration],
            sessionId: 'session_1', scope: 'workspace' })[0]?.status).toBe('unavailable');
        const rows = buildBrowserLaunchpadRows({ launcherSnapshot: { ...launcherSnapshot, targets: [registration] } });
        expect(rows).toEqual([]);
        expect(selectRunningServiceForEndedPreview(rows, localPreviewTarget)).toBeNull();
    });

    it('offers the workspace’s declared Services that are not running, in the Services sections', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');
        const declared = {
            id: 'managed:lumen-docs',
            source: 'managed_service',
            machineId: 'machine_1',
            sessionId: 'session_1',
            title: 'Lumen docs',
            subtitle: 'node fixture.mjs 42512',
            cwd: '/repo',
            workspace: { serverId: 'home', machineId: 'machine_1', workspaceId: 'ws_1', rootPath: '/repo' },
            declaration: { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'Lumen docs' } },
            serviceState: 'stopped',
            confidence: 'high',
            state: 'available',
            actions: ['start'],
        } satisfies LocalServiceLauncherSnapshotV1['targets'][number];
        const rows = buildBrowserLaunchpadRows({ launcherSnapshot: { ...launcherSnapshot, targets: [launcherSnapshot.targets[0], declared] } });
        // Running first, then what can be started: the same rows and sections Local services shows.
        expect(rows.map((row) => [row.id, row.section])).toEqual([
            ['service:launcher_preview', 'running'],
            ['service:managed:lumen-docs', 'ready'],
        ]);
        expect(rows[1]?.serviceRow).toMatchObject({ id: 'managed:lumen-docs', primaryAction: { kind: 'start' } });
        expect(rows[1]?.target).toBeNull();
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

        // Running services are the Local services rows (carried as `serviceRow`); a stale one is not
        // listed as a dead launchpad row (it stays in Local services with its own state).
        expect(rows.map((row) => row.id)).toEqual([
            'service:launcher_preview',
            'pluginExternalUrl:browserTarget:acme.preview:previewPane',
            'recent:preview_recent',
        ]);
        expect(rows[0]).toMatchObject({
            section: 'running',
            title: 'Vite app',
            disabledReason: null,
            target: localPreviewTarget,
        });
        expect(rows[0]?.serviceRow).toMatchObject({ id: 'launcher_preview', status: 'running' });
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


    describe('the running Service an ended preview can open again', () => {
        const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
        const endedDeclared = {
            kind: 'localServicePreview',
            targetId: 'preview_old',
            machineId: 'machine_1',
            display: { title: 'Web', addressLabel: 'localhost:42512' },
            serviceTarget: { kind: 'managed_service', managedServiceId: 'instance_old', machineId: 'machine_1', cwd: '/repo', declaration },
        } satisfies BrowserViewTargetV1;
        const endedScanned = {
            kind: 'localServicePreview',
            targetId: 'preview_scanned_old',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Lumen', addressLabel: '127.0.0.1:42511' },
        } satisfies BrowserViewTargetV1;
        const snapshot = (targets: LocalServiceLauncherSnapshotV1['targets']) => ({
            v: 1, machineId: 'machine_1', sessionId: 'session_1', updatedAt: 1_000, targets,
        }) satisfies LocalServiceLauncherSnapshotV1;
        const declaredRunning: LocalServiceLauncherSnapshotV1['targets'][number] = {
            id: 'managed:instance_new', source: 'managed_service', machineId: 'machine_1', title: 'web', subtitle: 'localhost:42512',
            sourceClass: { kind: 'managed_service', managedServiceId: 'instance_new' }, cwd: '/repo', declaration,
            serviceState: 'running', endpointUrl: 'http://127.0.0.1:42512/', confidence: 'high', state: 'available', actions: ['register_preview'],
        };
        const scannedRunning: LocalServiceLauncherSnapshotV1['targets'][number] = {
            id: 'inventory:entry_new', source: 'inventory_entry', machineId: 'machine_1', sessionId: 'session_1', title: 'node', subtitle: '127.0.0.1:42511',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry_new' }, endpointUrl: 'http://127.0.0.1:42511/',
            confidence: 'high', state: 'available', actions: ['register_preview'],
        };

        it('finds the current occurrence of the same declared Service, not another Service on the machine', async () => {
            const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('./suggestions');
            const rows = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([
                { ...scannedRunning },
                { ...declaredRunning },
            ]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(rows, endedDeclared)?.id).toBe('managed:instance_new');
            const otherDeclaration = { ...declaredRunning, declaration: { ...declaration, selection: { kind: 'manifest', name: 'api' } } } satisfies LocalServiceLauncherSnapshotV1['targets'][number];
            const without = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([otherDeclaration]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(without, endedDeclared)).toBeNull();
        });

        it('does not substitute a replacement process or project on the same machine and port', async () => {
            const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('./suggestions');
            const running = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([
                { ...scannedRunning, title: 'Different application', cwd: '/another-project' },
            ]), nowMs: 2_000 });
            expect(running).toHaveLength(1);
            expect(selectRunningServiceForEndedPreview(running, endedScanned)).toBeNull();
            expect(selectRunningServiceForEndedPreview(running, { ...endedScanned, machineId: 'machine_2' })).toBeNull();
            expect(selectRunningServiceForEndedPreview(running, { ...endedScanned, display: { title: 'Lumen', addressLabel: '127.0.0.1:42599' } })).toBeNull();
            const stopped = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([{ ...scannedRunning, state: 'stale' }]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(stopped, endedScanned)).toBeNull();
        });

        it('finds the exact registered preview while it is running, but not once it stopped', async () => {
            const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('./suggestions');
            const registered: LocalServiceLauncherSnapshotV1['targets'][number] = {
                id: 'preview:scanned_original', source: 'registered_preview', machineId: 'machine_1', sessionId: 'session_1',
                sourceClass: { kind: 'registered_preview', previewId: endedScanned.targetId },
                title: 'Lumen', subtitle: '127.0.0.1:42511', browserTarget: endedScanned,
                confidence: 'high', state: 'available', actions: ['open_preview'],
            };
            // The listener carries its admitted preview; a retained registration alone is not live.
            const running = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([{ ...scannedRunning, browserTarget: endedScanned }, registered]), nowMs: 2_000 });
            expect(running.map(row => row.id)).toEqual(['service:inventory:entry_new']);
            expect(selectRunningServiceForEndedPreview(running, endedScanned)?.browserTarget).toEqual(endedScanned);
            const stopped = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([registered]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(stopped, endedScanned)).toBeNull();
        });
    });
});
