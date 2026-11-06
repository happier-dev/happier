import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageRecordId,
    ConnectedServiceQuotaSnapshotV1Schema,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountQuotaSnapshotV4Schema,
    type AccountProfile,
    type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import type { Settings } from '@/sync/domains/settings/settings';
import { renderHookAndCollectValues } from '../serverFeatureHookHarness.testHelpers';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, plainQuotaResponse,
    resetConnectedServiceQuotaSnapshotsTestState } from './useConnectedServiceQuotaSnapshots.testkit';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('useConnectedServiceQuotaSummaries', () => {
    let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
    const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
    beforeEach(async () => {
        await resetConnectedServiceQuotaSnapshotsTestState();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        boundary = await createLegacyQuotaTestHarness();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(null));
        setQualifiedResponse(null);
    });
    afterEach(async () => { standardCleanup(); await boundary.dispose(); vi.restoreAllMocks(); });

    function setProfile(profile: Pick<AccountProfile, 'connectedAccountsV4' | 'connectedServicesV2'>
        & Partial<Pick<AccountProfile, 'connectedAccountGroupsV4'>>) {
        storage.getState().applyProfile({ ...profileDefaults, id: 'quota-account', ...profile });
    }
    function setQuotaSettings(settings: Pick<Settings,
        'connectedServicesQuotaPinnedMeterIdsByKey' | 'connectedServicesQuotaSummaryStrategyByKey'>) {
        storage.getState().applySettings({ ...storage.getState().settings, ...settings }, 2);
    }
    function advertiseQualifiedAccounts() {
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: boundary.account.home.serverIdentityId! },
            connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } },
        } });
        boundary.features.mockImplementation(async () => Response.json(features));
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
    }
    function setQualifiedResponse(response: ReturnType<typeof QualifiedConnectedAccountQuotaResponseV4Schema.parse> | null) {
        boundary.read.mockImplementation(async () => response ? Response.json(response)
            : Response.json({ error: 'connect_quotas_not_found' }, { status: 404 }));
    }
    function setPlainSnapshot(snapshot: ReturnType<typeof ConnectedServiceQuotaSnapshotV1Schema.parse>) {
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(snapshot));
    }

    it('summarizes a novel qualified V4 account without falling through a scalar V2 service id', async () => {
        const ref = {
            service: {
                pluginId: 'acme.connected.accounts',
                localId: 'gateway',
            },
            accountId: 'work',
        } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            v: 1,
            ref,
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Acme Pro',
            accountLabel: null,
            activeAccountId: 'acme-work',
            meters: [{
                meterId: 'weekly',
                label: 'Weekly',
                used: 40,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: { limitCategory: 'usage_limit' },
            }],
        });
        setQualifiedResponse(
            QualifiedConnectedAccountQuotaResponseV4Schema.parse({
                ref,
                sourceResolution: {
                    source: { ref, bindingKind: 'account' },
                    recordId: buildProviderAccountUsageRecordId({
                        providerId: 'acme',
                        accountSubjectId: 'acme-work',
                        subjectKind: 'account',
                        quotaScope: 'account',
                    }),
                    providerAccountId: 'acme-work',
                    fetchedAt: 1,
                    staleAfterMs: 60_000,
                },
                content: { t: 'plain', v: snapshot },
                metadata: {
                    fetchedAt: 1,
                    staleAfterMs: 60_000,
                    status: 'ok',
                },
            }),
        );
        advertiseQualifiedAccounts();
        setProfile({
            connectedAccountsV4: [account],
            connectedServicesV2: [],
        });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries(), { wrapper: Wrapper });

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(seen.at(-1)?.summaries).toHaveLength(1);
        expect(seen.at(-1)?.summaries[0]).toMatchObject({
            service: ref.service,
            profileId: 'work',
            fetchedAt: 1,
        });
        expect(boundary.read).toHaveBeenCalledWith(ref);
        expect(boundary.plainRead).not.toHaveBeenCalled();
        expect(boundary.sealedRead).not.toHaveBeenCalled();
    });

    it('carries each account\'s name, email and id as they are (the one presenter hides them) and groups it under its provider', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'acct_9f2c' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
            providerIdentity: { email: 'kevin@gmail.com' },
        } satisfies QualifiedConnectedAccountProfileV4;
        const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            v: 1, ref, fetchedAt: 5, staleAfterMs: 60_000, planLabel: 'Pro', accountLabel: null, activeAccountId: 'acct_9f2c',
            meters: [{
                meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count', utilizationPct: null,
                resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' },
            }],
        });
        setQualifiedResponse(QualifiedConnectedAccountQuotaResponseV4Schema.parse({
            ref,
            sourceResolution: {
                source: { ref, bindingKind: 'account' },
                recordId: buildProviderAccountUsageRecordId({
                    providerId: 'acme', accountSubjectId: 'acct_9f2c', subjectKind: 'account', quotaScope: 'account',
                }),
                providerAccountId: 'acct_9f2c',
                fetchedAt: 5,
                staleAfterMs: 60_000,
            },
            content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: 5, staleAfterMs: 60_000, status: 'ok' },
        }));
        advertiseQualifiedAccounts();
        setProfile({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });

        // Identity display follows the device's "Hide account emails and IDs" through
        // `presentConnectedAccountIdentity`; the summary never masks on its own.
        expect(seen.at(-1)?.summaries[0]).toMatchObject({
            accountLabel: null,
            accountEmail: 'kevin@gmail.com',
            accountId: 'acct_9f2c',
            serviceGroupKey: 'acme.connected.accounts/gateway',
        });
    });

    it('names a built-in service by its own name before its descriptor projection arrives, never "Connected service"', async () => {
        const { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } = await import('@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility');
        const legacyServiceId = 'openai-codex';
        const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[legacyServiceId];
        const ref = { service: compatibility.service, accountId: '97bd5614-8970-4068-87f0-1d2c3b4a5e6f' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
            v: 1, ref, fetchedAt: 5, staleAfterMs: 60_000, planLabel: null, accountLabel: null, activeAccountId: ref.accountId,
            meters: [{
                meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count', utilizationPct: null,
                resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' },
            }],
        });
        setQualifiedResponse(QualifiedConnectedAccountQuotaResponseV4Schema.parse({
            ref,
            sourceResolution: {
                source: { ref, bindingKind: 'account' },
                recordId: buildProviderAccountUsageRecordId({
                    providerId: 'acme', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account',
                }),
                providerAccountId: ref.accountId,
                fetchedAt: 5,
                staleAfterMs: 60_000,
            },
            content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: 5, staleAfterMs: 60_000, status: 'ok' },
        }));
        advertiseQualifiedAccounts();
        setProfile({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });

        expect(seen.at(-1)?.summaries[0]).toMatchObject({ serviceLabel: 'ChatGPT', legacyServiceId });
    });

    it('says which connected accounts have no usage yet: still being read, or read and unavailable', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        advertiseQualifiedAccounts();
        setProfile({ connectedAccountsV4: [account], connectedServicesV2: [] });
        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');

        // The provider answers without usage: the read settled, so the account is unavailable.
        setQualifiedResponse(null);
        const settled = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });
        expect(settled.at(-1)?.accountsWithoutUsage).toEqual([
            expect.objectContaining({ accountLabel: null, accountId: 'work', serviceGroupKey: 'acme.connected.accounts/gateway', state: 'unavailable' }),
        ]);

        // A read still in flight is loading, never "unavailable".
        const { __resetQualifiedConnectedAccountQuotaSnapshotStore } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        boundary.read.mockImplementation(() => new Promise(() => {}));
        const pending = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });
        expect(pending.at(-1)?.accountsWithoutUsage).toEqual([expect.objectContaining({ state: 'loading' })]);
    });

    it('names the accounts that need a new sign-in, counts keys that report no limits, and marks the account a pool uses now', async () => {
        const service = { pluginId: 'acme.connected.accounts', localId: 'gateway' } as const;
        const profile = (accountId: string, fields: Partial<QualifiedConnectedAccountProfileV4>): QualifiedConnectedAccountProfileV4 => ({
            ref: { service, accountId },
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
            ...fields,
        } as QualifiedConnectedAccountProfileV4);
        const signedOut = profile('work', { status: 'needs_reauth', providerIdentity: { email: 'leeroy@company.com' } });
        const key = profile('build', { kind: 'token' });
        const personal = profile('personal', {});
        advertiseQualifiedAccounts();
        setProfile({
            connectedAccountsV4: [signedOut, key, personal],
            connectedServicesV2: [],
            connectedAccountGroupsV4: [{ ref: { service, groupId: 'pool' }, activeConnectedAccountId: 'personal', members: [] }],
        } as never);
        setQualifiedResponse(null);
        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');

        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });
        const last = seen.at(-1)!;

        expect(last.accountsNeedingSignIn).toEqual([
            expect.objectContaining({ accountEmail: 'leeroy@company.com', accountId: 'work', ref: { service, accountId: 'work' } }),
        ]);
        // A key reports no limits: counted once, never listed as "unavailable".
        expect(last.keysWithoutLimits).toBe(1);
        expect(last.accountsWithoutUsage.map((account) => account.accountId)).toEqual(['personal']);
        expect(last.inUseAccountKeys).toEqual(new Set(['acme.connected.accounts%2Fgateway/personal']));
    });

    it('reads only the cache when asked, never the server, and says when each summary was read', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        advertiseQualifiedAccounts();
        setProfile({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' }), { wrapper: Wrapper });

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(seen.at(-1)?.summaries).toEqual([]);
        // Nothing was read, so nothing is claimed about the account.
        expect(seen.at(-1)?.accountsWithoutUsage).toEqual([]);
        expect(boundary.read).not.toHaveBeenCalled();
    });

    it('reads the server once per launch when asked to load once, however many surfaces mount', async () => {
        const ref = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' } as const;
        const account = {
            ref,
            status: 'connected',
            authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned',
            credentialRevision: 'revision-1',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        advertiseQualifiedAccounts();
        setProfile({ connectedAccountsV4: [account], connectedServicesV2: [] });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });
        await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'once' }), { wrapper: Wrapper });

        expect(boundary.read).toHaveBeenCalledTimes(1);
    });

    it('preserves pinned meter order for primary summaries', async () => {
        setProfile({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });
        setQuotaSettings({
            connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['monthly', 'weekly'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'anthropic/work': 'primary' },
        });
        setPlainSnapshot(ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: {},
                },
                {
                    meterId: 'monthly',
                    label: 'Monthly',
                    used: 44,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: {},
                },
            ],
        }));

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries(), { wrapper: Wrapper });

        const last = seen.at(-1);
        expect(last?.summaries[0]?.primaryMeter?.meterId).toBe('monthly');
        expect(last?.summaries[0]?.meters.map((meter) => meter.meterId)).toEqual(['monthly', 'weekly']);
    });

    it('projects the provider-reported remaining percentage, not one derived from utilization', async () => {
        setProfile({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });
        setQuotaSettings({
            connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'anthropic/work': 'primary' },
        });
        setPlainSnapshot(ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 40,
                    limit: 100,
                    unit: 'count',
                    // The provider reports both; remaining is authoritative and
                    // is NOT the complement of the reported utilization.
                    utilizationPct: 90,
                    remainingPct: 25,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'usage_limit' },
                },
            ],
        }));

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries(), { wrapper: Wrapper });

        expect(seen.at(-1)?.summaries[0]?.primaryMeter?.remainingPct).toBe(25);
    });

    it('ranks min-remaining summaries only across comparable meters', async () => {
        setProfile({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });
        setQuotaSettings({
            connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly', 'burst'] },
            connectedServicesQuotaSummaryStrategyByKey: { 'anthropic/work': 'min_remaining' },
        });
        setPlainSnapshot(ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 40,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'usage_limit' },
                },
                {
                    meterId: 'burst',
                    label: 'Burst',
                    used: 95,
                    limit: 100,
                    unit: 'requests',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'rate_limit' },
                },
            ],
        }));

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries(), { wrapper: Wrapper });

        // A rate-limit meter in another comparable family must not become the
        // headline number just because it has less remaining.
        expect(seen.at(-1)?.summaries[0]?.primaryMeter?.meterId).toBe('weekly');
        expect(seen.at(-1)?.summaries[0]?.meters.map((meter) => meter.meterId))
            .toEqual(['weekly', 'burst']);
    });

    it('requests summaries for retryable refresh-failure profiles because they remain usable', async () => {
        setProfile({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'retryable',
                            status: 'refresh_failed_retryable',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries(), { wrapper: Wrapper });

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(boundary.plainRead).toHaveBeenCalledWith(
            expect.objectContaining({ serviceId: 'anthropic', profileId: 'retryable' }), expect.anything(),
        );
    });

    it('still requests summaries for an empty/unknown status (fails OPEN) and skips only explicit needs_reauth', async () => {
        // Usage DISPLAY fails open: absent/'' status must not silently drop a
        // healthy profile from quota summaries; only an explicit, recognized
        // needs_reauth is excluded (shouldHideQuotaForCredentialStatus fold).
        setProfile({
            connectedAccountsV4: [],
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'unknown-status',
                            // Raw wire value outside the typed enum — the display gate must fail OPEN.
                            status: '' as unknown as 'connected',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                        {
                            profileId: 'reauth',
                            status: 'needs_reauth',
                            kind: 'oauth',
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                },
            ],
        });

        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaSummaries(), { wrapper: Wrapper });

        expect(seen.at(-1)?.hasConnectedProfiles).toBe(true);
        expect(boundary.plainRead).toHaveBeenCalledWith(
            expect.objectContaining({ serviceId: 'anthropic', profileId: 'unknown-status' }), expect.anything(),
        );
        expect(boundary.plainRead).not.toHaveBeenCalledWith(
            expect.objectContaining({ profileId: 'reauth' }),
            expect.anything(),
        );
    });
});
