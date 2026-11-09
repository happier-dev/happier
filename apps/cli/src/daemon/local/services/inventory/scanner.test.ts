import { describe, expect, it } from 'vitest';

import { normalizeLocalServiceScan } from './scanner';
import { createTerminalProcessRegistry } from './terminalRegistry';
import { LocalServiceInventoryClassificationV1Schema, LocalServiceInventoryProcessProvenanceV1Schema } from '@happier-dev/protocol';
import { formatProcessOwnerTag } from '@/processes/ownerTag';
import { configuration } from '@/configuration';
import type { LocalServiceProcessFact } from './provenance';

describe('normalizeLocalServiceScan', () => {
    it('does not classify a browser debug listener or shell/agent listeners as their dev-server ancestor', () => {
        const snapshot = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1_000, previous: null,
            workspaces: [], ownership: [],
            processRoleCatalog: { agentExecutables: [{ name: 'Claude', executable: 'claude' }], mcpServers: [] },
            listeners: [{ address: '127.0.0.1', port: 9222, protocol: 'tcp', pid: 200 },
                { address: '127.0.0.1', port: 9223, protocol: 'tcp', pid: 201 },
                { address: '127.0.0.1', port: 9224, protocol: 'tcp', pid: 202 },
                { address: '127.0.0.1', port: 9225, protocol: 'tcp', pid: 203 },
                { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 300 }],
            processes: new Map([[100, { pid: 100, command: 'npm run dev' }],
                [200, { pid: 200, ppid: 100, command: 'chrome --remote-debugging-port=9222' }],
                [201, { pid: 201, ppid: 100, command: 'ssh -L 9223:localhost:22 host' }],
                [202, { pid: 202, ppid: 100, command: 'tmux' }],
                [203, { pid: 203, ppid: 100, command: 'claude' }],
                [300, { pid: 300, ppid: 100, command: 'node server.js' }]]) });
        expect(snapshot.entries.filter(entry => entry.port !== 5173).map(entry => entry.classification?.kind))
            .toEqual([undefined, undefined, undefined, undefined]);
        expect(snapshot.entries.find(entry => entry.port === 5173)?.classification?.kind).toBe('npm-dev');
    });

    it('reads the previous inventory linearly when refreshing a thousand listeners', () => {
        const listeners = Array.from({ length: 1_000 }, (_, index) => ({
            address: '127.0.0.1', port: 10_000 + index, protocol: 'tcp' as const,
        }));
        const first = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1_000,
            previous: null, listeners, processes: new Map(), workspaces: [], ownership: [] });
        let previousIdentityReads = 0;
        // Instrument real input rows, keeping the normalization and stale-row logic real.
        const previous = { ...first, entries: first.entries.map(entry => ({
            ...entry,
            get id() { previousIdentityReads += 1; return entry.id; },
        })) };
        const refreshed = normalizeLocalServiceScan({ machineId: 'machine-a', now: 2_000,
            previous, listeners: [...listeners].reverse(), processes: new Map(), workspaces: [], ownership: [] });

        expect(refreshed.entries).toHaveLength(listeners.length);
        expect(refreshed.entries.every(entry => entry.detectedAt === 1_000 && entry.lastSeenAt === 2_000
            && entry.state === 'listening')).toBe(true);
        expect(previousIdentityReads).toBeLessThanOrEqual(listeners.length * 3);
    });

    it('keeps unreadable or empty process commands valid at the strict inventory provenance boundary', () => {
        const snapshot = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1, previous: null,
            workspaces: [], listeners: [{ address: '127.0.0.1', port: 3005, protocol: 'tcp', pid: 10 }],
            processes: new Map([[10, { pid: 10, ppid: 1, command: '  ',
                censusRow: { pid: 10, ppid: 1, start: { startTimeMs: 1 }, principal: null,
                    name: '', argv: [], memory: null, cpuTimeUs: null } }]]),
        });
        expect(LocalServiceInventoryProcessProvenanceV1Schema.parse(snapshot.entries[0]?.provenance?.process))
            .toMatchObject({ pid: 10, command: 'unknown', redacted: true });
    });
    it('presents wildcard listeners at their machine-local address without changing the bind fact', () => {
        const snapshot = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1, previous: null,
            processes: new Map(), workspaces: [], listeners: [
                { address: '::', port: 3005, protocol: 'tcp' },
                { address: '0.0.0.0', port: 5173, protocol: 'tcp' },
                { address: '*', port: 6006, protocol: 'tcp' },
            ] });
        expect(snapshot.entries.map(entry => entry.presentation?.addressLabel))
            .toEqual(['localhost:3005', 'localhost:5173', 'localhost:6006']);
        expect(snapshot.entries.map(entry => entry.address.host)).toEqual(['::', '0.0.0.0', '*']);
    });
    it('indexes current process facts once for all listener labels and rebuilds them on the next scan', () => {
        // Measure full-table work on real input data; internal lineage/label logic stays real.
        class MeasuredProcessFacts extends Map<number, LocalServiceProcessFact> {
            enumerations = 0;
            override values() {
                this.enumerations += 1;
                return super.values();
            }
        }
        const processes = new MeasuredProcessFacts([
            [300, { pid: 300, ppid: 1, command: 'npm run dev -- --token test-secret', cwd: '/repo/first' }],
            [400, { pid: 400, ppid: 300, command: 'node server.js', cwd: '/repo/first/child' }],
            [500, { pid: 500, ppid: 300, command: 'node other.js', cwd: '/repo/first/child' }],
        ]);
        const listeners = Array.from({ length: 20 }, (_, index) => ({
            address: '127.0.0.1', port: 5000 + index, protocol: 'tcp' as const,
            pid: index % 2 === 0 ? 400 : 500,
        }));
        const scan = (now: number) => normalizeLocalServiceScan({ machineId: 'machine-a', now,
            previous: null, processes, listeners, workspaces: [], ownership: [] });

        const first = scan(1000);
        expect(first.entries.map(entry => entry.provenance?.process?.lineagePids))
            .toEqual(listeners.map(listener => [listener.pid, 300]));
        expect(first.entries.every(entry => entry.provenance?.process?.command === 'npm run dev -- --token [REDACTED]'))
            .toBe(true);
        expect(first.entries.every(entry => entry.provenance?.process?.cwd === '/repo/first')).toBe(true);
        expect(processes.enumerations).toBe(1);

        processes.set(300, { pid: 300, ppid: 1, command: 'npm run start', cwd: '/repo/second' });
        const second = scan(2000);
        expect(second.entries.every(entry => entry.provenance?.process?.command === 'npm run start')).toBe(true);
        expect(second.entries.every(entry => entry.provenance?.process?.cwd === '/repo/second')).toBe(true);
        expect(processes.enumerations).toBe(2);
    });
    it('preserves unreadable census fields through Services instead of lending port-only action authority', () => {
        const terminalRegistry = createTerminalProcessRegistry();
        terminalRegistry.registerTerminalProcesses({ terminalKey: 'shell', terminalId: 'terminal-a', workspacePath: '/repo', pids: [10] });
        const snapshot = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1000, previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 20 }],
            processes: new Map([[10, { pid: 10, ppid: 1, command: 'sh', processOwnership: 'self' as const }],
                [20, { pid: 20, ppid: 1, command: 'vite', cwd: '/repo', processOwnership: 'self' as const, censusMissing: ['environ'] }]]),
            workspaces: [], terminalRegistry });
        expect(snapshot.entries[0]?.processOwnershipConfidence).toBe('medium');
    });
    it('attributes a listener beyond four parent links to its terminal and session', () => {
        const terminalRegistry = createTerminalProcessRegistry();
        terminalRegistry.registerTerminalProcesses({ terminalKey: 'shell', terminalId: 'terminal-a',
            sessionId: 'session-a', workspacePath: '/repo', pids: [100] });
        const snapshot = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1000, previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 106 }],
            processes: new Map<number, LocalServiceProcessFact>([[process.pid, { pid: process.pid, command: 'daemon', processOwnership: 'self' }], ...Array.from({ length: 7 }, (_, offset): [number, LocalServiceProcessFact] => [100 + offset, {
                pid: 100 + offset, ppid: offset ? 99 + offset : 1, command: offset === 6 ? 'vite' : 'sh',
                processStartTimeMs: 100 + offset, processOwnership: 'self' as const,
                censusRow: { pid: 100 + offset, ppid: offset ? 99 + offset : 1, start: { startTimeMs: 100 + offset },
                    principal: { kind: 'uid' as const, value: 'daemon' }, name: 'sh', memory: null, cpuTimeUs: null,
                    ...(offset === 0 ? { ownerTag: formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir,
                        owner: { kind: 'terminal' as const, terminalId: 'terminal-a' } }) } : {}) },
            }])]), workspaces: [], terminalRegistry });
        expect(snapshot.entries[0]?.provenance?.session?.id).toBe('session-a');
        expect(snapshot.entries[0]?.provenance?.process?.lineagePids).toContain(100);
        expect(LocalServiceInventoryClassificationV1Schema.safeParse(snapshot.entries[0]?.classification).success).toBe(true);
    });
    it('excludes only listeners owned by exact Happier process or endpoint evidence, keeping their app descendants', () => {
        const input: Parameters<typeof normalizeLocalServiceScan>[0] = {
            machineId: 'machine-a', now: 1_000, previous: null, workspaces: [],
            internalProcessPids: [100, 200],
            internalEndpointUrls: ['http://127.0.0.1:19364', 'https://example.com:9999', 'not a URL'],
            listeners: [
                { address: '127.0.0.1', port: 3000, protocol: 'tcp', pid: 100 },
                { address: '::1', port: 3001, protocol: 'tcp', pid: 200 },
                { address: '0.0.0.0', port: 19364, protocol: 'tcp' },
                { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 300 },
                { address: '192.168.1.2', port: 19364, protocol: 'tcp', pid: 400 },
                { address: '127.0.0.2', port: 19364, protocol: 'tcp', pid: 400 },
                { address: '127.0.0.1', port: 9999, protocol: 'tcp', pid: 400 },
            ],
            processes: new Map([
                [100, { pid: 100, command: 'node daemon.js' }],
                [200, { pid: 200, command: 'happier session' }],
                [300, { pid: 300, ppid: 200, command: 'node happier-demo.js', cwd: '/repo/.happier' }],
                [400, { pid: 400, command: 'node web.js' }],
            ]),
        };
        const snapshot = normalizeLocalServiceScan(input);
        expect(snapshot.entries.map(entry => entry.port)).toEqual([5173, 9999, 19364, 19364]);
        expect(snapshot.entries.find((entry) => entry.port === 5173)?.classification?.kind).not.toBe('happier');
        expect(snapshot.entries.find((entry) => entry.address.kind === 'lan')?.classification?.kind).not.toBe('happier');
        expect(snapshot.entries.find((entry) => entry.address.host === '127.0.0.2')?.classification?.kind).not.toBe('happier');
        expect(snapshot.entries.find((entry) => entry.port === 9999)?.classification?.kind).not.toBe('happier');
        const previouslyDetected = normalizeLocalServiceScan({ ...input, internalProcessPids: [], internalEndpointUrls: [] });
        const refreshed = normalizeLocalServiceScan({ ...input, previous: previouslyDetected });
        expect(refreshed.entries.map(entry => entry.port)).toEqual(snapshot.entries.map(entry => entry.port));
    });

    it('normalizes adapter listeners into stable sanitized inventory entries', () => {
        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 3_000,
            previous: null,
            listeners: [
                {
                    address: '127.0.0.1',
                    port: 5173,
                    protocol: 'tcp',
                    pid: 400,
                },
            ],
            processes: new Map([
                [400, { pid: 400, ppid: 300, processStartTimeMs: 1_717_171_717_000, command: 'node ./node_modules/vite/bin/vite.js --token raw-secret', cwd: '/repo/app' }],
                [300, { pid: 300, ppid: 1, processStartTimeMs: 1_717_171_710_000, command: 'npm run dev -- --token raw-secret', cwd: '/repo/app' }],
            ]),
            workspaces: [{ id: 'workspace-a', path: '/repo' }],
        });

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-1717171717000',
            source: 'detected',
            state: 'listening',
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            classification: { kind: 'vite', displayName: 'Vite' },
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
        expect(snapshot.entries[0]?.provenance?.process?.processStartTimeMs).toBe(1_717_171_717_000);
    });

    it('treats PID reuse with a different process start-time as a fresh row', () => {
        const first = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 1_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([[400, { pid: 400, ppid: 1, processStartTimeMs: 1_000, command: 'npm run dev', cwd: '/repo' }]]),
            workspaces: [],
        });

        const restarted = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 2_000,
            previous: first,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([[400, { pid: 400, ppid: 1, processStartTimeMs: 2_000, command: 'npm run dev', cwd: '/repo' }]]),
            workspaces: [],
        });

        const listening = restarted.entries.find((entry) => entry.state === 'listening');
        expect(listening?.id).toBe('machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-2000');
        expect(listening?.detectedAt).toBe(2_000);
        expect(first.entries[0]?.id).not.toBe(listening?.id);
    });

    it('marks missing previous entries stale during refresh instead of dropping them', () => {
        const previous = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 1_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([[400, { pid: 400, ppid: 1, command: 'npm run dev', cwd: '/repo' }]]),
            workspaces: [],
        });

        const next = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 2_000,
            previous,
            listeners: [],
            processes: new Map(),
            workspaces: [],
        });

        expect(next.entries).toHaveLength(1);
        expect(next.entries[0]?.state).toBe('stale');
        expect(next.entries[0]?.lastSeenAt).toBe(1_000);
    });

    it('expires stale entries through gone before dropping them', () => {
        const previous = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 1_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([[400, { pid: 400, ppid: 1, command: 'npm run dev', cwd: '/repo' }]]),
            workspaces: [],
            staleAfterMs: 500,
        });
        const stale = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 1_100,
            previous,
            listeners: [],
            processes: new Map(),
            workspaces: [],
            staleAfterMs: 500,
        });
        const gone = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 1_600,
            previous: stale,
            listeners: [],
            processes: new Map(),
            workspaces: [],
            staleAfterMs: 500,
        });
        const dropped = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 2_100,
            previous: gone,
            listeners: [],
            processes: new Map(),
            workspaces: [],
            staleAfterMs: 500,
        });

        expect(stale.entries[0]?.state).toBe('stale');
        expect(gone.entries[0]?.state).toBe('gone');
        expect(dropped.entries).toEqual([]);
    });
});
