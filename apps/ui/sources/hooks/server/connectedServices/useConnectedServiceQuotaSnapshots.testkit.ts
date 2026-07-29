import {
    ConnectedServiceQuotaSnapshotV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { vi } from 'vitest';

import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import type {
    getProviderAccountUsageSnapshotPlain,
    getProviderAccountUsageSnapshotSealed,
} from '@/sync/api/account/apiProviderAccountUsage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const stableCredentials = {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url'),
} as const;

let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;

export const activeServerSnapshotState = {
    current: {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    },
};

export const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
export const useServerFeaturesRuntimeSnapshotSpy = vi.fn(() => ({
    status: 'ready' as const,
    features: {
        capabilities: {
            connectedServices: {
                credentialDelete: { revisionGuard: true },
            },
        },
    },
}));

const quotaSnapshotMocks = vi.hoisted(() => ({
    fetchAccountEncryptionModeSpy: vi.fn<
        (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
    >(async () => ({ mode: 'e2ee', updatedAt: 0 })),
    getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
    >(async () => null),
    getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
        (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
    >(async () => null),
    getProviderAccountUsageSnapshotPlainSpy: vi.fn<
        (...args: Parameters<typeof getProviderAccountUsageSnapshotPlain>) => ReturnType<typeof getProviderAccountUsageSnapshotPlain>
    >(async () => null),
    getProviderAccountUsageSnapshotSealedSpy: vi.fn<
        (...args: Parameters<typeof getProviderAccountUsageSnapshotSealed>) => ReturnType<typeof getProviderAccountUsageSnapshotSealed>
    >(async () => null),
}));

export const fetchAccountEncryptionModeSpy = quotaSnapshotMocks.fetchAccountEncryptionModeSpy;
export const getConnectedServiceQuotaSnapshotPlainSpy = quotaSnapshotMocks.getConnectedServiceQuotaSnapshotPlainSpy;
export const getConnectedServiceQuotaSnapshotSealedSpy = quotaSnapshotMocks.getConnectedServiceQuotaSnapshotSealedSpy;
export const getProviderAccountUsageSnapshotPlainSpy = quotaSnapshotMocks.getProviderAccountUsageSnapshotPlainSpy;
export const getProviderAccountUsageSnapshotSealedSpy = quotaSnapshotMocks.getProviderAccountUsageSnapshotSealedSpy;

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: currentCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () =>
        useServerFeaturesRuntimeSnapshotSpy(),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({
        connectedAccountsV4: [],
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

vi.mock('./useConnectedServiceLegacyOperationAdmission', () => ({
    useConnectedServiceLegacyOperationAdmission: () => async () => {},
    useConnectedAccountOperationAdmission: () => async () => {},
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

vi.mock('@/sync/api/account/apiProviderAccountUsage', () => ({
    getProviderAccountUsageSnapshotPlain: getProviderAccountUsageSnapshotPlainSpy,
    getProviderAccountUsageSnapshotSealed: getProviderAccountUsageSnapshotSealedSpy,
}));

export type PlainQuotaSnapshotResult = Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>;
export type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;

export function setCurrentCredentials(credentials: Readonly<{ token: string; secret: string }>): void {
    currentCredentials = credentials;
}

export function resetConnectedServiceQuotaSnapshotsTestState(): void {
    currentCredentials = stableCredentials;
    activeServerSnapshotState.current = {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    };
    vi.resetModules();
    vi.clearAllMocks();
    useFeatureEnabledSpy.mockReturnValue(true);
    useServerFeaturesRuntimeSnapshotSpy.mockReturnValue({
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: {
                    credentialDelete: { revisionGuard: true },
                },
            },
        },
    });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
}

export function makeQuotaSnapshot(params: Readonly<{
    serviceId: 'anthropic' | 'openai-codex';
    profileId?: string;
    meterId?: string;
    staleAfterMs?: number;
}>): NonNullable<PlainQuotaSnapshotResult> {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: params.serviceId,
        profileId: params.profileId ?? 'work',
        fetchedAt: 1,
        staleAfterMs: params.staleAfterMs ?? 60_000,
        planLabel: params.serviceId === 'anthropic' ? 'Pro' : 'Plus',
        accountLabel: null,
        meters: params.meterId
            ? [
                {
                    meterId: params.meterId,
                    label: params.meterId,
                    used: 40,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    confidence: 'exact',
                    details: { limitCategory: 'usage_limit' },
                },
            ]
            : [],
    });
}

export function createDeferredPlainSnapshot() {
    let resolve!: (value: PlainQuotaSnapshotResult) => void;
    const promise = new Promise<PlainQuotaSnapshotResult>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve } as const;
}

export function createDeferredAccountMode() {
    let resolve!: (value: Awaited<ReturnType<typeof fetchAccountEncryptionMode>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof fetchAccountEncryptionMode>>>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve } as const;
}

export function makeProviderAccountUsageSnapshot(): ProviderAccountUsageSnapshotV1 {
    const fetchedAtMs = Date.now();
    const recordKey = {
        providerId: 'codex',
        accountSubjectId: 'acct_stable',
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
            id: 'acct_stable',
        },
        observedAtMs: fetchedAtMs,
        fetchedAtMs,
        staleAfterMs: 60_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Plus',
        accountLabel: 'Work',
        meters: [
            {
                meterId: 'weekly',
                label: 'Weekly',
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
