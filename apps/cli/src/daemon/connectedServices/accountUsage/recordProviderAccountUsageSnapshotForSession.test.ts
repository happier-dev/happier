import { resolveProviderAccountUsageAuthoritativeSource } from './runtimeSource';
import { buildProviderAccountUsageIdentityFromQualifiedAccount } from './qualifiedAccountIdentity';
import {
    buildProviderAccountUsageRecordId,
    openSealedProviderAccountUsageSnapshot,
    QualifiedProviderAccountUsageWriteV4Schema,
    SealedProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { getProviderAccountUsageRefreshErrorAt } from '@happier-dev/protocol/connect/account-usage-primitives';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QualifiedProviderAccountUsagePersistenceTarget } from './persistence';
import type { ProviderAccountUsageAdoptionV1 } from './adoption';
import {
    recordProviderAccountUsageAdoptionForSession,
    recordProviderAccountUsageSnapshotForSession,
} from './recordProviderAccountUsageSnapshotForSession';
import { createProviderAccountUsageStore } from './store';
import { matchesCurrentQuotaObservationCredential } from '../quotas/proof/quotaProbeFreshProof';
import { createProviderAccountUsagePersistenceScheduler, type ProviderAccountUsagePersistenceScheduler } from './persistence';
import { readProviderAccountUsageQuotaV4 } from './readQuota';

function createRecordKey(accountSubjectId = 'acct_123'): ProviderAccountUsageRecordKeyV1 {
    return {
        providerId: 'codex',
        accountSubjectId,
        subjectKind: accountSubjectId.startsWith('provisional:') ? 'unknown' : 'account',
        quotaScope: 'account',
    };
}

function createSnapshot(
    recordKey = createRecordKey(),
): ProviderAccountUsageSnapshotV1 {
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: recordKey.accountSubjectId.startsWith('provisional:')
                ? 'provisionalLocalSubject'
                : 'providerSubject',
            id: recordKey.accountSubjectId,
        },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        meters: [],
    };
}

const profileSource = {
    serviceId: 'happier.agent.codex/openai-codex',
    profileId: 'work',
    bindingKind: 'profile',
} as const satisfies ConnectedServiceUsageSourceV1;

function createTarget(
    source: ConnectedServiceUsageSourceV1 = profileSource,
): QualifiedProviderAccountUsagePersistenceTarget {
    return {
        source: source.bindingKind === 'group_member'
            ? {
                ref: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: source.profileId,
                },
                bindingKind: 'group_member',
                groupId: source.groupId,
                ...(source.groupGeneration === undefined
                    ? {}
                    : { groupGeneration: source.groupGeneration }),
            }
            : {
                ref: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: source.profileId,
                },
                bindingKind: 'account',
            },
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        expectedConfigurationRevision: 'cfg-current',
    };
}

const schedulers: ProviderAccountUsagePersistenceScheduler[] = [];
const writes: ReturnType<typeof QualifiedProviderAccountUsageWriteV4Schema.parse>[] = [];

beforeEach(() => {
    // HTTP is the boundary; the recorder, store, queue, envelope and V4 writer stay real.
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        writes.push(QualifiedProviderAccountUsageWriteV4Schema.parse(body));
        return { status: 200, data: { success: true, source: { status: 'linked' } } };
    });
});

afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    writes.length = 0;
    vi.restoreAllMocks();
});

function createPersistence(): ProviderAccountUsagePersistenceScheduler {
    const scheduler = createProviderAccountUsagePersistenceScheduler({
        api: { getAccountEncryptionMode: async () => 'plain' },
        credentials: { token: 'token', encryption: null },
        now: () => 2_000, fingerprintKey: new Uint8Array(32).fill(3),
    });
    schedulers.push(scheduler);
    return scheduler;
}

describe('recordProviderAccountUsageSnapshotForSession', () => {
    it('qualifies identity-free native allowance at the selected account and rejects foreign or stale sources', async () => {
        const store = createProviderAccountUsageStore();
        const provisional = createSnapshot(createRecordKey('provisional:native-session'));
        const source = { serviceId: 'acme.agent/native-account', profileId: 'selected', bindingKind: 'group_member',
            groupId: 'pool', groupGeneration: 4 } as const;
        const identity = buildProviderAccountUsageIdentityFromQualifiedAccount({
            ref: { service: { pluginId: 'acme.agent', localId: 'native-account' }, accountId: 'selected' },
            providerIdentity: { accountId: 'native-owner' }, usageIdentity: { providerId: 'acme' },
        });
        // Identity is the selected credential HTTP response's metadata, never native event data.
        const record = (claimed: ConnectedServiceUsageSourceV1 = source, credentialFingerprint?: string | null) =>
            recordProviderAccountUsageSnapshotForSession({
                getChildren: () => [{ happySessionId: 'sess_1' }], store, persistence: null,
                sessionId: 'sess_1', snapshot: provisional, observation: { sources: [claimed] },
                ...(credentialFingerprint === undefined ? {} : { credentialFingerprint }),
                resolveAuthoritativeSource: async claimed => resolveProviderAccountUsageAuthoritativeSource({ source: claimed,
                    activeBindings: [{ serviceId: source.serviceId, profileId: source.profileId, groupId: source.groupId,
                        groupGeneration: source.groupGeneration, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }] }),
                resolveRuntimeSourceIdentity: async () => identity,
            });
        expect(await record()).toMatchObject({ status: 'snapshot_advanced', recordId: identity.recordId, qualifiedSource: source });
        expect(store.resolveBySource(source)?.accountSubject).toEqual({ kind: 'providerSubject', id: 'native-owner' });
        expect(store.resolveRecordId(provisional.recordId)).toBeNull();
        expect(await record()).toMatchObject({ status: 'duplicate', recordId: identity.recordId });
        expect(await record({ ...source, profileId: 'foreign' })).toMatchObject({ status: 'credential_fingerprint_mismatch' });
        expect(await record({ ...source, groupGeneration: 3 })).toMatchObject({ status: 'credential_fingerprint_mismatch' });
        expect(await record(source, null)).toMatchObject({ status: 'credential_fingerprint_mismatch' });
        expect(store.resolveBySource({ ...source, profileId: 'foreign' })).toBeNull();
    });


    it.each(['plain', 'e2ee'] as const)('recovers unchanged %s usage after six transient Home write failures through the session recorder and quota reader', async mode => {
        vi.useFakeTimers();
        vi.setSystemTime(1_500);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const credentials = { token: 'token', encryption: mode === 'plain' ? null : encryption };
        let attempts = 0;
        // Only HTTP is replaced: session admission, queue, envelope, writer and read decoder stay real.
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            attempts += 1;
            if (attempts <= 6) throw { response: { status: 503, data: { error: 'temporarily_unavailable' } } };
            writes.push(QualifiedProviderAccountUsageWriteV4Schema.parse(body));
            return { status: 200, data: { success: true, source: { status: 'linked' } } };
        });
        const snapshot = createSnapshot();
        const target = createTarget();
        const persistence = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => mode }, credentials, now: Date.now,
            fingerprintKey: new Uint8Array(32).fill(3), randomBytes: length => new Uint8Array(length).fill(9),
        });
        const store = createProviderAccountUsageStore();
        const record = () => recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }], store, persistence,
            sessionId: 'sess_1', snapshot, observation: { sources: [profileSource] },
            credentialFingerprint: 'sha256:deadbeef', verifyCredentialFingerprint: async () => true,
            resolveAuthoritativeSource: async () => profileSource,
            resolvePersistenceTargets: async () => [target],
        });
        try {
            expect(await record()).toMatchObject({ persisted: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(attempts).toBe(1);
            await vi.advanceTimersByTimeAsync(999);
            expect(attempts).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(attempts).toBe(2);
            await vi.runAllTimersAsync();
            expect(writes).toHaveLength(1);
            expect(attempts).toBe(7);
            const write = writes[0]!;
            vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data:
                String(url).includes('/sources/resolve')
                    ? { source: target.source, recordId: snapshot.recordId, providerAccountId: 'acct_123', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs }
                    : { content: mode === 'plain' ? { t: 'plain', v: write.snapshot } : { t: 'encrypted', c: SealedProviderAccountUsageSnapshotV1Schema.parse(write.sealedPayload).ciphertext },
                        metadata: { fetchedAt: write.fetchedAt, staleAfterMs: write.staleAfterMs, status: write.status }, sources: [target.source] },
            }));
            const read = await readProviderAccountUsageQuotaV4({ source: target.source }, {
                credentials, accountMode: mode, nowMs: Date.now(), includePendingWork: false,
            });
            expect(read.current).toEqual(snapshot);
            expect(await record()).toMatchObject({ persisted: true });
            await vi.runAllTimersAsync();
            expect(attempts).toBe(7);
            // A settled success retires retries; a genuine material change still writes.
            await persistence.recordInBandSnapshot({ ...snapshot, planLabel: 'changed' }, { targets: [target] });
            await vi.runAllTimersAsync();
            expect(attempts).toBe(8);
        } finally {
            persistence.dispose();
            vi.useRealTimers();
        }
    });

    it('persists the last valid subscription with a failed subscription refresh', async () => {
        const previous = {
            ...createSnapshot(),
            subscription: {
                status: 'subscribed' as const, renewal: 'off' as const,
                observedAtMs: 900, staleAfterMs: 60_000,
                currentPeriodEndAtMs: 1_800_000_000_000,
            },
        };
        const store = createProviderAccountUsageStore();
        store.recordSnapshot(previous, { sources: [profileSource] });
        const failed = {
            ...createSnapshot(),
            observedAtMs: 2_000, fetchedAtMs: 2_000,
            subscription: {
                status: 'unavailable' as const, renewal: 'unknown' as const,
                observedAtMs: 2_000, staleAfterMs: 60_000,
                lastRefreshError: { observedAtMs: 2_000, code: 'network' as const },
            },
        };
        const persistence = createPersistence();
        await recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store, persistence, sessionId: 'sess_1', snapshot: failed,
            observation: { sources: [profileSource] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async () => true,
            resolveAuthoritativeSource: async () => profileSource,
            resolvePersistenceTargets: async () => [createTarget()],
        });
        const expectedSubscription = {
            ...previous.subscription,
            lastRefreshError: failed.subscription.lastRefreshError,
        };
        await persistence.flush(1_000);
        expect(writes).toEqual([expect.objectContaining({ snapshot: { ...failed, subscription: expectedSubscription },
            source: createTarget().source, expectedCredentialRevision: createTarget().expectedCredentialRevision,
            expectedConfigurationRevision: createTarget().expectedConfigurationRevision })]);
        expect(store.resolveRecordId(previous.recordId)?.subscription).toEqual(expectedSubscription);
    });

    it.each(['plain', 'e2ee'] as const)('preserves the quota failure clock when only subscription freshness advances for %s accounts', async (mode) => {
        const failure = { kind: 'provider_http', status: 429, observedAtMs: 1_200 } as const;
        const previous = {
            ...createSnapshot(),
            observedAtMs: 1_200,
            state: 'error_last_known_good' as const,
            diagnostics: [failure],
            subscription: {
                status: 'subscribed' as const, renewal: 'off' as const,
                observedAtMs: 900, staleAfterMs: 60_000,
            },
        };
        const store = createProviderAccountUsageStore();
        store.recordSnapshot(previous, { sources: [profileSource] });
        const refreshed = {
            ...previous,
            subscription: { ...previous.subscription, observedAtMs: 2_000 },
        };
        const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const persistence = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => mode },
            credentials: { token: 'token', encryption: mode === 'plain' ? null : encryption },
            now: () => 2_000, fingerprintKey: new Uint8Array(32).fill(3),
            randomBytes: length => new Uint8Array(length).fill(9),
        });
        schedulers.push(persistence);

        await recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store, persistence, sessionId: 'sess_1', snapshot: refreshed,
            observation: { sources: [profileSource] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async candidate => matchesCurrentQuotaObservationCredential({
                ...candidate,
                credential: { providerAccountId: 'acct_123', providerOrganizationId: null, credentialFingerprint: 'sha256:deadbeef' },
            }),
            resolvePersistenceTargets: async () => [createTarget()],
        });
        await persistence.flush(1_000);

        expect(store.resolveRecordId(previous.recordId)).toEqual(refreshed);
        expect(writes).toHaveLength(1);
        const write = writes[0]!;
        expect(write).toMatchObject({ status: 'error', fetchedAt: 1_000 });
        const persisted = mode === 'plain' ? write.snapshot : openSealedProviderAccountUsageSnapshot({
            material: encryption, sealed: write.sealedPayload!,
        });
        expect(persisted).toEqual(refreshed);
        expect(getProviderAccountUsageRefreshErrorAt(persisted!)).toBe(1_200);
        // A subscription observed after a new quota request supplies neither a
        // new quota observation nor a new quota failure that could settle it.
        expect(persisted).toMatchObject({ fetchedAtMs: 1_000, diagnostics: [failure] });
        if (mode === 'e2ee') expect(write.sealedPayload?.refreshErrorAt).toBe(1_200);
    });

    it.each([
        { observedOrganizationId: 'org-other', expected: 'credential_fingerprint_mismatch' },
        { observedOrganizationId: undefined, expected: 'credential_fingerprint_mismatch' },
        { observedOrganizationId: 'org-current', expected: 'snapshot_advanced' },
    ])('qualifies global organization usage against current credential context ($observedOrganizationId)', async ({ observedOrganizationId, expected }) => {
        const snapshot = createSnapshot({ ...createRecordKey('same-user'),
            ...(observedOrganizationId ? { quotaScope: 'organization' as const, quotaScopeId: observedOrganizationId } : {}),
        });
        const store = createProviderAccountUsageStore();
        const result = await recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'session-context' }], store, persistence: null,
            sessionId: 'session-context', snapshot, requiresProviderOrganizationId: true,
            observation: { sources: [profileSource] }, credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async (candidate) => matchesCurrentQuotaObservationCredential({ ...candidate,
                credential: { providerAccountId: 'same-user', providerOrganizationId: 'org-current', credentialFingerprint: 'sha256:deadbeef' },
            }),
        });
        expect(result.status).toBe(expected);
        expect(store.resolveBySource(profileSource)).toEqual(expected === 'snapshot_advanced' ? snapshot : null);
    });

    it.each([
        { observedUser: 'same-user', fingerprint: 'sha256:deadbeef', bindingCurrent: true, accepted: true },
        { observedUser: 'other-user', fingerprint: 'sha256:deadbeef', bindingCurrent: true, accepted: false },
        { observedUser: 'same-user', fingerprint: 'sha256:bad00bad', bindingCurrent: true, accepted: false },
        { observedUser: 'same-user', fingerprint: 'sha256:deadbeef', bindingCurrent: false, accepted: false },
    ])('keeps exact provisional credential proof local ($observedUser/$fingerprint/$bindingCurrent)', async ({ observedUser, fingerprint, bindingCurrent, accepted }) => {
        const snapshot = createSnapshot(createRecordKey('provisional:runtime'));
        const store = createProviderAccountUsageStore();
        const result = await recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'session-local' }], store, persistence: null,
            sessionId: 'session-local', snapshot, requiresProviderOrganizationId: true,
            observation: { sources: [profileSource] }, sourceProviderAccountId: observedUser,
            credentialFingerprint: fingerprint,
            verifyCredentialFingerprint: async (candidate) => matchesCurrentQuotaObservationCredential({ ...candidate,
                credential: { providerAccountId: 'same-user', providerOrganizationId: null, credentialFingerprint: 'sha256:deadbeef' },
            }),
            resolveAuthoritativeSource: async () => bindingCurrent ? profileSource : null,
        });
        expect(result.status).toBe(accepted ? 'snapshot_advanced' : 'credential_fingerprint_mismatch');
        expect(store.resolveBySource(profileSource)).toBeNull();
        expect(store.resolveRecordId(snapshot.recordId)).toEqual(accepted ? snapshot : null);
        if (accepted) expect(result).toMatchObject({ verifiedLocalSource: profileSource, sourceProviderAccountId: 'same-user' });
    });

    it('persists only through a caller-proven qualified V4 source and currentness basis', async () => {
        const snapshot = createSnapshot(createRecordKey('acct_live'));
        const target = createTarget();
        const store = createProviderAccountUsageStore();
        const persistence = createPersistence();

        await expect(recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            observation: { sources: [profileSource] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async () => true,
            resolveAuthoritativeSource: async () => profileSource,
            resolvePersistenceTargets: async (input) => {
                expect(input).toEqual({
                    sessionId: 'sess_1',
                    snapshot,
                    sources: [profileSource],
                });
                return [target];
            },
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
            qualifiedSource: profileSource,
        });

        expect(store.resolveBySource(profileSource)?.recordId).toBe(snapshot.recordId);
        await persistence.flush(1_000);
        expect(writes).toEqual([expect.objectContaining({ snapshot, source: target.source,
            expectedCredentialRevision: target.expectedCredentialRevision,
            expectedConfigurationRevision: target.expectedConfigurationRevision })]);
    });

    it('does not let stale credential evidence advance a qualified account-usage record', async () => {
        const store = createProviderAccountUsageStore();
        const qualifiedSnapshot = createSnapshot(createRecordKey('acct_live'));
        const staleSnapshot = {
            ...qualifiedSnapshot,
            observedAtMs: 2_000,
            fetchedAtMs: 2_000,
            state: 'error_last_known_good' as const,
        };
        store.recordSnapshot(qualifiedSnapshot, { sources: [profileSource] });
        const persistence = createPersistence();

        await expect(recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot: staleSnapshot,
            observation: { sources: [profileSource] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async () => false,
            resolvePersistenceTargets: async () => [createTarget()],
        })).resolves.toEqual({
            status: 'credential_fingerprint_mismatch',
            recordId: staleSnapshot.recordId,
            persisted: false,
        });

        expect(store.resolveRecordId(staleSnapshot.recordId)).toEqual(qualifiedSnapshot);
        await persistence.flush(1_000);
        expect(writes).toEqual([]);
    });

    it('keeps an unqualified observation local and does not publish a durable record id', async () => {
        const snapshot = createSnapshot(createRecordKey('acct_unproved'));
        const store = createProviderAccountUsageStore();
        const persistence = createPersistence();
        const publishRecordId = vi.fn(async () => {});

        await expect(recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            resolvePersistenceTargets: async () => [createTarget()],
            observation: { sources: [profileSource] },
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: false,
            persistence: { status: 'not_persisted', reason: 'no_current_qualified_source' },
        });

        expect(store.resolveRecordId(snapshot.recordId)).toEqual(snapshot);
        expect(store.resolveBySource(profileSource)).toBeNull();
        await persistence.flush(1_000);
        expect(writes).toEqual([]);
        expect(publishRecordId).not.toHaveBeenCalled();
    });

    it('does not advance the local store before qualified persistence takes custody', async () => {
        const snapshot = createSnapshot();
        const target = createTarget();
        const store = createProviderAccountUsageStore();
        const persistence = createPersistence();
        // Real shutdown refuses queued custody; a new scheduler is the resumed owner.
        persistence.dispose();
        const input = {
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            observation: { sources: [profileSource] }, credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async (candidate) => matchesCurrentQuotaObservationCredential({ ...candidate,
                credential: { providerAccountId: snapshot.accountSubject.id, credentialFingerprint: 'sha256:deadbeef' },
            }),
            resolvePersistenceTargets: async () => [target],
            sessionId: 'sess_1',
            snapshot,
        } satisfies Parameters<typeof recordProviderAccountUsageSnapshotForSession>[0];

        await expect(recordProviderAccountUsageSnapshotForSession(input))
            .rejects.toThrow('provider_account_usage_persistence_disposed');
        expect(store.resolveRecordId(snapshot.recordId)).toBeNull();
        expect(writes).toEqual([]);

        const resumedPersistence = createPersistence();
        await expect(recordProviderAccountUsageSnapshotForSession({ ...input, persistence: resumedPersistence })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
            qualifiedSource: profileSource,
        });
        expect(store.resolveRecordId(snapshot.recordId)).toEqual(snapshot);
        await resumedPersistence.flush(1_000);
        expect(writes).toEqual([expect.objectContaining({ snapshot, source: target.source,
            expectedCredentialRevision: target.expectedCredentialRevision,
            expectedConfigurationRevision: target.expectedConfigurationRevision })]);
    });

    it('does not commit an adoption unless a V4 persistence target accepts custody', async () => {
        const store = createProviderAccountUsageStore();
        const provisionalKey = createRecordKey('provisional:native');
        const stableKey = createRecordKey('acct_stable');
        const provisionalSnapshot = createSnapshot(provisionalKey);
        store.recordSnapshot(provisionalSnapshot, { sources: [profileSource] });
        const adoption: ProviderAccountUsageAdoptionV1 = {
            providerId: 'codex',
            fromRecordId: provisionalSnapshot.recordId,
            toRecordId: buildProviderAccountUsageRecordId(stableKey),
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        };
        // Without a target resolver the real scheduler receives targets: []
        // and returns not_persisted, preserving the adoption refusal contract.
        const persistence = createPersistence();

        await expect(recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            adoption,
        })).rejects.toThrow('persistence target unavailable');
        expect(store.resolveRecordId(provisionalSnapshot.recordId)).toEqual(provisionalSnapshot);
        expect(store.resolveRecordId(adoption.toRecordId)).toBeNull();

        const target = createTarget();
        await expect(recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            resolvePersistenceTargets: async (input) => {
                expect(input.sources).toEqual([profileSource]);
                return [target];
            },
            sessionId: 'sess_1',
            adoption,
        })).resolves.toEqual({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        });
        await persistence.flush(1_000);
        expect(writes).toEqual([expect.objectContaining({ recordId: adoption.toRecordId, source: target.source,
            expectedCredentialRevision: target.expectedCredentialRevision,
            expectedConfigurationRevision: target.expectedConfigurationRevision })]);
        expect(store.resolveBySource(profileSource)?.recordId).toBe(adoption.toRecordId);
    });

    it('returns session_not_found without local or durable mutations', async () => {
        const snapshot = createSnapshot();
        const store = createProviderAccountUsageStore();
        const persistence = createPersistence();

        await expect(recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'other' }],
            store,
            persistence,
            resolvePersistenceTargets: async () => [createTarget()],
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({ status: 'session_not_found' });
        expect(store.resolveRecordId(snapshot.recordId)).toBeNull();
        await persistence.flush(1_000);
        expect(writes).toEqual([]);
    });
});
