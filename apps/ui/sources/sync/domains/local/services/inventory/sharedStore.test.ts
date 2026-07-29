import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalServiceInventorySnapshotClientResult } from './api';
import {
    getLocalServiceInventoryState,
    publishLocalServiceInventorySnapshot,
    resetLocalServiceInventoryStoreForTests,
    subscribeLocalServiceInventoryStore,
} from './sharedStore';
import { selectLocalServiceInventoryRows, type LocalServiceInventorySnapshot } from './store';

const snapshot = {
    v: 1,
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [{
        id: 'vite-5173',
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
    }],
    diagnostics: [],
} satisfies LocalServiceInventorySnapshot;

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('shared local-service inventory store', () => {
    afterEach(() => {
        resetLocalServiceInventoryStoreForTests();
    });

    it('fetches once for a key regardless of how many consumers subscribe', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        const unsubA = subscribeLocalServiceInventoryStore(key, () => {}, { snapshotClient });
        const unsubB = subscribeLocalServiceInventoryStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(snapshot.entries);

        unsubA();
        unsubB();
    });

    it('publishes action-read snapshots into the same backing model without polling', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot: { ...snapshot, entries: [] },
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeLocalServiceInventoryStore(key, listener, { snapshotClient });
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServiceInventorySnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(snapshot.entries);
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('uses no wall-clock setInterval poll in the inventory state surface', () => {
        const storeSource = readFileSync(
            fileURLToPath(new URL('./sharedStore.ts', import.meta.url)),
            'utf8',
        );
        const hookSource = readFileSync(
            fileURLToPath(new URL('./useLocalServiceInventoryState.ts', import.meta.url)),
            'utf8',
        );
        expect(storeSource).not.toContain('setInterval(');
        expect(hookSource).not.toContain('setInterval(');
    });
});
