import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOsProcessControl } from './osProcessControl';
import { createTerminateDetectedService } from './terminate';
import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';

/**
 * Real-process-tree proof for the one destructive local-services action (P0-5 / tunnels §4.3).
 *
 * A dev server is almost never a process-group leader: `spawn()` puts the child in the
 * caller's group, so the previous `kill(-pid)` group addressing raised `ESRCH` — which the
 * adapter swallowed as success — and nothing was signalled at all. This test drives the real
 * OS boundary (descendant resolution + `process.kill`) against a genuine three-level tree and
 * requires every member to be gone.
 *
 * Only the listener scan is injected: it is the platform system boundary (`lsof`/`/proc`/
 * `netstat`), and binding a real port would make the assertion about the port rather than
 * about the process tree.
 */

const TREE_SCRIPT = [
    'sleep 120 &',
    'echo "child:$!"',
    "sh -c 'sleep 120 & echo \"grandchild:$!\"; wait' &",
    'echo "branch:$!"',
    'wait',
    '',
].join('\n');

type SpawnedTree = Readonly<{
    root: ReturnType<typeof spawn>;
    pids: Readonly<{ root: number; child: number; branch: number; grandchild: number }>;
    dir: string;
}>;

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function spawnProcessTree(): Promise<SpawnedTree> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-terminate-tree-'));
    const scriptPath = join(dir, 'tree.sh');
    await writeFile(scriptPath, TREE_SCRIPT, 'utf8');
    const root = spawn('/bin/sh', [scriptPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    const rootPid = root.pid;
    if (typeof rootPid !== 'number') {
        throw new Error('failed to spawn the process tree root');
    }

    const found = new Map<string, number>();
    await new Promise<void>((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => {
            reject(new Error(`process tree did not report its members: ${buffered}`));
        }, 10_000);
        root.stdout.setEncoding('utf8');
        root.stdout.on('data', (chunk: string) => {
            buffered += chunk;
            for (const line of buffered.split('\n')) {
                const [label, rawPid] = line.trim().split(':');
                const pid = Number(rawPid);
                if (label && Number.isInteger(pid) && pid > 0) {
                    found.set(label, pid);
                }
            }
            if (found.has('child') && found.has('branch') && found.has('grandchild')) {
                clearTimeout(timer);
                resolve();
            }
        });
        root.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return {
        root,
        pids: {
            root: rootPid,
            child: found.get('child') as number,
            branch: found.get('branch') as number,
            grandchild: found.get('grandchild') as number,
        },
        dir,
    };
}

function inventoryEntry(pid: number): NormalizedLocalServiceInventoryEntry {
    return {
        id: `machine-a:tcp:loopback:127.0.0.1:5173:pid-${pid}:start-unknown`,
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
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: {
                pid,
                ppid: process.pid,
                // A real dev server always resolves an ancestor chain (`npm run dev` -> node).
                // That is what the deleted `isRunWrapped` heuristic misread as "signal the group".
                lineagePids: [pid, process.pid],
                command: 'sh tree.sh',
                redacted: true,
            },
        },
    };
}

function request(): LocalServiceActionRequestV1 {
    return {
        requestId: 'req-tree',
        action: 'terminate_detected',
        target: { kind: 'inventory_entry', machineId: 'machine-a', inventoryEntryId: 'entry-a' },
        confirmationNonce: 'nonce',
        force: false,
    };
}

let spawned: SpawnedTree | null = null;

afterEach(async () => {
    const tree = spawned;
    spawned = null;
    if (!tree) return;
    for (const pid of Object.values(tree.pids)) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // already gone
        }
    }
    await rm(tree.dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('terminate_detected against a real process tree', () => {
    it('kills the listener process and every descendant, then reports success', async () => {
        const tree = await spawnProcessTree();
        spawned = tree;
        expect(isAlive(tree.pids.grandchild)).toBe(true);

        const control = createOsProcessControl({
            refreshInventory: async () => ({
                v: 1 as const,
                machineId: 'machine-a',
                generatedAt: Date.now(),
                refreshState: 'idle' as const,
                entries: isAlive(tree.pids.root) ? [inventoryEntry(tree.pids.root)] : [],
                diagnostics: [],
            }),
        });
        const terminate = createTerminateDetectedService(control, {
            graceMs: 300,
            verifyPollMs: 50,
            verifyAttempts: 20,
        });

        const result = await terminate({
            request: request(),
            entry: inventoryEntry(tree.pids.root),
            now: Date.now(),
        });

        expect(result).toEqual({ status: 'succeeded' });
        expect({
            root: isAlive(tree.pids.root),
            child: isAlive(tree.pids.child),
            branch: isAlive(tree.pids.branch),
            grandchild: isAlive(tree.pids.grandchild),
        }).toEqual({ root: false, child: false, branch: false, grandchild: false });
    });

    it('refuses the kill instead of half-killing the tree when `ps` times out', async () => {
        // Observed on a loaded machine during this lane's QA: the process-table query hit its
        // timeout, resolved to an empty descendant set, and terminate signalled the listener
        // alone. Killing the listener frees the port, so the port-release verification passed
        // and the one destructive action in the product reported SUCCESS while the user's child
        // processes were still running. The only honest outcomes are "the whole tree died" or a
        // typed failure — never a partial kill dressed as success.
        const tree = await spawnProcessTree();
        spawned = tree;

        const control = createOsProcessControl({
            refreshInventory: async () => ({
                v: 1 as const,
                machineId: 'machine-a',
                generatedAt: Date.now(),
                refreshState: 'idle' as const,
                entries: isAlive(tree.pids.root) ? [inventoryEntry(tree.pids.root)] : [],
                diagnostics: [],
            }),
            execFile: async () => {
                const error = new Error('spawn ps ETIMEDOUT') as NodeJS.ErrnoException;
                error.code = 'ETIMEDOUT';
                throw error;
            },
        });
        const terminate = createTerminateDetectedService(control, {
            graceMs: 300,
            verifyPollMs: 50,
            verifyAttempts: 20,
        });

        const result = await terminate({
            request: request(),
            entry: inventoryEntry(tree.pids.root),
            now: Date.now(),
        });

        expect(result).toEqual({ status: 'failed', reasonCode: 'process_tree_unresolved' });
        expect({
            root: isAlive(tree.pids.root),
            child: isAlive(tree.pids.child),
            branch: isAlive(tree.pids.branch),
            grandchild: isAlive(tree.pids.grandchild),
        }).toEqual({ root: true, child: true, branch: true, grandchild: true });
    });
});
