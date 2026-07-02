import { describe, expect, it } from 'vitest';

import { normalizeLocalServiceScan } from './scanner';

describe('normalizeLocalServiceScan', () => {
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
                [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js --token raw-secret', cwd: '/repo/app' }],
                [300, { pid: 300, ppid: 1, command: 'npm run dev -- --token raw-secret', cwd: '/repo/app' }],
            ]),
            workspaces: [{ id: 'workspace-a', path: '/repo' }],
        });

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
            source: 'detected',
            state: 'listening',
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            classification: { kind: 'vite', displayName: 'Vite' },
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
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
