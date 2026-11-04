import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resolveConnectedServiceSettingsErrorMessage } from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness, quotaTestRef as ref, quotaTestSnapshot as snapshot, quotaTestResponse, quotaTestProviderUsageSnapshot } from './qualifiedConnectedAccountQuotaTestHarness';
import { projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { useQualifiedConnectedAccountQuota } from './useQualifiedConnectedAccountQuota';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { t } from '@/text';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();
// The loaded app already owns Sync before an Account's first Action; warm that real graph before restoration.
await loadSyncSingletonForTests();

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

    it.each([false, true])('parks hidden quota demand and renders while preserving a visible reader=%s and fresh reopen', async shared => {
        let visible = true;
        let renders = 0;
        const ParkedWrapper = ({ children }: React.PropsWithChildren) => <Wrapper>
            <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>{children}</PluginSurfaceFocusEligibilityProvider>
        </Wrapper>;
        const hook = await renderHook(() => { renders += 1; return useQualifiedConnectedAccountQuota(ref); }, { wrapper: ParkedWrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        const peer = shared ? await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper }) : null;
        await flushHookEffects({ cycles: 8, turns: 8 });
        visible = false;
        await hook.rerender();
        await flushHookEffects({ cycles: 8, turns: 8 });
        const reads = boundary.read.mock.calls.length;
        const held = hook.getCurrent();
        renders = 0;
        const fresh = { ...snapshot, fetchedAt: 2 };
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(fresh)));
        await act(async () => {
            publishHomeAccountChange(boundary.context().serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        if (peer) await vi.waitFor(() => expect(peer.getCurrent().snapshot).toEqual(fresh));
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect({ reads: boundary.read.mock.calls.length - reads, renders }).toEqual({ reads: shared ? 1 : 0, renders: 0 });
        expect(hook.getCurrent()).toBe(held);
        await peer?.unmount();
        visible = true;
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(fresh));
        expect(boundary.controls).toEqual([]);
        await hook.unmount();
    });

    it('opens the exact server quota and resolved usage record without machine effects', async () => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        expect(hook.getCurrent()).toMatchObject({ supported: true, usageRecordId: quotaTestResponse().sourceResolution.recordId, error: null });
        expect(boundary.read).toHaveBeenCalledWith(ref);
        expect(boundary.controls).toEqual([]);
    });

    it.each([false, true])('carries no observation for an unloaded usage record without losing its record identity (failed refresh=%s)', async failedRefresh => {
        const unobserved = projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
            snapshot: { ...quotaTestProviderUsageSnapshot(0), state: 'not_loaded', confidence: 'unknown', meters: [],
                ...(failedRefresh ? { diagnostics: [{ kind: 'provider_http', status: 429, observedAtMs: 5, retryAtMs: 10 }] } : {}),
            },
            ref,
        });
        const response = quotaTestResponse(unobserved);
        boundary.read.mockImplementation(async () => Response.json({
            ...response, metadata: { ...response.metadata, status: failedRefresh ? 'error' : 'unavailable',
            },
        }));
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({
            snapshot: null, usageRecordId: response.sourceResolution.recordId, supported: null, refreshing: false,
            // The fixture's retry time (10) has passed, so only the failure itself is said.
            error: failedRefresh ? t('connectedServices.errors.quotaRefreshFailed') : null,
        });

        // A real observation with no quota windows still has an honest read time.
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(snapshot)));
        await act(async () => {
            publishHomeAccountChange(boundary.context().serverBasis.serverId,
                [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        expect(hook.getCurrent().supported).toBe(true);
    });

    it('refreshes the exact account through the persisted selected machine and reloads its observation', async () => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
        const fresh = { ...snapshot, fetchedAt: 2 };
        boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(fresh)), { status: 200 }));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(boundary.controls).toEqual([{ machineId: 'machine-selected', command: expect.objectContaining({
            operation: 'describeService', service: ref.service,
        }) }]);
        expect(boundary.refresh).toHaveBeenCalledWith(ref);
        expect(hook.getCurrent().snapshot).toEqual(fresh);
    });

    it.each(['fresh observation', 'producer failure'] as const)(
        'keeps an acknowledged refresh pending across shared readers until a %s arrives', async outcome => {
            const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
            const detail = await renderHook(() => useQualifiedConnectedAccountQuota(ref, { refreshMachineId: null }), { wrapper: Wrapper });
            await vi.waitFor(() => expect(hook.getCurrent().snapshot).toEqual(snapshot));
            const waiting = outcome === 'producer failure'
                ? { ...snapshot, diagnostics: [{ kind: 'provider_http' as const, status: 429, observedAtMs: 5 }] }
                : snapshot;
            boundary.refresh.mockImplementation(async () => {
                boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(waiting,
                    outcome === 'producer failure' ? 'error' : 'ok', 10)));
                return Response.json({ success: true });
            });
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(boundary.refresh).toHaveBeenCalledWith(ref);
            // An older failure is last-known evidence, not completion of the newly requested attempt.
            expect(hook.getCurrent()).toMatchObject({ snapshot: waiting, refreshing: true });
            expect(detail.getCurrent()).toMatchObject({ snapshot: waiting, refreshing: true });
            // The daemon's later publication removes refreshRequestedAt to supply completion.
            const settled = outcome === 'fresh observation' ? { ...snapshot, fetchedAt: 11 }
                : { ...snapshot, diagnostics: [{ kind: 'provider_http' as const, status: 429, observedAtMs: 11 }] };
            boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(settled,
                outcome === 'producer failure' ? 'error' : 'ok')));
            await act(async () => {
                publishHomeAccountChange(boundary.context().serverBasis.serverId,
                    [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            });
            await vi.waitFor(() => expect(hook.getCurrent().refreshing).toBe(false));
            expect(hook.getCurrent().snapshot).toEqual(settled);
            expect(detail.getCurrent().snapshot).toEqual(settled);
            expect(hook.getCurrent().error).toBe(outcome === 'producer failure'
                ? t('connectedServices.errors.quotaRefreshFailed') : null);
            expect(boundary.refresh).toHaveBeenCalledOnce();
        },
    );

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
        expect(boundary.controls).toEqual([{ machineId: 'machine-selected', command: expect.objectContaining({
            operation: 'describeService', service: ref.service,
        }) }]);
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
