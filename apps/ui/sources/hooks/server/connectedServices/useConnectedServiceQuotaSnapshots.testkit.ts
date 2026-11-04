import * as React from 'react';
import { vi } from 'vitest';
import { ConnectedServiceQuotaSnapshotV1Schema, ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId, type ConnectedAccountDaemonControlResponse, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createRootLayoutFeaturesResponse, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storageStore';
import { createQualifiedQuotaTestHarness } from './qualifiedConnectedAccountQuotaTestHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();

export type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;
export const stableCredentials = {
    token: 'e30.' + Buffer.from(JSON.stringify({ sub: 'quota-account' })).toString('base64url') + '.signature',
} as const;

export function plainQuotaResponse(snapshot: ConnectedServiceQuotaSnapshotV1 | null): Response {
    return snapshot ? Response.json({ content: { t: 'plain', v: snapshot }, metadata: {
        fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok',
    } }) : new Response('{}', { status: 404 });
}

/** Same real Auth/Home/features/store harness as V4; only predecessor HTTP/RPC responses differ. */
export async function createLegacyQuotaTestHarness(options: Readonly<{
    credentials?: AuthCredentials;
    accountMode?: 'plain' | 'e2ee';
    serverUrl?: string;
    serverIdentityId?: string;
}> = {}) {
    const credentials = options.credentials ?? (options.accountMode === 'e2ee'
        ? { ...stableCredentials, secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') }
        : stableCredentials);
    let account: { credentials: AuthCredentials } | undefined;
    const modeRead = vi.fn(async (): Promise<Response> => Response.json({ mode: options.accountMode ?? 'plain', updatedAt: 0 }));
    const plainRead = vi.fn(async (ref: ProfileRef, _init?: RequestInit): Promise<Response> => plainQuotaResponse(makeQuotaSnapshot({ serviceId: ref.serviceId as 'anthropic' | 'openai-codex' })));
    const sealedRead = vi.fn(async (_ref: ProfileRef, _init?: RequestInit): Promise<Response> => new Response('{}', { status: 404 }));
    const refreshRead = vi.fn(async (_ref: ProfileRef, _version: string): Promise<Response> => Response.json({ success: true }));
    const boundary = await createQualifiedQuotaTestHarness({ ...options, credentials,
        qualifiedAccountsProtocol: null, request: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption/currentness') {
                return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(account?.credentials ?? credentials));
            }
            if (url.pathname === '/v1/account/encryption') return modeRead();
            const match = /^\/(v2|v3)\/connect\/([^/]+)\/profiles\/([^/]+)\/quotas(\/refresh)?$/.exec(url.pathname);
            if (!match) return null;
            const ref = { serviceId: decodeURIComponent(match[2]!), profileId: decodeURIComponent(match[3]!) };
            if (match[4]) return refreshRead(ref, match[1]!);
            return match[1] === 'v3' ? plainRead(ref, init) : sealedRead(ref, init);
        },
    });
    account = boundary.account;
    boundary.control.mockImplementation(async service => ({
        status: 'described', service,
        descriptor: { id: service.localId, title: 'Predecessor service', authentication: { defaultModeId: 'manual', modes: [{
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string', minLength: 1 } }],
        }] } }, occurrenceId: 'occurrence-legacy',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'legacy-artifact', installSource: 'npm' }, accounts: [],
        operationTransport: { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: service.localId as 'anthropic' | 'openai-codex' },
    } satisfies ConnectedAccountDaemonControlResponse));
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: boundary.account.home.serverIdentityId! },
        connectedServices: { credentialDelete: { revisionGuard: true } },
    } });
    boundary.features.mockImplementation(async () => Response.json(features));
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
    storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    await updateEffectiveHomeViewState(current => ({ ...current, activeTargetKind: 'server', activeTargetId: getActiveServerSnapshot().serverId }), { scope: 'device' });
    invalidateAccountEncryptionModeCache(); modeRead.mockClear();
    return { ...boundary, modeRead, plainRead, sealedRead, refreshRead };
}

export async function resetConnectedServiceQuotaSnapshotsTestState(): Promise<void> {
    standardCleanup(); resetServerFeaturesClientForTests(); invalidateAccountEncryptionModeCache();
    const { __resetConnectedServiceQuotaSnapshotStore } = await import('./connectedServiceQuotaSnapshotStore');
    __resetConnectedServiceQuotaSnapshotStore();
}

export function createDeferredResponse() {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
}

export function makeQuotaSnapshot(params: Readonly<{
    serviceId: 'anthropic' | 'openai-codex'; profileId?: string; meterId?: string; staleAfterMs?: number; fetchedAt?: number;
}>): ConnectedServiceQuotaSnapshotV1 {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({ v: 1, serviceId: params.serviceId, profileId: params.profileId ?? 'work',
        fetchedAt: params.fetchedAt ?? Date.now(), staleAfterMs: params.staleAfterMs ?? 60_000,
        planLabel: params.serviceId === 'anthropic' ? 'Pro' : 'Plus', accountLabel: null,
        meters: params.meterId ? [{ meterId: params.meterId, label: params.meterId, used: 40, limit: 100, unit: 'count',
            utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' } }] : [],
    });
}

export function makeProviderAccountUsageSnapshot() {
    const recordKey = { providerId: 'codex', accountSubjectId: 'acct_stable', subjectKind: 'account', quotaScope: 'account' } as const;
    return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'acct_stable' }, observedAtMs: Date.now(), fetchedAtMs: Date.now(),
        staleAfterMs: 60_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', planLabel: 'Plus', accountLabel: 'Work',
        meters: [{ meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count', utilizationPct: null, remainingPct: 60,
            resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' } }],
    });
}

export function createLegacyQuotaAuthWrapper(readBoundary: () => Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>) {
    return function Wrapper({ children }: React.PropsWithChildren) {
        return React.createElement(InjectedAuthProvider, { credentials: readBoundary().account.credentials, children });
    };
}
