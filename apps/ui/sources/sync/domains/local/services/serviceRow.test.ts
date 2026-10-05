import { describe, expect, it } from 'vitest';

import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

import { buildLocalServiceRows, groupLocalServiceRowsBySection, selectLocalServiceRunningCount } from './serviceRow';

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

describe('buildLocalServiceRows', () => {
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

    it('carries the detected service identity and address instead of exposing its raw process command', () => {
        const rows = buildLocalServiceRows({ inventoryRows: [inventoryRow()], launchTargets: [openableTarget()], sessionId: 'session-a', scope: 'workspace' });
        expect(rows[0]?.serviceLabel).toBe('Vite');
        expect(rows[0]?.addressLabel).toBe('localhost:5173');
    });
    it('offers a package script as a new-terminal intent, never Local services Start', () => {
        const target = packageTarget({ sourceClass: { kind: 'package_script', runTargetId: 'web:dev', packageName: 'web', scriptName: 'dev', cwd: '/repo/web' } });
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: 'session-a', scope: 'workspace' });
        expect(rows[0]?.primaryAction).toEqual({ kind: 'run_script', target });
        expect(rows[0]?.status).toBe('stopped');
        expect(selectLocalServiceRunningCount(rows)).toBe(0);
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
                packageTarget({ id: 'package:docs', title: 'docs', state: 'available', unavailableReason: undefined, actions: ['start'] }),
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
                packageTarget({ id: 'package:docs', title: 'docs', state: 'available', unavailableReason: undefined, actions: ['start'] }),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });

        expect(groupLocalServiceRowsBySection(rows).map((section) => [section.section, section.rows.map((row) => row.id)])).toEqual([
            ['ready', ['package:docs']],
        ]);
    });
});
