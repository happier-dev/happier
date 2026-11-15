import { describe, expect, it } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { applyLocalServiceInventorySnapshot, createLocalServiceInventoryState } from '../../../../../../apps/ui/sources/sync/domains/local/services/inventory/store';
import { buildLocalServiceRows } from '../../../../../../apps/ui/sources/sync/domains/local/services/serviceRow';

import { createLocalServicesDaemonRuntime } from './runtime';
import { createLocalServiceEndpointEnricher } from './inventory/endpoint';
import { projectLocalServiceInventorySnapshotV1 } from './inventory/wire';

describe('Services inventory admission', () => {
    it('returns the endpoint owner reason when a detected web server cannot be opened', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', accountId: 'owner', inventoryEnabled: () => true, startLoop: false,
            endpointEnricher: createLocalServiceEndpointEnricher({ now: () => 2_000, probe: async () => false }),
            scan: async () => ({ listeners: [{ address: '127.0.0.1', port: 5173, pid: 100, protocol: 'tcp' }],
                processes: new Map([[100, { pid: 100, command: 'node vite' }]]), workspaces: [], diagnostics: [] }),
        });
        try {
            const snapshot = await runtime.refreshInventoryNow();
            expect(await runtime.previewRoutes.openOrCreate({ machineId: 'machine-a', inventoryEntryId: snapshot.entries[0]!.id }))
                .toEqual({ ok: false, reasonCode: 'endpoint_probe_failed' });
        } finally { await runtime.stop(); }
    });

    it('publishes web servers while preserving raw listener facts for native consumers, without probing on refresh', async () => {
        // C39: this exact product Shell command was listening in native inventory but absent
        // from Services because inline Python's HTTP server had no process classification.
        const shellCommand = `python3 -u -c 'import http.server,os,json;from pathlib import Path;Path("w95-shell-marker.txt").write_text("Q95 SHELL OWNED MARKER");s=http.server.ThreadingHTTPServer(("127.0.0.1",0),http.server.SimpleHTTPRequestHandler);d={"pid":os.getpid(),"port":s.server_port,"cwd":os.getcwd()};Path("w95-shell.json").write_text(json.dumps(d));print("Q95-SHELL-LISTENER",json.dumps(d),flush=True);s.serve_forever()'`;
        const commands = ['node vite', 'python3 -m http.server', shellCommand, 'python3 -u -m http.server', ...Array.from({ length: 109 }, (_, index) =>
            ['ssh -L 9000:localhost:22 host', 'tmux', 'chrome --remote-debugging-port=9222',
                'node worker.js', 'redis-server', 'claude', 'codex'][index % 7]!)];
        let scans = 0;
        let includeSecondServer = true;
        const probes: number[] = [];
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false, now: () => 2_000,
            endpointEnricher: createLocalServiceEndpointEnricher({ now: () => 2_000,
                probe: async ({ port, scheme }) => { probes.push(port); return scheme === 'http'; } }),
            scan: async () => {
                scans++;
                return {
                    listeners: commands.map((_, index) => ({ address: '127.0.0.1', port: 5_000 + index,
                        pid: 100 + index, protocol: 'tcp' as const })).filter((_, index) => includeSecondServer || index !== 1),
                    processes: new Map(commands.map((command, index) => [100 + index, { pid: 100 + index, command }])),
                    workspaces: [], diagnostics: [],
                };
            },
        });
        let publications = 0;
        const unsubscribe = runtime.inventoryRegistry.subscribe(() => { publications++; });
        try {
            const first = await runtime.refreshInventoryNow();
            expect(first.entries).toHaveLength(113);
            const launcher = LocalServiceLauncherSnapshotV1Schema.parse(await runtime.launcherRoutes.getSnapshot({ scope: 'machine' }));
            expect.soft(launcher.targets.filter(target => target.source === 'inventory_entry')).toHaveLength(4);
            expect.soft(runtime.getSummary()).toEqual({ v: 1, state: 'ready', runningCount: 4 });
            const rows = buildLocalServiceRows({ inventoryRows: first.entries, launchTargets: launcher.targets, scope: 'machine', sessionId: null });
            expect.soft(rows.filter(row => row.status === 'running').map(row => row.portLabel).sort()).toEqual([':5000', ':5001', ':5002', ':5003']);
            const client = applyLocalServiceInventorySnapshot(createLocalServiceInventoryState(),
                projectLocalServiceInventorySnapshotV1(first));
            expect(client.summary).toEqual(runtime.getSummary());
            expect(client.rowIds).toHaveLength(113);
            const firstPublicationCount = publications;
            const [native] = await Promise.all([runtime.refreshInventoryNow({ stage: 'native' }), runtime.refreshInventoryNow()]);
            expect(native.entries).toHaveLength(113);
            expect(scans).toBe(2);
            expect(publications).toBe(firstPublicationCount);
            includeSecondServer = false;
            await runtime.refreshInventoryNow();
            expect(runtime.getSummary()).toEqual({ v: 1, state: 'ready', runningCount: 3 });
            expect(publications).toBe(firstPublicationCount + 1);
            expect(scans).toBe(3);
            expect(probes).toEqual([]);
        } finally {
            unsubscribe();
            await runtime.stop();
        }
    });
});
