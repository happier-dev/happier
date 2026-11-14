import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { readProcessCensus, type ProcessStartIdentity } from '@/processes/census/processCensus';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { normalizeLocalServiceScan } from '../inventory/scanner';
import { scanPlatformLocalServices } from '../inventory/platform/scan';
import { createOsProcessControl } from './osProcessControl';
import { createTerminateDetectedService } from './terminate';
import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';

type Fixture = { root: ChildProcess; pids: number[]; targets: Array<{ pid: number; start?: ProcessStartIdentity }> };
let fixture: Fixture | null = null;

afterEach(async () => {
    const owned = fixture;
    fixture = null;
    if (!owned) return;
    await terminateProcessTree({ targets: owned.targets, tree: true, graceMs: 300 });
    await Promise.all(owned.pids.map(pid => waitForProcessExit(pid)));
});

async function spawnListenerTree(resistant: boolean) {
    const traps = resistant ? 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});' : '';
    const grandchild = [
        traps,
        'console.log(JSON.stringify({kind:"grandchild",pid:process.pid}));',
        'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = [
        'const { spawn } = require("node:child_process");',
        traps,
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {stdio:["ignore","inherit","ignore"]});`,
        'console.log(JSON.stringify({kind:"child",pid:process.pid}));',
        'setInterval(() => {}, 1000);',
    ].join('\n');
    const root = spawnInlineNodeTestProcess([
        'const { spawn } = require("node:child_process");',
        'const net = require("node:net");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(child)}], {stdio:["ignore","inherit","ignore"]});`,
        'const server = net.createServer();',
        'server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({kind:"listener",pid:process.pid,port:server.address().port})));',
    ].join('\n'), { stdio: ['ignore', 'pipe', 'pipe'] });
    if (!root.pid || !root.stdout) throw new Error('listener fixture failed to spawn');
    const owned: Fixture = { root, pids: [root.pid], targets: [{ pid: root.pid }] };
    fixture = owned;
    const stdout = root.stdout;
    let port = 0;
    await new Promise<void>((resolve, reject) => {
        let buffer = '';
        let stderr = '';
        const kinds = new Set<string>();
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`listener tree readiness failed: ${buffer} ${stderr}`));
        }, 10000);
        const cleanup = () => {
            clearTimeout(timer);
            stdout.off('data', onData);
            root.off('error', onError);
            root.off('exit', onExit);
            root.stderr?.off('data', onStderr);
        };
        const onStderr = (chunk: Buffer) => { stderr += chunk.toString(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = () => { cleanup(); reject(new Error(`listener exited before readiness: ${stderr}`)); };
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString();
            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                const value: unknown = JSON.parse(line);
                if (!value || typeof value !== 'object' || !('kind' in value) || typeof value.kind !== 'string'
                    || !('pid' in value) || typeof value.pid !== 'number') continue;
                kinds.add(value.kind);
                if (!owned.pids.includes(value.pid)) owned.pids.push(value.pid);
                if (value.kind === 'listener' && 'port' in value && typeof value.port === 'number') port = value.port;
            }
            if (port && kinds.size === 3) { cleanup(); resolve(); }
        };
        stdout.on('data', onData);
        root.stderr?.on('data', onStderr);
        root.on('error', onError);
        root.on('exit', onExit);
    });
    const census = await readProcessCensus({ freshness: 'fresh', pids: owned.pids });
    if (census.status !== 'ok') throw new Error(`real fixture census unavailable: ${census.reason}`);
    owned.targets = owned.pids.map(pid => {
        const row = census.rows.find(row => row.pid === pid);
        if (!row) throw new Error(`fixture member ${pid} not in census`);
        return { pid, start: row.start };
    });
    return { owned, port };
}

async function refreshInventory() {
    const now = Date.now();
    const scan = await scanPlatformLocalServices();
    if (scan.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
        throw new Error('real listener scan failed');
    }
    return normalizeLocalServiceScan({ machineId: 'fixture-machine', previous: null, now, ...scan });
}

describe('terminate_detected through the real listener and process boundaries', () => {
    it.each([false, true])('ends the listener and its whole tree, including resistant descendants=%s, and frees its TCP port', async resistant => {
        const { owned, port } = await spawnListenerTree(resistant);
        const snapshot = await refreshInventory();
        const entry = snapshot.entries.find(entry => entry.port === port && entry.provenance?.process?.pid === owned.root.pid);
        if (!entry) throw new Error('real listener absent from inventory');
        const request: LocalServiceActionRequestV1 = {
            requestId: 'fixture-terminate', action: 'terminate_detected', force: false,
            target: { kind: 'inventory_entry', machineId: 'fixture-machine', inventoryEntryId: entry.id },
        };
        const result = await createTerminateDetectedService(createOsProcessControl({ refreshInventory }), {
            graceMs: 300,
        })({ request, entry, now: Date.now() });
        expect(result).toEqual({ status: 'succeeded' });
        expect(await Promise.all(owned.pids.map(pid => waitForProcessExit(pid)))).toEqual([true, true, true]);

        // Binding the same socket independently proves that the actual listener released it.
        const rebound = createServer();
        await new Promise<void>((resolve, reject) => {
            rebound.once('error', reject);
            rebound.listen(port, '127.0.0.1', resolve);
        });
        await new Promise<void>((resolve, reject) => rebound.close(error => error ? reject(error) : resolve()));
    }, 30000);
});
