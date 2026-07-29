import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const getQuotaMock = vi.hoisted(() => vi.fn());
const requestRefreshMock = vi.hoisted(() => vi.fn());
const operationAdmissionMock = vi.hoisted(() => vi.fn());
const openQuotaMock = vi.hoisted(() => vi.fn());
const cryptoMaterial = vi.hoisted(() => ({
    type: 'legacy' as const,
    secret: new Uint8Array(32),
}));
const credentials = vi.hoisted(() => ({
    token: 'token',
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials }),
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    }),
}));
vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    getQualifiedConnectedAccountQuotaV4: getQuotaMock,
    requestQualifiedConnectedAccountQuotaRefreshV4: requestRefreshMock,
}));
vi.mock('./useConnectedServiceLegacyOperationAdmission', () => ({
    useConnectedAccountOperationAdmission: () => operationAdmissionMock,
}));
vi.mock('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials', () => ({
    resolveAccountScopedCryptoMaterialFromCredentials: () => cryptoMaterial,
}));
vi.mock('@happier-dev/protocol', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/protocol')>(),
    openQualifiedConnectedAccountQuotaResponseV4: openQuotaMock,
}));

const ref = {
    service: {
        pluginId: 'acme.accounts',
        localId: 'work',
    },
    accountId: 'account-a',
};
const response = {
    ref,
    content: {
        t: 'plain' as const,
        v: {
            v: 1 as const,
            ref,
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [],
        },
    },
    metadata: {
        fetchedAt: 1,
        staleAfterMs: 60_000,
        status: 'ok' as const,
    },
};

describe('useQualifiedConnectedAccountQuota', () => {
    beforeEach(async () => {
        standardCleanup();
        const { __resetQualifiedConnectedAccountQuotaSnapshotStore } =
            await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        getQuotaMock.mockReset();
        requestRefreshMock.mockReset();
        operationAdmissionMock.mockReset();
        operationAdmissionMock.mockResolvedValue(undefined);
        openQuotaMock.mockReset();
    });

    it('opens the qualified response with the exact ref and preserves its snapshot', async () => {
        getQuotaMock.mockResolvedValueOnce(response);
        openQuotaMock.mockReturnValueOnce(response.content.v);

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref));
        await flushHookEffects();

        expect(getQuotaMock).toHaveBeenCalledWith(credentials, ref, {
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
        });
        expect(operationAdmissionMock).toHaveBeenCalledWith(
            ref.service,
            { kind: 'v4' },
            'quota_read',
        );
        expect(openQuotaMock).toHaveBeenCalledWith({
            response,
            expectedRef: ref,
            material: cryptoMaterial,
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            supported: true,
            snapshot: response.content.v,
            error: null,
        }));
    });

    it('hides only the quota affordance when the exact service has no quota leaf', async () => {
        getQuotaMock.mockResolvedValueOnce(null);

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            supported: false,
            snapshot: null,
            error: null,
        }));
        expect(openQuotaMock).not.toHaveBeenCalled();
    });

    it('refreshes and reloads only the exact qualified account', async () => {
        getQuotaMock
            .mockResolvedValueOnce(response)
            .mockResolvedValueOnce(response);
        openQuotaMock.mockReturnValue(response.content.v);

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref));
        await flushHookEffects();
        await act(async () => {
            await hook.getCurrent().refresh();
        });

        expect(requestRefreshMock).toHaveBeenCalledWith(credentials, ref, {
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
        });
        expect(operationAdmissionMock.mock.calls.map((call) => call[2]))
            .toEqual(['quota_read', 'quota_refresh', 'quota_read']);
        expect(getQuotaMock).toHaveBeenCalledTimes(2);
        expect(getQuotaMock).toHaveBeenLastCalledWith(credentials, ref, {
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
        });
    });

    it('clears the prior snapshot when refresh or reopening fails', async () => {
        getQuotaMock.mockResolvedValueOnce(response);
        openQuotaMock.mockReturnValueOnce(response.content.v);
        requestRefreshMock.mockRejectedValueOnce(
            Object.assign(new Error('stale'), { code: 'qualified_quota_stale' }),
        );

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref));
        await flushHookEffects();
        expect(hook.getCurrent().snapshot).toEqual(response.content.v);

        await act(async () => {
            await hook.getCurrent().refresh();
        });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            snapshot: null,
            error: 'qualified_quota_stale',
        }));
    });

    it('never exposes account A quota under a changed exact account basis', async () => {
        const refB = {
            ...ref,
            accountId: 'account-b',
        };
        getQuotaMock
            .mockResolvedValueOnce(response)
            .mockRejectedValueOnce(
                Object.assign(new Error('unavailable'), {
                    code: 'qualified_quota_unavailable',
                }),
            );
        openQuotaMock.mockReturnValueOnce(response.content.v);

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(
            (currentRef: typeof ref) =>
                useQualifiedConnectedAccountQuota(currentRef),
            { initialProps: ref },
        );
        await flushHookEffects();
        expect(hook.getCurrent().snapshot?.ref.accountId).toBe('account-a');

        const changed = await hook.rerender(refB);
        expect(changed.snapshot).toBeNull();
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            snapshot: null,
            error: 'qualified_quota_unavailable',
        }));
    });

    it('does not let prior unsupported state hide a changed-basis error', async () => {
        const refB = { ...ref, accountId: 'account-b' };
        getQuotaMock
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(
                Object.assign(new Error('unavailable'), {
                    code: 'qualified_quota_unavailable',
                }),
            );

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(
            (currentRef: typeof ref) =>
                useQualifiedConnectedAccountQuota(currentRef),
            { initialProps: ref },
        );
        await flushHookEffects();
        expect(hook.getCurrent().supported).toBe(false);

        await hook.rerender(refB);
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            supported: true,
            snapshot: null,
            error: 'qualified_quota_unavailable',
        }));
    });

    it('does not issue a V4 request when daemon admission contradicts V4', async () => {
        operationAdmissionMock.mockRejectedValueOnce(Object.assign(
            new Error('unsupported'),
            { code: 'connected_account_v4_operation_unsupported' },
        ));

        const { useQualifiedConnectedAccountQuota } = await import(
            './useQualifiedConnectedAccountQuota'
        );
        const hook = await renderHook(() =>
            useQualifiedConnectedAccountQuota(ref));
        await flushHookEffects();

        expect(getQuotaMock).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            supported: true,
            snapshot: null,
            error: 'connected_account_v4_operation_unsupported',
        }));
    });
});
