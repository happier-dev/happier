import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type {
    QuotaSnapshotStoreEntry,
    QuotaRecoveryConsumeContext,
    QuotaRecoveryConsumeResult,
    QuotaSnapshotLoadContext,
} from './connectedServiceQuotaSnapshotStore';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RetainQuotaSnapshotPollingMock = (key: string, ctx: QuotaSnapshotLoadContext) => () => void;
type RefreshQuotaSnapshotMock = (key: string, ctx: QuotaSnapshotLoadContext) => Promise<void>;
type ConsumeQuotaRecoveryCreditMock = (
    key: string,
    ctx: QuotaRecoveryConsumeContext,
) => Promise<QuotaRecoveryConsumeResult>;

type QuotaSnapshotTestStoreState = {
    snapshot: ConnectedServiceQuotaSnapshotV1;
    listeners: Set<() => void>;
    entry: QuotaSnapshotStoreEntry;
    releaseQuotaSnapshotPolling: ReturnType<typeof vi.fn<() => void>>;
    retainQuotaSnapshotPolling: ReturnType<typeof vi.fn<RetainQuotaSnapshotPollingMock>>;
    refreshQuotaSnapshot: ReturnType<typeof vi.fn<RefreshQuotaSnapshotMock>>;
    consumeQuotaRecoveryCredit: ReturnType<typeof vi.fn<ConsumeQuotaRecoveryCreditMock>>;
};

const storeState = vi.hoisted((): QuotaSnapshotTestStoreState => {
    const releaseQuotaSnapshotPolling = vi.fn<() => void>();
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        recoveryCredits: {
            availableCount: 1,
            credits: [{ id: 'credit-1', kind: 'usage_limit_reset', status: 'available' }],
        },
        meters: [],
    };
    return {
        snapshot,
        listeners: new Set<() => void>(),
        entry: {
            snapshot: null,
            loading: false,
            error: null,
            refreshing: false,
        },
        releaseQuotaSnapshotPolling,
        retainQuotaSnapshotPolling: vi.fn<RetainQuotaSnapshotPollingMock>(() => releaseQuotaSnapshotPolling),
        refreshQuotaSnapshot: vi.fn<RefreshQuotaSnapshotMock>(async () => {}),
        consumeQuotaRecoveryCredit: vi.fn<ConsumeQuotaRecoveryCreditMock>(
            async () => ({ ok: false, error: 'consume failed' }),
        ),
    };
});

const machineState = vi.hoisted(() => ({
    machines: [
        {
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: {
                host: 'machine-1',
                platform: 'darwin',
                happyCliVersion: '0.0.0',
                happyHomeDir: '/tmp/happier',
                homeDir: '/Users/test',
            },
        },
    ],
}));

const profileState = vi.hoisted(() => ({
    current: { connectedServicesV2: [] as unknown[] },
}));

const sessionState = vi.hoisted(() => ({
    sessions: null as Array<Record<string, unknown>> | null,
}));

const activeServerState = vi.hoisted(() => ({
    current: {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/auth/storage/resolveAuthCredentialsScopeKey', () => ({
    resolveAuthCredentialsScopeKey: () => 'scope',
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerState.current,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => machineState.machines,
    useProfile: () => profileState.current,
    useSessions: () => sessionState.sessions,
}));

vi.mock('@/sync/store/hooks', () => ({
    useSetting: () => ({}),
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
}));

vi.mock('./useCredentialScopedAccountModeResolver', () => ({
    useCredentialScopedAccountModeResolver: () => vi.fn(),
}));

vi.mock('./useConnectedServiceLegacyOperationAdmission', () => ({
    useConnectedServiceLegacyOperationAdmission: () => async () => {},
}));

vi.mock('./connectedServiceQuotaSnapshotStore', () => ({
    buildQuotaSnapshotScopeKey: () => 'scope:openai-codex:work',
    retainQuotaSnapshotPolling: (key: string, ctx: QuotaSnapshotLoadContext) => (
        storeState.retainQuotaSnapshotPolling(key, ctx)
    ),
    getQuotaSnapshotEntry: () => storeState.entry,
    subscribeQuotaSnapshotEntry: (_key: string | null, listener: () => void) => {
        storeState.listeners.add(listener);
        return () => {
            storeState.listeners.delete(listener);
        };
    },
    refreshQuotaSnapshot: (key: string, ctx: QuotaSnapshotLoadContext) => (
        storeState.refreshQuotaSnapshot(key, ctx)
    ),
    consumeQuotaRecoveryCredit: (key: string, ctx: QuotaRecoveryConsumeContext) => (
        storeState.consumeQuotaRecoveryCredit(key, ctx)
    ),
}));

function notifyStore(): void {
    for (const listener of storeState.listeners) listener();
}

function createConnectedServiceSession(params: Readonly<{
    id: string;
    machineId: string;
    profileId: string;
}>): Record<string, unknown> {
    return {
        id: params.id,
        active: true,
        metadata: {
            flavor: 'codex',
            path: '/repo',
            machineId: params.machineId,
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: params.profileId,
                    },
                },
            },
        },
    };
}

beforeEach(() => {
    standardCleanup();
    storeState.listeners.clear();
    storeState.entry = {
        snapshot: storeState.snapshot,
        loading: false,
        error: null,
        refreshing: false,
    };
    storeState.releaseQuotaSnapshotPolling.mockClear();
    storeState.retainQuotaSnapshotPolling.mockClear();
    storeState.retainQuotaSnapshotPolling.mockReturnValue(storeState.releaseQuotaSnapshotPolling);
    storeState.refreshQuotaSnapshot.mockClear();
    storeState.consumeQuotaRecoveryCredit.mockClear();
    storeState.consumeQuotaRecoveryCredit.mockResolvedValue({ ok: false, error: 'consume failed' });
    machineState.machines = [
        {
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: {
                host: 'machine-1',
                platform: 'darwin',
                happyCliVersion: '0.0.0',
                happyHomeDir: '/tmp/happier',
                homeDir: '/Users/test',
            },
        },
    ];
    profileState.current = { connectedServicesV2: [] };
    activeServerState.current = {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    };
    sessionState.sessions = [createConnectedServiceSession({
        id: 'session-owner',
        machineId: 'machine-1',
        profileId: 'work',
    })];
});

describe('useConnectedServiceQuotaSnapshot', () => {
    it('retains shared polling for the mounted account quota view', async () => {
        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
        }));

        expect(storeState.retainQuotaSnapshotPolling).toHaveBeenCalledTimes(1);
        expect(storeState.retainQuotaSnapshotPolling.mock.calls[0]?.[0]).toBe('scope:openai-codex:work');
        await act(async () => {
            hook.unmount();
        });

        expect(storeState.releaseQuotaSnapshotPolling).toHaveBeenCalledTimes(1);
    });

    it('rekeys its account-mode and polling scope when the same server reconnects', async () => {
        const { useConnectedServiceQuotaSnapshot } = await import(
            './useConnectedServiceQuotaSnapshot'
        );
        const hook = await renderHook(() =>
            useConnectedServiceQuotaSnapshot({
                serviceId: 'openai-codex',
                profileId: 'work',
            }),
        );

        const firstContext =
            storeState.retainQuotaSnapshotPolling.mock.calls[0]?.[1];
        expect(firstContext?.credentialScope).toContain(
            '\u00001\u0000',
        );

        activeServerState.current = {
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 2,
        };
        await hook.rerender();
        await flushHookEffects();

        expect(
            storeState.retainQuotaSnapshotPolling,
        ).toHaveBeenCalledTimes(2);
        const secondContext =
            storeState.retainQuotaSnapshotPolling.mock.calls[1]?.[1];
        expect(secondContext?.credentialScope).toContain(
            '\u00002\u0000',
        );
        expect(
            secondContext?.credentialScope,
        ).not.toBe(firstContext?.credentialScope);
        await hook.unmount();
    });

    it('still retains polling when the credential status is empty/unknown (fails OPEN)', async () => {
        // Regression: a healthy account whose status is absent (coerced to '')
        // must keep polling usage. The fail-CLOSED normalize maps '' ->
        // needs_reauth and wrongly suppressed the read, blanking the capacity
        // avatar. Display/fetch must fail OPEN and hide only for an EXPLICIT
        // needs_reauth.
        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
            credentialHealthStatus: '',
        }));

        expect(storeState.retainQuotaSnapshotPolling).toHaveBeenCalledTimes(1);
    });

    it('does not retain polling for an explicit needs_reauth credential', async () => {
        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
            credentialHealthStatus: 'needs_reauth',
        }));

        expect(storeState.retainQuotaSnapshotPolling).not.toHaveBeenCalled();
        expect(hook.getCurrent().canRefresh).toBe(false);
    });

    it('clears a transient consume error when a manual refresh starts', async () => {
        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
        }));

        await act(async () => {
            await hook.getCurrent().consumeRecoveryCredit('credit-1');
        });

        expect(hook.getCurrent().error).toBe('consume failed');

        await act(async () => {
            await hook.getCurrent().refresh();
        });

        expect(storeState.refreshQuotaSnapshot).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().error).toBe(null);
    });

    it('clears a transient consume error after a successful snapshot update arrives', async () => {
        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
        }));

        await act(async () => {
            await hook.getCurrent().consumeRecoveryCredit('credit-1');
        });

        expect(hook.getCurrent().error).toBe('consume failed');

        await act(async () => {
            storeState.entry = {
                ...storeState.entry,
                snapshot: { ...storeState.snapshot, fetchedAt: storeState.snapshot.fetchedAt + 1 },
            };
            notifyStore();
        });
        await flushHookEffects();

        expect(hook.getCurrent().error).toBe(null);
    });

    it('targets the online machine that owns the connected-service profile when consuming recovery credit', async () => {
        machineState.machines = [
            {
                id: 'machine-arbitrary',
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                metadata: {
                    host: 'machine-arbitrary',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    happyHomeDir: '/tmp/happier',
                    homeDir: '/Users/test',
                },
            },
            {
                id: 'machine-owner',
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                metadata: {
                    host: 'machine-owner',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    happyHomeDir: '/tmp/happier',
                    homeDir: '/Users/test',
                },
            },
        ];
        sessionState.sessions = [createConnectedServiceSession({
            id: 'session-owner',
            machineId: 'machine-owner',
            profileId: 'work',
        })];
        storeState.consumeQuotaRecoveryCredit.mockResolvedValue({
            ok: true,
            receipt: { idempotencyKey: 'test-reset', status: 'consumed' },
        });

        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
        }));

        expect(hook.getCurrent().recoveryCreditMachineId).toBe('machine-owner');

        await act(async () => {
            await hook.getCurrent().consumeRecoveryCredit('credit-1');
        });

        expect(storeState.consumeQuotaRecoveryCredit).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                serviceId: 'openai-codex',
                profileId: 'work',
                machineId: 'machine-owner',
                providerCreditId: 'credit-1',
            }),
        );
    });

    it('does not consume recovery credit on an unrelated active machine', async () => {
        machineState.machines = [
            {
                id: 'machine-arbitrary',
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                metadata: {
                    host: 'machine-arbitrary',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    happyHomeDir: '/tmp/happier',
                    homeDir: '/Users/test',
                },
            },
        ];
        sessionState.sessions = [createConnectedServiceSession({
            id: 'session-other-profile',
            machineId: 'machine-arbitrary',
            profileId: 'personal',
        })];

        const { useConnectedServiceQuotaSnapshot } = await import('./useConnectedServiceQuotaSnapshot');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshot({
            serviceId: 'openai-codex',
            profileId: 'work',
        }));

        expect(hook.getCurrent().recoveryCreditMachineId).toBeNull();

        await act(async () => {
            await hook.getCurrent().consumeRecoveryCredit('credit-1');
        });

        expect(storeState.consumeQuotaRecoveryCredit).not.toHaveBeenCalled();
        expect(hook.getCurrent().error).toBeTruthy();
    });
});
