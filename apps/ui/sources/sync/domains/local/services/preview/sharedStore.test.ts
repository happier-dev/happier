import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';

import {
    type LocalServicePreviewSnapshotClientResult,
} from './api';
import {
    getLocalServicePreviewState,
    invalidateLocalServicePreviewStore,
    publishLocalServicePreviewSnapshot,
    resetLocalServicePreviewStoreForTests,
    subscribeLocalServicePreviewStore,
} from './sharedStore';
import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import { selectLocalServicePreviewRows, type LocalServicePreviewSnapshot } from './store';

function previewResource(previewId: string): LocalServicePreviewResourceV1 {
    return {
        previewId,
        sessionId: 'session_1',
        machineId: 'machine_1',
        owner: { kind: 'session', id: 'session_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/', search: '' },
        display: { title: 'Vite', addressLabel: 'localhost:5173' },
        originMode: 'host',
        browserTarget: {
            kind: 'localServicePreview',
            targetId: previewId,
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Vite', addressLabel: 'localhost:5173' },
        },
    };
}

function snapshotWith(previewId: string): LocalServicePreviewSnapshot {
    return {
        generatedAt: 1_000,
        refreshState: 'idle',
        previews: [{
            previewId,
            resource: previewResource(previewId),
            accessUrl: 'http://127.0.0.1:5173/',
            expiresAt: null,
            diagnostics: [],
        }],
        diagnostics: [],
    };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('shared local-service preview store (PRV-4)', () => {
    afterEach(() => {
        resetLocalServicePreviewStoreForTests();
    });

    it('fetches once for a key regardless of how many panes subscribe', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServicePreviewSnapshotClientResult> => ({
            ok: true,
            snapshot: snapshotWith('preview_1'),
        }));
        const key = { machineId: 'machine_1', serverId: 'server_1' };

        const unsubA = subscribeLocalServicePreviewStore(key, () => {}, { snapshotClient });
        const unsubB = subscribeLocalServicePreviewStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();

        // One backing model, one fetch — not one timer/fetch per mount.
        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(1);

        unsubA();
        unsubB();
    });

    it('refreshes an open pane when an action publishes a snapshot (no polling)', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServicePreviewSnapshotClientResult> => ({
            ok: true,
            snapshot: { generatedAt: 1_000, refreshState: 'idle', previews: [], diagnostics: [] },
        }));
        const key = { machineId: 'machine_1' };
        const listener = vi.fn();

        const unsub = subscribeLocalServicePreviewStore(key, listener, { snapshotClient });
        await flushMicrotasks();
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(0);
        listener.mockClear();

        // An openOrCreate/revoke/status dispatch publishes its snapshot into the same store.
        publishLocalServicePreviewSnapshot(key, snapshotWith('preview_1'));

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toEqual([
            expect.objectContaining({ previewId: 'preview_1' }),
        ]);
        // No additional fetch was issued — the refresh was driven by the action, not a timer.
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('drops the keyed entry once the last subscriber leaves', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServicePreviewSnapshotClientResult> => ({
            ok: true,
            snapshot: snapshotWith('preview_1'),
        }));
        const key = { machineId: 'machine_1' };

        const unsub = subscribeLocalServicePreviewStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(1);

        unsub();
        // A publish to a key with no live subscriber is a safe no-op (nothing to refresh into).
        publishLocalServicePreviewSnapshot(key, snapshotWith('preview_2'));
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(0);
    });

    it('invalidation re-fetches for a live key only', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServicePreviewSnapshotClientResult> => ({
            ok: true,
            snapshot: snapshotWith('preview_1'),
        }));
        const key = { machineId: 'machine_1' };

        // No subscriber → invalidation is a no-op.
        invalidateLocalServicePreviewStore(key);
        expect(snapshotClient).not.toHaveBeenCalled();

        const unsub = subscribeLocalServicePreviewStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        invalidateLocalServicePreviewStore(key);
        await flushMicrotasks();
        expect(snapshotClient).toHaveBeenCalledTimes(2);

        unsub();
    });

    it('a rejecting snapshot client marks the refresh failed and does not wedge later refreshes', async () => {
        const snapshotClient = vi.fn<() => Promise<LocalServicePreviewSnapshotClientResult>>()
            .mockRejectedValueOnce(new Error('machine rpc transport failure'))
            .mockResolvedValue({ ok: true, snapshot: snapshotWith('preview_recovered') });
        const key = { machineId: 'machine_1' };

        const unsub = subscribeLocalServicePreviewStore(key, () => {}, { snapshotClient, nowMs: () => 5_000 });
        await flushMicrotasks();

        // A thrown transport error must surface as a failed refresh, not leave the key stuck
        // in `refreshing` with the in-flight latch held forever.
        expect(getLocalServicePreviewState(key).refreshState).toBe('error');

        invalidateLocalServicePreviewStore(key);
        await flushMicrotasks();
        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toEqual([
            expect.objectContaining({ previewId: 'preview_recovered' }),
        ]);

        unsub();
    });

    it('does not re-fetch previews on a wall clock while subscribed (PRV-4 DONE gate)', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServicePreviewSnapshotClientResult> => ({
            status: 'ok',
            snapshot,
        }));

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServicePreviewStore(key, () => {}, { snapshotClient }),
            fetchSpy: snapshotClient,
        });
    });
});
