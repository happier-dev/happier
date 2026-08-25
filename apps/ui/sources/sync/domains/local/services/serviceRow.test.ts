import { describe, expect, it } from 'vitest';

import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

import { buildLocalServiceRows } from './serviceRow';

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
            launchTargets: [openableTarget({ id: 'inventory:entry-b', sessionId: 'session-other' })],
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
});
