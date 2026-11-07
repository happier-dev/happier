import { describe, expect, it } from 'vitest';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

import { buildLocalServiceRows, groupLocalServiceRowsBySection, selectLocalServiceRunningCount, selectLocalServiceRowForInventoryEntry, selectRunningOpenTargetOnPort } from './serviceRow';

function inventoryRow(overrides: Partial<LocalServiceInventoryRow> = {}): LocalServiceInventoryRow {
    return {
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        state: 'listening',
        source: 'detected',
        confidence: 'high',
        provenance: {
            process: { pid: 400, lineagePids: [400], command: 'vite', cwd: '/repo/web', redacted: true },
            workspace: { path: '/repo/web', association: 'process_tree' },
        },
        presentation: { addressLabel: 'localhost:5173', displayName: 'Vite' },
        ...overrides,
    } as LocalServiceInventoryRow;
}

function openableTarget(overrides: Partial<LocalServiceLaunchTarget> = {}): LocalServiceLaunchTarget {
    return {
        id: 'inventory:entry-a',
        source: 'inventory_entry',
        sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry-a' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Vite',
        subtitle: 'localhost:5173',
        confidence: 'high',
        state: 'available',
        actions: ['open'],
        browserTarget: {
            kind: 'externalUrl',
            targetId: 'inventory-loopback:entry-a',
            url: 'http://127.0.0.1:5173/',
            display: { title: 'Vite', addressLabel: 'localhost:5173' },
        },
        ...overrides,
    } as LocalServiceLaunchTarget;
}

function packageTarget(overrides: Partial<LocalServiceLaunchTarget> = {}): LocalServiceLaunchTarget {
    return {
        id: 'package:web:dev',
        source: 'package_script',
        machineId: 'machine-a',
        title: 'web:dev',
        subtitle: '/repo/web',
        confidence: 'medium',
        state: 'unavailable',
        unavailableReason: 'launch_unavailable',
        actions: [],
        ...overrides,
    } as LocalServiceLaunchTarget;
}

describe('selectLocalServiceRowForInventoryEntry', () => {
    it('selects a Services port without mistaking an unrelated managed row for an inventory identity', () => {
        const unrelated = LocalServiceLaunchTargetV1Schema.parse(openableTarget({
            id: 'other-managed-service', source: 'managed_service', serviceState: 'running', sessionId: undefined,
            sourceClass: { kind: 'managed_service', managedServiceId: 'other' },
            subtitle: 'localhost:9999', endpointUrl: 'http://127.0.0.1:9999',
            browserTarget: { kind: 'externalUrl', targetId: 'other', url: 'http://127.0.0.1:9999' },
        }));
        const listener = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ sessionId: undefined }));
        const rows = buildLocalServiceRows({ inventoryRows: [inventoryRow()], launchTargets: [unrelated, listener],
            sessionId: null, scope: 'machine' });
        expect(rows[0]?.target.id).toBe(unrelated.id);
        expect(selectLocalServiceRowForInventoryEntry(rows, { port: 5173 })?.target).toBe(listener);
        // Processes still uses the exact inventory binding before the absorbed-binding port fallback.
        expect(selectLocalServiceRowForInventoryEntry(rows, { port: 9999, inventoryEntryId: 'entry-a' })?.target).toBe(listener);
        expect(selectLocalServiceRowForInventoryEntry(rows, { port: 8888 })).toBeNull();
    });
});

describe('buildLocalServiceRows', () => {
    it('adds checkout context only where the title and command collide', () => {
        const targets = ['/repo/a', '/repo/b', '/repo/unique'].map((cwd, index) => packageTarget({
            id: `script-${index}`, cwd, title: index === 2 ? 'api:dev' : 'web:dev', commandPreview: 'pnpm run dev',
        }));
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: targets, sessionId: null, scope: 'machine' });
        expect(rows.map(row => row.distinguishingWorkspaceLabel)).toEqual(['/repo/a', '/repo/b', undefined]);
    });
    it.each(['managed_service_native_state_unknown', 'managed_service_native_cleanup_unconfirmed'] as const)(
        'keeps %s distinct from running-unhealthy and preserves the exact manage target', reason => {
            const uncertain = openableTarget({ source: 'managed_service', serviceState: 'unhealthy', unavailableReason: reason,
                sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' }, actions: ['manage'] });
            const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [uncertain], sessionId: null, scope: 'workspace' });
            expect(row).toMatchObject({ status: 'unavailable', reasonCode: reason, primaryAction: null,
                target: { actions: ['manage'], sourceClass: { managedServiceId: 'native-instance' } } });
            expect(selectLocalServiceRunningCount([row!])).toBe(0);
            const [running] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{ ...uncertain, unavailableReason: undefined }], sessionId: null, scope: 'workspace' });
            expect(running?.status).toBe('running');
        },
    );
    it('keeps unavailable native custody distinct from a stopped declaration and offers no Start', () => {
        const target = packageTarget({ source: 'managed_service', workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'checkout', rootPath: '/repo' },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
            unavailableReason: 'project_service_binding_unavailable' });
        const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        expect(row).toMatchObject({ status: 'unavailable', primaryAction: null, reasonCode: 'project_service_binding_unavailable' });
    });
    it('does not join an unrelated listener solely from a launcher display id', () => {
        const rows = buildLocalServiceRows({ inventoryRows: [inventoryRow()], launchTargets: [openableTarget({ sourceClass: undefined })], sessionId: 'session-a', scope: 'workspace' });
        expect(rows[0]?.listeningListenerKey).toBeUndefined();
        const projected = buildLocalServiceRows({ inventoryRows: [inventoryRow()], launchTargets: [openableTarget({
            id: 'opaque-target', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry-a' },
        })], sessionId: 'session-a', scope: 'workspace' });
        expect(projected[0]?.listeningListenerKey).toBeDefined();
    });
    it('does not report an available package launcher as a running listener without source-class metadata', () => {
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [packageTarget({ state: 'available', actions: ['start'] })], sessionId: 'session-a', scope: 'workspace' });
        expect(rows[0]?.status).toBe('stopped');
        expect(selectLocalServiceRunningCount(rows)).toBe(0);
    });

    it.each(['managed_service', 'package_script'] as const)('retains a stale %s declaration without presenting a fresh Start', source => {
        const target = LocalServiceLaunchTargetV1Schema.parse(packageTarget({ source, state: 'stale', actions: [],
            workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'checkout', rootPath: '/repo' },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } } }));
        const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        expect(row).toMatchObject({ id: target.id, status: 'stale', primaryAction: null });
        expect(groupLocalServiceRowsBySection([row!])).toHaveLength(1);
    });

    it('keeps a pending binding distinct from an unavailable declaration and offers no Start', () => {
        const target = LocalServiceLaunchTargetV1Schema.parse(packageTarget({ source: 'managed_service',
            workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'checkout', rootPath: '/repo' },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
            unavailableReason: 'project_service_binding_pending' }));
        const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        expect(row).toMatchObject({ status: 'loading', primaryAction: null });
        expect(groupLocalServiceRowsBySection([row!])[0]?.section).toBe('ready');
        expect(selectLocalServiceRunningCount([row!])).toBe(0);
    });

    it.each(['project_service_binding_pending', 'project_service_binding_unavailable'] as const)(
        'keeps an observed failure visible during %s without granting Start authority', unavailableReason => {
            const target = LocalServiceLaunchTargetV1Schema.parse(packageTarget({ source: 'managed_service', serviceState: 'failed',
                workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'checkout', rootPath: '/repo' },
                declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
                diagnostics: [{ code: 'native_service_output', severity: 'info', message: 'service exited' }], unavailableReason }));
            const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
            expect(row).toMatchObject({ status: 'failed', primaryAction: null, target: { diagnostics: target.diagnostics } });
            const [offline] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{ ...target, state: 'stale' }], sessionId: null, scope: 'workspace' });
            expect(offline?.status).toBe('stale');
        },
    );

    it('finds only the openable instance on the failed target\'s actual Machine and qualified checkout', () => {
        const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const declared = LocalServiceLaunchTargetV1Schema.parse(packageTarget({ id: 'declared:web', source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'project-service:web' }, workspace,
            declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } } }));
        const listening = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ workspace }));
        const unrelatedMachine = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ id: 'source-listener', machineId: 'source-machine',
            workspace: { ...workspace, machineId: 'source-machine' } }));
        const unrelatedCheckout = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ id: 'other-checkout',
            workspace: { ...workspace, workspaceId: 'other' } }));
        const unrelatedHome = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ id: 'other-home',
            workspace: { ...workspace, serverId: 'home-other' } }));
        const unrelatedRoot = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ id: 'other-root',
            workspace: { ...workspace, rootPath: '/other' } }));
        const mismatchedMachine = LocalServiceLaunchTargetV1Schema.parse(openableTarget({ id: 'inconsistent-machine',
            workspace: { ...workspace, machineId: 'other-machine' } }));
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [unrelatedMachine, unrelatedCheckout, unrelatedHome,
            unrelatedRoot, mismatchedMachine, listening, declared], sessionId: null, scope: 'workspace' });
        expect(selectRunningOpenTargetOnPort(rows, 5173, declared)).toEqual(listening);
        expect(selectRunningOpenTargetOnPort(rows, 3005, declared)).toBeNull();
        expect(selectRunningOpenTargetOnPort(rows.filter((row) => row.id !== listening.id), 5173, declared)).toBeNull();
        expect(selectRunningOpenTargetOnPort(rows, 5173, LocalServiceLaunchTargetV1Schema.parse({ ...declared, workspace: undefined }))).toBeNull();
        expect(selectRunningOpenTargetOnPort(rows, 5173, LocalServiceLaunchTargetV1Schema.parse({ ...declared, machineId: 'other-machine' }))).toBeNull();
        expect(selectRunningOpenTargetOnPort(buildLocalServiceRows({ inventoryRows: [], launchTargets: [
            LocalServiceLaunchTargetV1Schema.parse({ ...listening, workspace: undefined }), declared,
        ], sessionId: null, scope: 'workspace' }), 5173, declared)).toBeNull();
        expect(selectRunningOpenTargetOnPort(rows, 5173, listening)).toBeNull();
        const projectedRows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [listening],
            rowIdsByTargetId: new Map([[listening.id, 'source-declaration']]), sessionId: null, scope: 'workspace' });
        expect(selectRunningOpenTargetOnPort(projectedRows, 5173, listening)).toBeNull();
    });
    it('carries the detected service identity and address instead of exposing its raw process command', () => {
        const rows = buildLocalServiceRows({ inventoryRows: [inventoryRow()], launchTargets: [openableTarget()], sessionId: 'session-a', scope: 'workspace' });
        expect(rows[0]?.serviceLabel).toBe('Vite');
        expect(rows[0]?.addressLabel).toBe('localhost:5173');
    });
    it('keeps an unaccepted package suggestion inert instead of diverting Start to a Session terminal', () => {
        const target = packageTarget({ sourceClass: { kind: 'package_script', runTargetId: 'web:dev', packageName: 'web', scriptName: 'dev', cwd: '/repo/web' } });
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: 'session-a', scope: 'workspace' });
        expect(rows[0]?.primaryAction).toBeNull();
        expect(rows[0]?.status).toBe('stopped');
        expect(selectLocalServiceRunningCount(rows)).toBe(0);
    });
    it.each(['package_script', 'managed_service'] as const)('offers a fresh reviewed Start intent for a qualified %s declaration without inventing executable actions', source => {
        const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const target = packageTarget({ source,
            sourceClass: source === 'package_script'
                ? { kind: 'package_script', runTargetId: 'project-service:selected', packageName: 'web', scriptName: 'dev', cwd: '/repo/web' }
                : { kind: 'managed_service', managedServiceId: 'project-service:selected' },
            workspace, declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } },
        });
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        expect(rows[0]?.primaryAction).toEqual({ kind: 'start', target });
        expect(target.actions).toEqual([]);
        expect(selectLocalServiceRunningCount(rows)).toBe(0);
        expect(groupLocalServiceRowsBySection(rows)[0]?.section).toBe('ready');
    });
    it.each([
        { serviceState: 'running', status: 'running', section: 'running', canStart: false },
        { serviceState: 'healthy', status: 'running', section: 'running', canStart: false },
        { serviceState: 'unhealthy', status: 'running', section: 'running', canStart: false },
        { serviceState: 'detecting', status: 'running', section: 'running', canStart: false },
        { serviceState: 'stopped', status: 'stopped', section: 'ready', canStart: true },
        // A failed start is its own group: it is not "ready to start".
        { serviceState: 'failed', status: 'failed', section: 'failed', canStart: true },
        { serviceState: 'stopping', status: 'stopping', section: 'running', canStart: false },
    ] as const)('groups a managed declaration by its $serviceState lifetime even with retained listening inventory', ({ serviceState, status, section, canStart }) => {
        // feed.ts#managedTarget publishes launcher availability independently
        // of the actual supervisor phase, including stopped/failed records.
        const target = packageTarget({ source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'actual-instance', inventoryEntryId: 'entry-a' },
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'worker' } },
            state: 'available', serviceState, actions: ['manage'],
        });
        const rows = buildLocalServiceRows({ inventoryRows: [inventoryRow()], launchTargets: [target], sessionId: null, scope: 'workspace' });
        expect(rows[0]?.primaryAction).toEqual(canStart ? { kind: 'start', target } : null);
        expect(rows[0]?.status).toBe(status);
        expect(groupLocalServiceRowsBySection(rows)[0]?.section).toBe(section);
        // The header's count and the "Running" group are one fact: a supervised worker with no
        // listener is running (the pane never says "Nothing running" above a Running list).
        expect(selectLocalServiceRunningCount(rows)).toBe(status === 'running' ? 1 : 0);
    });
    it('groups a retry from the launcher state and returns a failed retry to its failure section', () => {
        const target = packageTarget({ source: 'managed_service',
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'worker' } },
            state: 'available', serviceState: 'failed', actions: ['manage'] });
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        expect(groupLocalServiceRowsBySection(rows)[0]?.section).toBe('failed');
        const retry = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{ ...target,
            state: 'starting', serviceState: 'starting', actions: [] }], sessionId: null, scope: 'workspace' });
        expect(retry[0]?.status).toBe('starting');
        expect(groupLocalServiceRowsBySection(retry)[0]?.section).toBe('running');
        expect(groupLocalServiceRowsBySection(rows)[0]?.section).toBe('failed');
    });
    it('projects the declaring file, a truthful address note and no placeholder refusal beside Start', () => {
        const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const managed = (id: string, overrides: Partial<LocalServiceLaunchTarget>) => packageTarget({ id, source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: id }, workspace, ...overrides });
        const rows = buildLocalServiceRows({ inventoryRows: [], sessionId: null, scope: 'workspace', launchTargets: [
            managed('jobs', { state: 'available', serviceState: 'running', actions: ['manage'], declaration: { workspaceRefId: 'accepted',
                selection: { kind: 'native', source: { kind: 'native', tool: 'procfile', file: 'apps/Procfile', target: 'jobs' } } } }),
            managed('server', { state: 'available', serviceState: 'detecting', actions: ['manage'],
                declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'server' } } }),
            managed('web', { state: 'available', serviceState: 'running', actions: ['manage'], endpointUrl: 'http://localhost:5173/' }),
            managed('docs', { declaration: { workspaceRefId: 'accepted', selection: { kind: 'native',
                source: { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'docs' } } } }),
        ] });
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(byId.get('jobs')).toMatchObject({ sourceBadge: 'Procfile', addressNote: 'none', status: 'running' });
        expect(byId.get('server')).toMatchObject({ sourceBadge: 'project.json', addressNote: 'waiting', status: 'running' });
        // An observed endpoint is never overridden by a note, and a service with no declaration has no badge.
        expect(byId.get('web')).toMatchObject({ sourceBadge: null, addressNote: null, addressLabel: 'localhost:5173' });
        // The feed's `launch_unavailable` placeholder is not a refusal while Start is offered.
        expect(byId.get('docs')).toMatchObject({ primaryAction: { kind: 'start' }, reasonCode: null, sourceBadge: 'compose.yaml', status: 'stopped' });
    });

    it('orders running/this-session → workspace → machine → suggestions and never filters in-scope rows', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow()],
            launchTargets: [
                openableTarget(),
                packageTarget(),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        // this-session openable row first, package suggestion last
        expect(rows[0]?.id).toBe('inventory:entry-a');
        expect(rows[0]?.scope).toBe('thisSession');
        expect(rows[rows.length - 1]?.scope).toBe('suggestion');
        expect(rows[rows.length - 1]?.id).toBe('package:web:dev');
        // never filters in scope
        expect(rows.length).toBe(2);
    });

    it('carries title, portLabel, host, workspaceLabel, status and exactly one primaryAction per row', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow()],
            launchTargets: [openableTarget()],
            sessionId: 'session-a',
            scope: 'workspace',
        });
        const row = rows[0];
        expect(row?.title).toBe('Vite');
        expect(row?.portLabel).toBe(':5173');
        expect(row?.host).toBe('127.0.0.1');
        expect(row?.scheme).toBeNull();
        expect(row?.workspaceLabel).toBe('/repo/web');
        expect(row?.status).toBe('running');
        expect(row?.primaryAction?.kind).toBe('open');
    });

    it('carries the daemon endpoint scheme for row presentation', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({
                endpoint: {
                    scheme: 'https',
                    host: '127.0.0.1',
                    port: 8443,
                    probeState: 'ready',
                    probedAt: 2_000,
                },
                port: 8443,
            })],
            launchTargets: [openableTarget({ id: 'inventory:entry-a', subtitle: 'localhost:8443' })],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(rows[0]?.scheme).toBe('https');
        expect(rows[0]?.host).toBe('127.0.0.1');
        expect(rows[0]?.portLabel).toBe(':8443');
    });

    it('labels terminate identity as pid-only when the scanned process has no start time', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({
                provenance: {
                    process: { pid: 400, lineagePids: [400], command: 'vite', cwd: '/repo/web', redacted: true },
                    workspace: { path: '/repo/web', association: 'process_tree' },
                },
            })],
            launchTargets: [openableTarget({ actions: ['open', 'terminate_detected'] })],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(rows[0]?.terminateIdentityConfidence).toBe('pid_only');
    });

    it('labels terminate identity as full when the scanned process carries a start time', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({
                provenance: {
                    process: {
                        pid: 400,
                        processStartTimeMs: 1_717_171_717_000,
                        lineagePids: [400],
                        command: 'vite',
                        cwd: '/repo/web',
                        redacted: true,
                    },
                    workspace: { path: '/repo/web', association: 'process_tree' },
                },
            })],
            launchTargets: [openableTarget({ actions: ['open', 'terminate_detected'] })],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(rows[0]?.terminateIdentityConfidence).toBe('full');
    });

    it('emits an inert (null primaryAction) suggestion row for a package script (D6)', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [],
            launchTargets: [packageTarget()],
            sessionId: null,
            scope: 'workspace',
        });
        expect(rows[0]?.scope).toBe('suggestion');
        expect(rows[0]?.primaryAction).toBeNull();
        expect(rows[0]?.reasonCode).toBe('launch_unavailable');
    });

    it('places non-session workspace services in the workspace band', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({ id: 'entry-b' })],
            launchTargets: [openableTarget({ id: 'inventory:entry-b', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry-b' }, sessionId: 'session-other' })],
            sessionId: 'session-a',
            scope: 'workspace',
        });
        expect(rows[0]?.scope).toBe('workspace');
    });

    it('does not synthesize daemon launch targets from inventory-only rows', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({ id: 'entry-a' })],
            launchTargets: [],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(rows).toEqual([]);
    });

    it('does not duplicate a detected entry already covered by a launch target (single ranked model, FIX-B)', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({ id: 'entry-a' })],
            launchTargets: [openableTarget({ id: 'inventory:entry-a' })],
            sessionId: 'session-a',
            scope: 'workspace',
        });
        expect(rows.filter((row) => row.id === 'inventory:entry-a').length).toBe(1);
    });

    it('keeps referentially-equal rows across snapshots differing only in updatedAt (keep-last-good)', () => {
        const inventoryRows = [inventoryRow()];
        const launchTargets = [openableTarget()];
        const first = buildLocalServiceRows({ inventoryRows, launchTargets, sessionId: 'session-a', scope: 'workspace' });
        const second = buildLocalServiceRows({ inventoryRows, launchTargets, sessionId: 'session-a', scope: 'workspace' });
        expect(second[0]?.id).toBe(first[0]?.id);
        expect(second[0]).toEqual(first[0]);
    });

    it('sections rows by what you can do: running here, ready to start, elsewhere on the machine (lab S)', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow({ id: 'mine' }), inventoryRow({ id: 'other', port: 8080 })],
            launchTargets: [
                packageTarget({ id: 'package:docs', title: 'docs',
                    workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' },
                    declaration: { workspaceRefId: 'accepted', selection: { kind: 'native',
                        source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } } } }),
                openableTarget({ id: 'inventory:mine', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'mine' }, sessionId: 'session-a' }),
                openableTarget({ id: 'inventory:stopped', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'stopped' }, sessionId: 'session-a', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] }),
                openableTarget({ id: 'inventory:other', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'other' }, sessionId: 'session-b' }),
            ],
            sessionId: 'session-a',
            scope: 'machine',
        });

        const sections = groupLocalServiceRowsBySection(rows);

        // Ready to start holds only what can start: the stopped listener has no start action, so it is
        // not offered as something to start.
        expect(sections.map((section) => [section.section, section.rows.map((row) => row.id)])).toEqual([
            ['running', ['inventory:mine']],
            ['ready', ['package:docs']],
            ['elsewhere', ['inventory:other']],
        ]);
        // The machine count includes actual listeners elsewhere, not only the session section.
        expect(selectLocalServiceRunningCount(rows)).toBe(2);
    });

    function boundEntry(id: string, host: string, port: number, command?: string, pageTitle?: string): LocalServiceInventoryRow {
        const kind = host === '0.0.0.0' || host === '::' ? 'wildcard' : 'loopback';
        return inventoryRow({
            id,
            port,
            address: { kind, host, family: host.includes(':') ? 'ipv6' : 'ipv4' },
            provenance: command
                ? { process: { pid: 7, lineagePids: [7], command, redacted: true } }
                : undefined,
            presentation: pageTitle ? { pageTitle } : undefined,
        } as Partial<LocalServiceInventoryRow>);
    }

    function boundTarget(id: string, title: string): LocalServiceLaunchTarget {
        // The daemon's subtitle is the entry's address label; the title falls back to it.
        return openableTarget({ id: `inventory:${id}`, sourceClass: { kind: 'inventory_entry', inventoryEntryId: id }, title, subtitle: undefined, sessionId: undefined });
    }

    it('shows one row per port however many addresses it is bound to (::, 0.0.0.0, 127.0.0.1)', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [
                boundEntry('any6', '::', 18829),
                boundEntry('any4', '0.0.0.0', 18829),
                boundEntry('loop', '127.0.0.1', 18829),
                boundEntry('vite', '127.0.0.1', 5173),
            ],
            launchTargets: [
                boundTarget('any6', ':::18829'),
                boundTarget('any4', '0.0.0.0:18829'),
                boundTarget('loop', 'localhost:18829'),
                boundTarget('vite', 'Vite'),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(rows.map((row) => row.portLabel).sort()).toEqual([':18829', ':5173']);
        // The loopback binding is the one kept: it is the address that opens on this machine.
        expect(rows.find((row) => row.portLabel === ':18829')?.host).toBe('127.0.0.1');
    });

    it('names a service from its process, falling back to localhost:<port>, never a raw bind address', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [
                boundEntry('ssh', '0.0.0.0', 44935, '/usr/bin/ssh -N -L *:44935:localhost:1 box'),
                boundEntry('cups', '::', 631),
                boundEntry('vite', '127.0.0.1', 5173, 'node /repo/node_modules/.bin/vite'),
            ],
            launchTargets: [
                boundTarget('ssh', '0.0.0.0:44935'),
                boundTarget('cups', ':::631'),
                boundTarget('vite', 'Vite'),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(rows.map((row) => row.title).sort()).toEqual(['Vite', 'localhost:631', 'ssh']);
    });

    it('gathers Happier’s own services into one quiet group that the running count leaves out', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [
                boundEntry('ui', '::', 19364, 'ssh -N -L *:19364:localhost:24296 happier-dev-target-mac', 'Happier (internal dev)'),
                boundEntry('daemon', '127.0.0.1', 34123, '/usr/bin/node /home/u/.happier-stack/workspace/0.3/apps/cli/.runner-snapshots/x/index.mjs daemon start-sync'),
                boundEntry('vite', '127.0.0.1', 5173, 'node /repo/node_modules/.bin/vite'),
            ],
            launchTargets: [
                { ...boundTarget('ui', 'Happier (internal dev)'), kind: 'happier' },
                { ...boundTarget('daemon', 'localhost:34123'), kind: 'happier' },
                boundTarget('vite', 'Vite'),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        const sections = groupLocalServiceRowsBySection(rows);
        expect(sections.map((section) => [section.section, section.rows.length])).toEqual([
            ['running', 1],
            ['happier', 2],
        ]);
        expect(selectLocalServiceRunningCount(rows)).toBe(1);
    });

    it('keeps user services whose titles or commands mention Happier and counts running machine rows', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [boundEntry('demo', '127.0.0.1', 5173, 'node /repo/.happier/demo.js', 'Happier demo')],
            launchTargets: [{ ...boundTarget('demo', 'Happier demo'), sessionId: undefined }],
            sessionId: 'session-a', scope: 'machine',
        });
        expect(rows[0]?.internal).toBe(false);
        expect(selectLocalServiceRunningCount(rows)).toBe(1);
    });

    it('keeps preview access without counting registration, startability, or stale bindings as listening evidence', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [boundEntry('live', '127.0.0.1', 5173), { ...boundEntry('stale', '127.0.0.1', 8080), state: 'stale' }],
            launchTargets: [
                boundTarget('live', 'App'),
                { ...boundTarget('stale', 'Old app'), state: 'stale' },
                openableTarget({ id: 'preview:app', source: 'registered_preview', sourceClass: { kind: 'registered_preview', previewId: 'app' } }),
                openableTarget({ id: 'managed:app', source: 'managed_service', sourceClass: undefined }),
                packageTarget({ state: 'available', actions: ['start'] }),
            ],
            sessionId: 'session-a', scope: 'workspace',
        });
        expect(rows.find((row) => row.id === 'preview:app')?.primaryAction?.kind).toBe('open');
        expect(rows.filter(row => row.status === 'running').map(row => row.id)).toEqual(['inventory:live']);
        expect(selectLocalServiceRunningCount(rows)).toBe(1);
    });

    it('prefers a live user listener over a stale internal binding that reused the same port', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [{ ...boundEntry('old', '127.0.0.1', 5173), state: 'stale' }, boundEntry('new', '::', 5173)],
            launchTargets: [{ ...boundTarget('old', 'Happier'), kind: 'happier', state: 'stale' }, boundTarget('new', 'User app')],
            sessionId: 'session-a', scope: 'workspace',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'inventory:new', internal: false });
        expect(selectLocalServiceRunningCount(rows)).toBe(1);
    });

    it('keeps a distinct live user binding when Happier also listens on the same local port', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [boundEntry('internal', '127.0.0.1', 5173), boundEntry('user', '127.0.0.2', 5173)],
            launchTargets: [{ ...boundTarget('internal', 'Happier'), kind: 'happier' }, boundTarget('user', 'User app')],
            sessionId: 'session-a', scope: 'workspace',
        });
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === 'inventory:user')).toMatchObject({ internal: false, primaryAction: { kind: 'open' } });
        expect(selectLocalServiceRunningCount(rows)).toBe(1);
    });

    it('does not trust an editable preview icon kind as daemon ownership evidence', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [],
            launchTargets: [openableTarget({ id: 'preview:user', source: 'registered_preview', sourceClass: { kind: 'registered_preview', previewId: 'user' }, kind: 'happier' })],
            sessionId: 'session-a', scope: 'workspace',
        });
        expect(rows[0]).toMatchObject({ internal: false, primaryAction: { kind: 'open' } });
        expect(selectLocalServiceRunningCount(rows)).toBe(0);
    });

    it('offers nothing to start that cannot start: dead listeners and refused scripts are not shown', () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [],
            launchTargets: [
                packageTarget({ id: 'package:refused' }),
                openableTarget({ id: 'inventory:ssh', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'ssh' }, title: 'localhost:22', state: 'unavailable', unavailableReason: 'preview_registration_unavailable', actions: [] }),
                packageTarget({ id: 'package:docs', title: 'docs',
                    workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' },
                    declaration: { workspaceRefId: 'accepted', selection: { kind: 'native',
                        source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } } } }),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(groupLocalServiceRowsBySection(rows).map((section) => [section.section, section.rows.map((row) => row.id)])).toEqual([
            ['ready', ['package:docs']],
        ]);
    });

    it('names what a declared service runs from the Project definition: its command and the file the command comes from', () => {
        const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
        const manifestService = packageTarget({ id: 'managed:web', source: 'managed_service', title: 'web', workspace,
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'web' } } });
        const literalService = packageTarget({ id: 'managed:jobs', source: 'managed_service', title: 'jobs', workspace,
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'jobs' } } });
        const describeDeclaration = (declaration: NonNullable<LocalServiceLaunchTarget['declaration']>) =>
            declaration.selection.kind === 'manifest' && declaration.selection.name === 'web'
                ? { command: 'yarn dev', badge: 'package.json' }
                : null;
        const rows = buildLocalServiceRows({
            inventoryRows: [], launchTargets: [manifestService, literalService], sessionId: null, scope: 'workspace', describeDeclaration,
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(byId.get('managed:web')).toMatchObject({ processLabel: 'yarn dev', sourceBadge: 'package.json' });
        // A declaration the definition cannot describe keeps the manifest as its source and invents no command.
        expect(byId.get('managed:jobs')).toMatchObject({ processLabel: null, sourceBadge: 'project.json' });
    });
});
