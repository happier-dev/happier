import { describe, expect, it, vi } from 'vitest';

import { createLocalServicesDaemonRuntime } from './runtime';
import type { NormalizedLocalServiceInventorySnapshot } from './inventory/scanner';

function buildSnapshot(
    overrides: Partial<NormalizedLocalServiceInventorySnapshot> = {},
): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 1_000,
        refreshState: 'idle',
        diagnostics: [],
        entries: [{
            id: 'entry-1',
            machineId: 'machine-a',
            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            port: 5173,
            protocol: 'tcp',
            detectedAt: 1_000,
            lastSeenAt: 1_000,
            state: 'listening',
            source: 'detected',
            labels: [],
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            diagnostics: [],
            provenance: {
                process: {
                    pid: 400,
                    ppid: 300,
                    lineagePids: [400, 300, 1],
                    command: 'npm run dev',
                    cwd: '/repo/app',
                    redacted: true,
                },
            },
        }],
        ...overrides,
    };
}

describe('createLocalServicesDaemonRuntime', () => {
    it('does not scan when inventory is feature-disabled and preserves stale cached entries with diagnostics', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => false,
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('stale');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_dependency_disabled', severity: 'info' },
        ]);
    });

    it('refreshes inventory through the scanner and feeds managed detect-after-launch correlation', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev', cwd: '/repo/app' }],
                ]),
                workspaces: [{ id: 'workspace-a', path: '/repo' }],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_500 },
            routeName: 'plugin-a-web',
        });

        await runtime.refreshInventoryNow();

        expect(runtime.managedRegistry.getService('plugin-a:web')).toMatchObject({
            phase: 'running',
            inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
            port: 5173,
        });
    });
});
