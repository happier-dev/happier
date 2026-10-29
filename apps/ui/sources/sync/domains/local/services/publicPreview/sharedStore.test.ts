import type {
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import { LocalServicePublicPreviewSnapshotV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Daemon RPC is the boundary; subscription lifecycle, request codec and response validation stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
import {
    getLocalServicePublicPreviewState,
    invalidateLocalServicePublicPreviewStore,
    publishLocalServicePublicPreviewSnapshot,
    resetLocalServicePublicPreviewStoreForTests,
    subscribeLocalServicePublicPreviewStore,
} from './sharedStore';
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
    return LocalServicePublicPreviewSnapshotV1Schema.parse({
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
    });
}

async function flushMicrotasks(): Promise<void> {
    await flushHookEffects();
}

describe('shared local-service public-preview store', () => {
    it.each(['snapshot', 'failure', 'rejection'] as const)('preserves a newer publication when an older read settles with %s', async (outcome) => {
        const pending = createDeferred<unknown>();
        rpc.machine.mockImplementation(async () => {
            const response = await pending.promise;
            if (outcome === 'rejection') throw new Error('transport failed');
            return response;
        });
        const key = { machineId: 'machine_1' };
        const release = subscribeLocalServicePublicPreviewStore(key, () => {});
        await flushMicrotasks();
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        publishLocalServicePublicPreviewSnapshot(key, snapshot({ generatedAt: 3_000, exposures: [] }));
        const published = getLocalServicePublicPreviewState(key);
        if (outcome === 'snapshot') pending.resolve({ protocolVersion: 1, snapshot: snapshot() });
        else if (outcome === 'failure') pending.resolve({ ok: false, error: 'request_failed' });
        else pending.resolve(undefined);
        await flushMicrotasks();
        expect(getLocalServicePublicPreviewState(key)).toBe(published);
        release();
    });
    beforeEach(() => {
        rpc.machine.mockReset();
        const observation = { status: 'ready' as const,
            features: createRootLayoutFeaturesResponse({ features: { localServices: { publicPreview: { enabled: true } } } }),
        };
        primeServerFeaturesSnapshot({ snapshot: observation });
        primeServerFeaturesSnapshot({ serverId: 'server_1', snapshot: observation });
    });
    afterEach(() => {
        resetLocalServicePublicPreviewStoreForTests();
        resetServerFeaturesClientForTests();
    });

    it('fetches once for a public-preview key regardless of how many panes subscribe', async () => {
        const statusClient = rpc.machine.mockResolvedValue({
            protocolVersion: 1,
            snapshot: snapshot({ sessionId: 'session_1' }),
        });
        const key = { machineId: 'machine_1', sessionId: 'session_1', serverId: 'server_1' };

        const unsubA = subscribeLocalServicePublicPreviewStore(key, () => {});
        const unsubB = subscribeLocalServicePublicPreviewStore(key, () => {});
        await flushMicrotasks();

        expect(statusClient).toHaveBeenCalledTimes(1);
        expect(statusClient).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
            payload: {
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
        const statusClient = rpc.machine.mockResolvedValue({
            protocolVersion: 1,
            snapshot: snapshot({ sessionId: 'session_1', previewId: 'preview_1', exposures: [] }),
        });
        const key = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            serverId: 'server_1',
        };
        const listener = vi.fn();

        const unsub = subscribeLocalServicePublicPreviewStore(key, listener);
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
        const statusClient = rpc.machine.mockResolvedValue({
            protocolVersion: 1,
            snapshot: snapshot({ sessionId: 'session_1', generatedAt: 4_000 }),
        });
        const broadKey = { machineId: 'machine_1', sessionId: 'session_1', serverId: 'server_1' };

        const unsub = subscribeLocalServicePublicPreviewStore(broadKey, () => {});
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
        const statusClient = rpc.machine.mockResolvedValue({
            protocolVersion: 1,
            snapshot: snapshot({ sessionId: 'session_1' }),
        });
        const key = { machineId: 'machine_1', sessionId: 'session_1' };

        invalidateLocalServicePublicPreviewStore(key);
        expect(statusClient).not.toHaveBeenCalled();

        const unsub = subscribeLocalServicePublicPreviewStore(key, () => {});
        await flushMicrotasks();
        expect(statusClient).toHaveBeenCalledTimes(1);

        invalidateLocalServicePublicPreviewStore(key);
        await flushMicrotasks();
        expect(statusClient).toHaveBeenCalledTimes(2);
        expect(selectLocalServicePublicPreviewRows(getLocalServicePublicPreviewState(key))).toEqual([exposure]);

        unsub();
    });

    it('does not re-fetch the public-preview status on a wall clock while subscribed', async () => {
        const statusClient = rpc.machine.mockResolvedValue({
            protocolVersion: 1,
            snapshot: snapshot({ sessionId: 'session_1' }),
        });
        const key = { machineId: 'machine_1', sessionId: 'session_1', serverId: 'server_1' };

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServicePublicPreviewStore(key, () => {}),
            fetchSpy: statusClient,
        });
    });
});
