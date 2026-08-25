import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { QualifiedProviderAccountUsagePersistenceTarget } from './persistence';
import type { ProviderAccountUsageAdoptionV1 } from './adoption';
import {
    recordProviderAccountUsageAdoptionForSession,
    recordProviderAccountUsageSnapshotForSession,
} from './recordProviderAccountUsageSnapshotForSession';
import { createProviderAccountUsageStore } from './store';

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
    serviceId: 'openai-codex',
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

const enqueued = {
    status: 'enqueued' as const,
    enqueue: 'accepted' as const,
};

describe('recordProviderAccountUsageSnapshotForSession', () => {
    it('persists only through a caller-proven qualified V4 source and currentness basis', async () => {
        const snapshot = createSnapshot(createRecordKey('acct_live'));
        const target = createTarget();
        const store = createProviderAccountUsageStore();
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => enqueued),
        };

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
        });

        expect(store.resolveBySource(profileSource)?.recordId).toBe(snapshot.recordId);
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(
            snapshot,
            { targets: [target] },
        );
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
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => enqueued),
        };

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
        expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
    });

    it('keeps an unqualified observation local and does not publish a durable record id', async () => {
        const snapshot = createSnapshot(createRecordKey('acct_unproved'));
        const store = createProviderAccountUsageStore();
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({
                status: 'not_persisted' as const,
                reason: 'no_current_qualified_source' as const,
            })),
        };
        const publishRecordId = vi.fn(async () => {});

        await expect(recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            observation: { sources: [profileSource] },
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: false,
        });

        expect(store.resolveRecordId(snapshot.recordId)).toEqual(snapshot);
        expect(store.resolveBySource(profileSource)).toBeNull();
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(
            snapshot,
            { targets: [] },
        );
        expect(publishRecordId).not.toHaveBeenCalled();
    });

    it('does not advance the local store before qualified persistence takes custody', async () => {
        const snapshot = createSnapshot();
        const target = createTarget();
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'snapshot_advanced' as const,
                recordId: recorded.recordId,
                snapshotAdvanced: true,
                sourceLinked: false,
            })),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn()
                .mockRejectedValueOnce(new Error('persistence unavailable'))
                .mockResolvedValueOnce(enqueued),
        };
        const input = {
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            resolvePersistenceTargets: async () => [target],
            sessionId: 'sess_1',
            snapshot,
        } as const;

        await expect(recordProviderAccountUsageSnapshotForSession(input))
            .rejects.toThrow('persistence unavailable');
        expect(store.recordSnapshot).not.toHaveBeenCalled();

        await expect(recordProviderAccountUsageSnapshotForSession(input)).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });
        expect(store.recordSnapshot).toHaveBeenCalledOnce();
        expect(persistence.recordInBandSnapshot).toHaveBeenLastCalledWith(
            snapshot,
            { targets: [target] },
        );
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
        const unavailablePersistence = {
            recordInBandSnapshot: vi.fn(async () => ({
                status: 'not_persisted' as const,
                reason: 'no_current_qualified_source' as const,
            })),
        };

        await expect(recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence: unavailablePersistence,
            sessionId: 'sess_1',
            adoption,
        })).rejects.toThrow('persistence target unavailable');
        expect(store.resolveRecordId(provisionalSnapshot.recordId)).toEqual(provisionalSnapshot);
        expect(store.resolveRecordId(adoption.toRecordId)).toBeNull();

        const persistence = {
            recordInBandSnapshot: vi.fn(async () => enqueued),
        };
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
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ recordId: adoption.toRecordId }),
            { targets: [target] },
        );
    });

    it('returns session_not_found without local or durable mutations', async () => {
        const snapshot = createSnapshot();
        const store = {
            recordSnapshot: vi.fn(),
            resolveRecordId: vi.fn(() => null),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => enqueued),
        };

        await expect(recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'other' }],
            store,
            persistence,
            resolvePersistenceTargets: async () => [createTarget()],
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({ status: 'session_not_found' });
        expect(store.recordSnapshot).not.toHaveBeenCalled();
        expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
    });
});
