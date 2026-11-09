import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol/local/services/public/v1';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setActiveServer } from '@/sync/domains/server/serverRuntime';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

await loadSyncSingletonForTests();

import { selectLocalServicePublicPreviewRows } from './store';
import type { LocalServicePublicPreviewStatusClient } from './useLocalServicePublicPreviewState';
import {
    invalidateLocalServicePublicPreviewStore,
    resetLocalServicePublicPreviewStoreForTests,
} from './sharedStore';

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

const snapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    generatedAt: 2_000,
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
    exposures: [exposure],
    diagnostics: [],
} satisfies LocalServicePublicPreviewSnapshotV1;

describe('useLocalServicePublicPreviewState', () => {
    let home: Awaited<ReturnType<typeof upsertServerProfile>>;
    beforeEach(async () => {
        home = await upsertServerProfile({ serverUrl: 'https://public-preview-hook.example.test' });
        const token = createAccountTokenForTests('public-preview-account', { currentAccount: true });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async serverUrl =>
            serverUrl === home.serverUrl ? { token } : null);
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.origin !== home.serverUrl) throw new Error('Unexpected public preview Home');
            if (url.pathname === '/health') return Response.json({ status: 'ok' });
            if (url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return Response.json({}, { status: 404 });
        });
        await setActiveServer({ serverId: home.id });
    });
    afterEach(() => {
        vi.useRealTimers();
        resetLocalServicePublicPreviewStoreForTests();
        resetRuntimeFetch();
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('loads public preview state from the canonical status client', async () => {
        const statusClient: LocalServicePublicPreviewStatusClient = vi.fn(async () => ({
            ok: true as const,
            snapshot,
        }));
        const { useLocalServicePublicPreviewStateController } = await import('./useLocalServicePublicPreviewState');

        const hook = await renderHook(() => useLocalServicePublicPreviewStateController({
            machineId: 'machine_1',
            sessionId: 'session_1',
            serverId: home.id,
            statusClient,
            nowMs: () => 1_900,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(statusClient).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
            },
            serverId: home.id,
        }));
        expect(selectLocalServicePublicPreviewRows(hook.getCurrent().state)).toEqual([exposure]);
        expect(hook.getCurrent().state.refreshState).toBe('idle');
    });

    it('preserves the last public preview snapshot when an invalidation refresh fails', async () => {
        const statusClient: LocalServicePublicPreviewStatusClient = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, snapshot })
            .mockResolvedValueOnce({ ok: false as const, reason: 'unavailable' as const });
        const { useLocalServicePublicPreviewStateController } = await import('./useLocalServicePublicPreviewState');

        const hook = await renderHook(() => useLocalServicePublicPreviewStateController({
            machineId: 'machine_1',
            sessionId: 'session_1',
            statusClient,
            nowMs: () => 2_500,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(selectLocalServicePublicPreviewRows(hook.getCurrent().state)).toHaveLength(1);

        await act(async () => {
            invalidateLocalServicePublicPreviewStore({ machineId: 'machine_1', sessionId: 'session_1',
                serverId: home.id, accountId: 'public-preview-account' });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(statusClient).toHaveBeenCalledTimes(2);
        expect(selectLocalServicePublicPreviewRows(hook.getCurrent().state)).toEqual([exposure]);
        expect(hook.getCurrent().state.refreshState).toBe('error');
    });
});
