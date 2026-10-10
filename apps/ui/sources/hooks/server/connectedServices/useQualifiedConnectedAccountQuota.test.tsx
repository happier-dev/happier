import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resolveConnectedServiceSettingsErrorMessage } from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from './qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness, quotaTestRef as ref, quotaTestSnapshot as snapshot, quotaTestResponse } from './qualifiedConnectedAccountQuotaTestHarness';
import { useQualifiedConnectedAccountQuota } from './useQualifiedConnectedAccountQuota';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();

describe('useQualifiedConnectedAccountQuota', () => {
    let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
    function Wrapper({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={boundary.account.credentials}>{children}</InjectedAuthProvider>;
    }
    const missing = () => new Response(JSON.stringify({ error: 'connect_quotas_not_found' }), { status: 404 });

    beforeEach(async () => {
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        boundary = await createQualifiedQuotaTestHarness();
    });
    afterEach(async () => {
        standardCleanup();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        await boundary?.dispose();
        vi.restoreAllMocks();
    });

    it('opens the exact server quota and resolved usage record without machine effects', async () => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        expect(hook.getCurrent()).toMatchObject({ supported: true, usageRecordId: quotaTestResponse().sourceResolution.recordId, error: null });
        expect(boundary.read).toHaveBeenCalledWith(ref);
        expect(boundary.controls).toEqual([]);
    });

    it('refreshes the exact account through the persisted selected machine and reloads its observation', async () => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        const fresh = { ...snapshot, fetchedAt: 2 };
        boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(fresh)), { status: 200 }));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(boundary.controls).toEqual([{ machineId: 'machine-selected', command: { operation: 'describeService', service: ref.service, requiredOperation: 'quota_refresh' } }]);
        expect(boundary.refresh).toHaveBeenCalledWith(ref);
        expect(hook.getCurrent().snapshot).toEqual(fresh);
    });

    it('keeps an absent first snapshot refreshable until the real quota leaf refuses', async () => {
        boundary.read.mockImplementation(async () => missing());
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ supported: null, snapshot: null, error: null });
        boundary.control.mockResolvedValue({ status: 'unavailable', code: 'connected_account_v4_operation_unsupported' });
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().supported).toBe(false);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it.each([null, 'machine-first'])('keeps last-known quota readable while the explicit detail refresh target %s is refused', async (refreshMachineId) => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref, { refreshMachineId }), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ snapshot, refreshing: false });
        expect(hook.getCurrent().error).not.toBeNull();
        expect(boundary.controls).toEqual([]);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it('keeps last-known-good quota and localizes a daemon refusal', async () => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        const failure = { code: 'quota_refresh_unavailable' };
        boundary.control.mockResolvedValue({ status: 'unavailable', code: failure.code });
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ snapshot, refreshing: false, error: resolveConnectedServiceSettingsErrorMessage(failure) });
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it.each([true, false])('never exposes a prior account observation or support state after a changed-ref read fails (observed=%s)', async (observed) => {
        if (!observed) boundary.read.mockImplementation(async () => missing());
        const hook = await renderHook((currentRef: typeof ref) => useQualifiedConnectedAccountQuota(currentRef), { initialProps: ref, wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        if (observed) expect(hook.getCurrent().snapshot).toEqual(snapshot);
        // Use a terminal refusal; HTTP 503 legitimately stays in the real
        // transport's retry lifecycle before publishing a final read error.
        boundary.read.mockImplementation(async () => new Response(JSON.stringify({ error: 'connected_account_service_unavailable' }), { status: 400 }));
        const changedRef = { ...ref, accountId: 'account-b' };
        await hook.rerender(changedRef);
        expect(hook.getCurrent().snapshot).toBeNull();
        await vi.waitFor(() => expect(hook.getCurrent().error).not.toBeNull());
        expect(boundary.read).toHaveBeenLastCalledWith(changedRef);
        expect(hook.getCurrent()).toMatchObject({ supported: null, snapshot: null, loading: false });
    });
});
