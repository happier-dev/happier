import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type {
    getProviderAccountUsageSnapshotPlain,
    getProviderAccountUsageSnapshotSealed,
} from '@/sync/api/account/apiProviderAccountUsage';
import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);

const {
    fetchAccountEncryptionModeSpy,
    getProviderAccountUsageSnapshotPlainSpy,
    getProviderAccountUsageSnapshotSealedSpy,
} = vi.hoisted(() => ({
    fetchAccountEncryptionModeSpy: vi.fn<
        (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
    >(async () => ({ mode: 'plain', updatedAt: 0 })),
    getProviderAccountUsageSnapshotPlainSpy: vi.fn<
        (...args: Parameters<typeof getProviderAccountUsageSnapshotPlain>) => ReturnType<typeof getProviderAccountUsageSnapshotPlain>
    >(async () => null),
    getProviderAccountUsageSnapshotSealedSpy: vi.fn<
        (...args: Parameters<typeof getProviderAccountUsageSnapshotSealed>) => ReturnType<typeof getProviderAccountUsageSnapshotSealed>
    >(async () => null),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: currentCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

vi.mock('@/sync/api/account/apiProviderAccountUsage', () => ({
    getProviderAccountUsageSnapshotPlain: getProviderAccountUsageSnapshotPlainSpy,
    getProviderAccountUsageSnapshotSealed: getProviderAccountUsageSnapshotSealedSpy,
}));

function makeUsageSnapshot(params: Readonly<{
    accountSubjectId?: string;
    staleAfterMs?: number;
    meterId?: string;
}> = {}): ProviderAccountUsageSnapshotV1 {
    const fetchedAtMs = Date.now();
    const recordKey = {
        providerId: 'codex',
        accountSubjectId: params.accountSubjectId ?? 'acct_stable',
        subjectKind: 'account',
        quotaScope: 'account',
    } satisfies ProviderAccountUsageSnapshotV1['recordKey'];
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: {
            kind: 'providerSubject',
            id: recordKey.accountSubjectId,
        },
        aliases: [
            {
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: recordKey.accountSubjectId,
            },
            {
                kind: 'nativeCli',
                providerId: 'codex',
                localCredentialRef: 'codex-home',
                accountSubjectId: recordKey.accountSubjectId,
            },
        ],
        observedAtMs: fetchedAtMs,
        fetchedAtMs,
        staleAfterMs: params.staleAfterMs ?? 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Plus',
        accountLabel: 'Work',
        meters: [
            {
                meterId: params.meterId ?? 'weekly',
                label: params.meterId ?? 'weekly',
                used: 40,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                remainingPct: 60,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: { limitCategory: 'usage_limit' },
            },
        ],
    });
}

async function loadHook() {
    try {
        return await import('./useProviderAccountUsageSnapshots');
    } catch (error) {
        expect.fail(`canonical provider account usage hook is missing: ${String(error)}`);
    }
}

describe('useProviderAccountUsageSnapshots', () => {
    beforeEach(() => {
        currentCredentials = stableCredentials;
        vi.resetModules();
        vi.clearAllMocks();
        useFeatureEnabledSpy.mockReturnValue(true);
        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('loads canonical usage by record id and exposes connected-service alias projections', async () => {
        const snapshot = makeUsageSnapshot();
        getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(snapshot);

        const { useProviderAccountUsageSnapshots } = await loadHook();
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId], {
            aliases: [{ serviceId: 'openai-codex', profileId: 'work' }],
        }));
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getProviderAccountUsageSnapshotPlainSpy).toHaveBeenCalledWith(stableCredentials, {
            recordId: snapshot.recordId,
        }, { signal: expect.any(AbortSignal) });
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]?.recordId).toBe(snapshot.recordId);
        expect(hook.getCurrent().stateByRecordId[snapshot.recordId]).toBe('loaded_data');
        expect(hook.getCurrent().connectedServiceSnapshotsByKey['openai-codex/work']?.activeAccountId).toBe('acct_stable');
        await hook.unmount();
    });

    it('preserves last-known-good usage when a refresh fails', async () => {
        vi.useFakeTimers();
        const snapshot = makeUsageSnapshot({ staleAfterMs: 1, meterId: 'weekly' });
        getProviderAccountUsageSnapshotPlainSpy
            .mockResolvedValueOnce(snapshot)
            .mockRejectedValueOnce(new Error('temporary'));

        const { useProviderAccountUsageSnapshots } = await loadHook();
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]));
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]?.meters[0]?.meterId).toBe('weekly');
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 30_001 });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getProviderAccountUsageSnapshotPlainSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]?.meters[0]?.meterId).toBe('weekly');
        expect(hook.getCurrent().stateByRecordId[snapshot.recordId]).toBe('error_last_known_good');
        expect(hook.getCurrent().loadingByRecordId[snapshot.recordId]).toBe(false);
        await hook.unmount();
    });

    it('serves connected-service projections from the canonical cache without refetching', async () => {
        const snapshot = makeUsageSnapshot();
        getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(snapshot);

        const { useProviderAccountUsageSnapshots } = await loadHook();

        function Loader() {
            useProviderAccountUsageSnapshots([snapshot.recordId]);
            return null;
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Loader));
        });
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(getProviderAccountUsageSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        const hook = await renderHook(() => useProviderAccountUsageSnapshots([], {
            aliases: [{ serviceId: 'openai-codex', profileId: 'work' }],
            fetchPolicy: 'cache_only',
        }));

        const projected = hook.getCurrent().connectedServiceSnapshotsByKey['openai-codex/work'];
        expect(projected && 'recordKey' in projected).toBe(false);
        expect(projected?.activeAccountId).toBe('acct_stable');
        expect(getProviderAccountUsageSnapshotPlainSpy).toHaveBeenCalledTimes(1);
        await hook.unmount();
        await act(async () => {
            tree.unmount();
        });
    });
});
