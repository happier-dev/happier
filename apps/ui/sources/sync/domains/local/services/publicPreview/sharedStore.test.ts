import type {
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalServicePublicPreviewStatusClientResult } from './api';
import {
    getLocalServicePublicPreviewState,
    invalidateLocalServicePublicPreviewStore,
    publishLocalServicePublicPreviewSnapshot,
    resetLocalServicePublicPreviewStoreForTests,
    subscribeLocalServicePublicPreviewStore,
} from './sharedStore';
import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import { selectLocalServicePublicPreviewRows } from './store';

const exposure = {
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.example.test/s/public_preview_1',
    issuedAt: 1_000,
    expiresAt: 601_000,
    auditEventIds: ['audit_1'],
    rateLimitProfileId: 'default',
} satisfies LocalServicePublicExposureV1;

function snapshot(input: Readonly<{
    exposures?: readonly LocalServicePublicExposureV1[];
    sessionId?: string;
    previewId?: string;
    exposureId?: string;
    generatedAt?: number;
}> = {}): LocalServicePublicPreviewSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.previewId ? { previewId: input.previewId } : {}),
        generatedAt: input.generatedAt ?? 2_000,
        refreshState: 'idle',
        policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            maxTtlMs: 600_000,
            maxConcurrentExposures: 1,
            dnsTlsRequired: true,
            auditRequired: true,
            rateLimitProfileIds: ['default'],
        },
        exposures: input.exposureId
            ? (input.exposures ?? [exposure]).filter((row) => row.exposureId === input.exposureId)
            : [...(input.exposures ?? [exposure])],
        diagnostics: [],
    };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('shared local-service public-preview store', () => {
    afterEach(() => {
        resetLocalServicePublicPreviewStoreForTests();
    });

    it('fetches once for a public-preview key regardless of how many panes subscribe', async () => {
        const statusClient = vi.fn(async (): Promise<LocalServicePublicPreviewStatusClientResult> => ({
            ok: true,
            snapshot: snapshot({ sessionId: 'session_1' }),
        }));
        const key = { machineId: 'machine_1', sessionId: 'session_1', serverId: 'server_1' };

        const unsubA = subscribeLocalServicePublicPreviewStore(key, () => {}, { statusClient });
        const unsubB = subscribeLocalServicePublicPreviewStore(key, () => {}, { statusClient });
        await flushMicrotasks();

        expect(statusClient).toHaveBeenCalledTimes(1);
        expect(statusClient).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
            },
            serverId: 'server_1',
        }));
        expect(selectLocalServicePublicPreviewRows(getLocalServicePublicPreviewState(key))).toEqual([exposure]);

        unsubA();
        unsubB();
    });

    it('publishes exact public-preview snapshots without waiting for a poll', async () => {
        const statusClient = vi.fn(async (): Promise<LocalServicePublicPreviewStatusClientResult> => ({
            ok: true,
            snapshot: snapshot({ sessionId: 'session_1', previewId: 'preview_1', exposures: [] }),
        }));
        const key = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            serverId: 'server_1',
        };
        const listener = vi.fn();

        const unsub = subscribeLocalServicePublicPreviewStore(key, listener, { statusClient });
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServicePublicPreviewSnapshot(key, snapshot({
            sessionId: 'session_1',
            previewId: 'preview_1',
            generatedAt: 3_000,
        }));

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServicePublicPreviewRows(getLocalServicePublicPreviewState(key))).toEqual([exposure]);
        expect(statusClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('invalidates broader public-preview subscribers when a preview-scoped action snapshot cannot cover them', async () => {
        const statusClient = vi.fn(async (): Promise<LocalServicePublicPreviewStatusClientResult> => ({
            ok: true,
            snapshot: snapshot({ sessionId: 'session_1', generatedAt: 4_000 }),
        }));
        const broadKey = { machineId: 'machine_1', sessionId: 'session_1', serverId: 'server_1' };

        const unsub = subscribeLocalServicePublicPreviewStore(broadKey, () => {}, { statusClient });
        await flushMicrotasks();
        expect(statusClient).toHaveBeenCalledTimes(1);

        publishLocalServicePublicPreviewSnapshot({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            serverId: 'server_1',
        }, snapshot({
            sessionId: 'session_1',
            previewId: 'preview_1',
            generatedAt: 5_000,
        }));
        await flushMicrotasks();

        expect(statusClient).toHaveBeenCalledTimes(2);
        expect(selectLocalServicePublicPreviewRows(getLocalServicePublicPreviewState(broadKey))).toEqual([exposure]);

        unsub();
    });

    it('invalidation re-fetches for a live public-preview key only', async () => {
        const statusClient = vi.fn(async (): Promise<LocalServicePublicPreviewStatusClientResult> => ({
            ok: true,
            snapshot: snapshot({ sessionId: 'session_1' }),
        }));
        const key = { machineId: 'machine_1', sessionId: 'session_1' };

        invalidateLocalServicePublicPreviewStore(key);
        expect(statusClient).not.toHaveBeenCalled();

        const unsub = subscribeLocalServicePublicPreviewStore(key, () => {}, { statusClient });
        await flushMicrotasks();
        expect(statusClient).toHaveBeenCalledTimes(1);

        invalidateLocalServicePublicPreviewStore(key);
        await flushMicrotasks();
        expect(statusClient).toHaveBeenCalledTimes(2);

        unsub();
    });

    it('does not re-fetch the public-preview status on a wall clock while subscribed', async () => {
        const statusClient = vi.fn(async (): Promise<LocalServicePublicPreviewStatusClientResult> => ({
            status: 'ok',
            snapshot,
        }));

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServicePublicPreviewStore(key, () => {}, { statusClient }),
            fetchSpy: statusClient,
        });
    });
});
