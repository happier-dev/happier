import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccountUsageAdoptionV1 } from './adoption';

type PreparedAdoption = Readonly<{
    status: 'adopted' | 'already_adopted';
    fromRecordId: string;
    toRecordId: string;
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    observation: Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }>;
    commit(): Readonly<{
        status: 'adopted' | 'already_adopted';
        fromRecordId: string;
        toRecordId: string;
    }>;
}>;

type RecordModule = Readonly<{
    recordProviderAccountUsageSnapshotForSession(input: Readonly<{
        getChildren: () => readonly unknown[];
        store: Readonly<{
            recordSnapshot(
                snapshot: ProviderAccountUsageSnapshotV1,
                observation?: Readonly<{
                    sources?: readonly ConnectedServiceUsageSourceV1[];
                }>,
            ): Readonly<{ status: 'snapshot_advanced'; recordId: string }>;
            resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
        }>;
        persistence: Readonly<{
            recordInBandSnapshot(
                snapshot: ProviderAccountUsageSnapshotV1,
                options?: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }>,
            ): Promise<unknown>;
        }> | null;
        publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
        observation?: Readonly<{
            sources?: readonly ConnectedServiceUsageSourceV1[];
        }>;
        credentialFingerprint?: string | null;
        verifyCredentialFingerprint?: (input: Readonly<{
            serviceId: string;
            profileId: string;
            providerAccountId: string;
            credentialFingerprint: string;
        }>) => Promise<boolean>;
        resolveAuthoritativeSource?: (
            source: ConnectedServiceUsageSourceV1,
        ) => Promise<ConnectedServiceUsageSourceV1 | null>;
        sessionId: string;
        snapshot: ProviderAccountUsageSnapshotV1;
    }>): Promise<
        | Readonly<{ status: 'snapshot_advanced'; recordId: string; persisted: boolean }>
        | Readonly<{ status: 'session_not_found' }>
        | Readonly<{ status: 'credential_fingerprint_mismatch' }>
    >;
    recordProviderAccountUsageAdoptionForSession(input: Readonly<{
        getChildren: () => readonly unknown[];
        store: Readonly<{
            prepareAdoption(adoption: ProviderAccountUsageAdoptionV1): PreparedAdoption;
        }>;
        persistence: Readonly<{
            recordInBandSnapshot(
                snapshot: ProviderAccountUsageSnapshotV1,
                options?: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }>,
            ): Promise<unknown>;
        }> | null;
        publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
        sessionId: string;
        adoption: ProviderAccountUsageAdoptionV1;
    }>): Promise<
        | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string; persisted: boolean }>
        | Readonly<{ status: 'session_not_found' }>
    >;
}>;

type StoreModule = Readonly<{
    createProviderAccountUsageStore(): Readonly<{
        recordSnapshot(
            snapshot: ProviderAccountUsageSnapshotV1,
            observation?: Readonly<{
                sources?: readonly ConnectedServiceUsageSourceV1[];
            }>,
        ): Readonly<{ status: 'snapshot_advanced'; recordId: string }>;
        resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
        resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
        prepareAdoption(adoption: ProviderAccountUsageAdoptionV1): PreparedAdoption;
    }>;
}>;

async function loadRecordModule(): Promise<RecordModule | null> {
    return await import('./recordProviderAccountUsageSnapshotForSession').catch(() => null) as RecordModule | null;
}

async function loadStoreModule(): Promise<StoreModule | null> {
    return await import('./store').catch(() => null) as StoreModule | null;
}

function createRecordKey(accountSubjectId = 'acct_123'): ProviderAccountUsageRecordKeyV1 {
    return {
        providerId: 'codex',
        accountSubjectId,
        subjectKind: accountSubjectId.startsWith('provisional:') ? 'unknown' : 'account',
        quotaScope: 'account',
    };
}

function createSnapshot(recordKey = createRecordKey()): ProviderAccountUsageSnapshotV1 {
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: recordKey.accountSubjectId.startsWith('provisional:') ? 'provisionalLocalSubject' : 'providerSubject',
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

function createAdoption(params: Readonly<{
    fromKey: ProviderAccountUsageRecordKeyV1;
    toKey: ProviderAccountUsageRecordKeyV1;
}>): ProviderAccountUsageAdoptionV1 {
    return {
        providerId: params.toKey.providerId,
        fromRecordId: buildProviderAccountUsageRecordId(params.fromKey),
        toRecordId: buildProviderAccountUsageRecordId(params.toKey),
        stableRecordKey: params.toKey,
        proof: { kind: 'provider_account_id_match' },
        observedAtMs: 2_000,
    };
}

describe('recordProviderAccountUsageSnapshotForSession', () => {
    it('forwards exactly qualified source context into the store and persistence', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        let latestSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
        let latestObservation:
            | Readonly<{ sources?: readonly ConnectedServiceUsageSourceV1[] }>
            | undefined;
        const store = {
            recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1, observation?: typeof latestObservation) => {
                latestSnapshot = snapshot;
                latestObservation = observation;
                return { status: 'snapshot_advanced' as const, recordId: snapshot.recordId };
            }),
            resolveRecordId: vi.fn(() => latestSnapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {});
        const snapshot = createSnapshot();
        const source = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        } as const;

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            observation: {
                sources: [source],
            },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async () => true,
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });

        expect(store.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            recordId: snapshot.recordId,
            providerId: 'codex',
        }), expect.any(Object));
        expect(latestObservation).toEqual({ sources: [source] });
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            recordId: snapshot.recordId,
            providerId: 'codex',
        }), { sources: [source] });
        expect(publishRecordId).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            recordId: snapshot.recordId,
        });
    });

    it('persists authoritative current source identity after credential qualification', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot(createRecordKey('acct_live_exhausted'));
        const profileSource: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        };
        const groupSource: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 6,
        };
        const currentGroupSource: ConnectedServiceUsageSourceV1 = {
            ...groupSource,
            groupGeneration: 7,
        };
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'snapshot_advanced' as const,
                recordId: recorded.recordId,
            })),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot,
            observation: { sources: [profileSource, groupSource] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async () => true,
            resolveAuthoritativeSource: async (source) =>
                source.bindingKind === 'group_member' ? currentGroupSource : source,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });

        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            recordId: snapshot.recordId,
        }), { sources: [profileSource, currentGroupSource] });
    });

    it('does not let stale credential evidence advance a previously qualified account-usage record', async () => {
        const module = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(module).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const qualifiedSnapshot = createSnapshot(createRecordKey('acct_live_exhausted'));
        const staleSnapshot: ProviderAccountUsageSnapshotV1 = {
            ...qualifiedSnapshot,
            observedAtMs: 2_000,
            fetchedAtMs: 2_000,
            state: 'error_last_known_good',
        };
        const source: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        };
        const store = storeModule!.createProviderAccountUsageStore();
        store.recordSnapshot(qualifiedSnapshot, { sources: [source] });
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const verifyCredentialFingerprint = vi.fn(async () => false);

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot: staleSnapshot,
            observation: { sources: [source] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint,
        })).resolves.toEqual({
            status: 'credential_fingerprint_mismatch',
            recordId: staleSnapshot.recordId,
            persisted: false,
        });

        expect(verifyCredentialFingerprint).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            profileId: 'work',
            providerAccountId: 'acct_live_exhausted',
            credentialFingerprint: 'sha256:deadbeef',
        });
        expect(store.resolveRecordId(staleSnapshot.recordId)).toEqual(qualifiedSnapshot);
        expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
    });

    it('retains an unproved observation as display-only without linking its claimed source', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot(createRecordKey('acct_unproved'));
        const source: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 4,
        };
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'snapshot_advanced' as const,
                recordId: recorded.recordId,
            })),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot,
            observation: { sources: [source] },
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });

        expect(store.recordSnapshot).toHaveBeenCalledWith(snapshot, {});
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(snapshot, undefined);
    });

    it('propagates credential authority outages instead of misclassifying them as stale evidence', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot(createRecordKey('acct_live_exhausted'));
        const source: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        };
        const store = {
            recordSnapshot: vi.fn(),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot,
            observation: { sources: [source] },
            credentialFingerprint: 'sha256:deadbeef',
            verifyCredentialFingerprint: async () => {
                throw new Error('credential authority unavailable');
            },
        })).rejects.toThrow('credential authority unavailable');

        expect(store.recordSnapshot).not.toHaveBeenCalled();
        expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
    });

    it('returns session_not_found without mutating store or persistence when the runtime session is unknown', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const store = {
            recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1) => ({
                status: 'snapshot_advanced' as const,
                recordId: snapshot.recordId,
            })),
            resolveRecordId: vi.fn(() => null),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {});

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'other_session' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            snapshot: createSnapshot(),
        })).resolves.toEqual({ status: 'session_not_found' });

        expect(store.recordSnapshot).not.toHaveBeenCalled();
        expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
        expect(publishRecordId).not.toHaveBeenCalled();
    });

    it('does not advance the store before persistence custody and advances once on an identical retry', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot();
        let rejectFirstCustody!: (error: Error) => void;
        const firstCustody = new Promise<never>((_resolve, reject) => {
            rejectFirstCustody = reject;
        });
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'snapshot_advanced' as const,
                recordId: recorded.recordId,
            })),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn()
                .mockImplementationOnce(async () => await firstCustody)
                .mockResolvedValue({ status: 'enqueued' as const, enqueue: 'accepted' as const }),
        };
        const publishRecordId = vi.fn(async () => {});

        const input = {
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            snapshot,
        } as const;
        const firstAttempt = module!.recordProviderAccountUsageSnapshotForSession(input);
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledOnce();
        expect(store.recordSnapshot).not.toHaveBeenCalled();

        rejectFirstCustody(new Error('store unavailable'));
        await expect(firstAttempt)
            .rejects.toThrow('store unavailable');
        expect(store.recordSnapshot).not.toHaveBeenCalled();

        await expect(module!.recordProviderAccountUsageSnapshotForSession(input)).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });

        expect(store.recordSnapshot).toHaveBeenCalledOnce();
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(publishRecordId).toHaveBeenCalledOnce());
    });

    it('keeps recording successful when session metadata publication fails after persistence succeeds', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot();
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'snapshot_advanced' as const,
                recordId: recorded.recordId,
            })),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {
            throw new Error('metadata write unavailable');
        });

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });
    });

    it('returns after persistence custody without waiting for session metadata publication', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot();
        let releasePublication!: () => void;
        const publicationBarrier = new Promise<void>((resolve) => {
            releasePublication = resolve;
        });
        const publishRecordId = vi.fn(async () => await publicationBarrier);

        const recording = module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store: {
                recordSnapshot: () => ({
                    status: 'snapshot_advanced' as const,
                    recordId: snapshot.recordId,
                }),
                resolveRecordId: () => snapshot,
            },
            persistence: {
                recordInBandSnapshot: async () => ({ status: 'enqueued' as const }),
            },
            publishRecordId,
            sessionId: 'sess_1',
            snapshot,
        });

        await expect(Promise.race([
            recording,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
        ])).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });
        expect(publishRecordId).toHaveBeenCalledOnce();
        releasePublication();
    });

    it('records connected-service group-member source context locally instead of back-projecting quota writes', async () => {
        const module = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(module).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const store = storeModule!.createProviderAccountUsageStore();
        const snapshot = createSnapshot(createRecordKey('acct_live_exhausted'));

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence: null,
            observation: {
                sources: [{
                    serviceId: 'openai-codex',
                    profileId: 'team',
                    bindingKind: 'group_member',
                    groupId: 'happier',
                    groupGeneration: 7,
                }],
            },
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: false,
        });

        expect(store.resolveRecordId(snapshot.recordId)).toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            providerId: 'codex',
        }));
    });

    it('acknowledges an adopted provisional duplicate without a second canonical persistence write', async () => {
        const recordModule = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(recordModule).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const store = storeModule!.createProviderAccountUsageStore();
        const provisionalKey = createRecordKey('provisional:native');
        const stableKey = createRecordKey('acct_stable');
        const provisionalSnapshot = createSnapshot(provisionalKey);
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };

        store.recordSnapshot(provisionalSnapshot);
        store.prepareAdoption({
            providerId: 'codex',
            fromRecordId: buildProviderAccountUsageRecordId(provisionalKey),
            toRecordId: buildProviderAccountUsageRecordId(stableKey),
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        }).commit();

        await expect(recordModule!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot: provisionalSnapshot,
        })).resolves.toEqual({
            status: 'duplicate',
            recordId: buildProviderAccountUsageRecordId(stableKey),
            persisted: true,
        });

        expect(persistence.recordInBandSnapshot).toHaveBeenCalledOnce();
    });

    it('applies provider-owned adoption for tracked sessions and persists the stable record', async () => {
        const recordModule = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(recordModule).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const store = storeModule!.createProviderAccountUsageStore();
        const provisionalKey = createRecordKey('provisional:native');
        const stableKey = createRecordKey('acct_stable_adopted');
        const adoption = createAdoption({ fromKey: provisionalKey, toKey: stableKey });
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {});

        store.recordSnapshot(createSnapshot(provisionalKey));

        await expect(recordModule!.recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            adoption,
        })).resolves.toEqual({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        });

        expect(store.resolveRecordId(adoption.fromRecordId)?.recordId).toBe(adoption.toRecordId);
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            recordId: adoption.toRecordId,
            recordKey: stableKey,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
        }), undefined);
        expect(publishRecordId).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            recordId: adoption.toRecordId,
        });
    });

    it('keeps adoption invisible until canonical persistence accepts custody and commits an identical retry once', async () => {
        const recordModule = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(recordModule).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const store = storeModule!.createProviderAccountUsageStore();
        const provisionalKey = createRecordKey('provisional:native');
        const stableKey = createRecordKey('acct_stable_retry');
        const adoption = createAdoption({ fromKey: provisionalKey, toKey: stableKey });
        const source: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        };
        const provisionalSnapshot = createSnapshot(provisionalKey);
        const persistence = {
            recordInBandSnapshot: vi.fn()
                .mockRejectedValueOnce(new Error('canonical custody unavailable'))
                .mockResolvedValue({ status: 'enqueued' }),
        };
        const publishRecordId = vi.fn(async () => {});

        store.recordSnapshot(provisionalSnapshot, { sources: [source] });

        await expect(recordModule!.recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            adoption,
        })).rejects.toThrow('canonical custody unavailable');

        expect(store.resolveRecordId(adoption.fromRecordId)).toEqual(provisionalSnapshot);
        expect(store.resolveRecordId(adoption.toRecordId)).toBeNull();
        expect(store.resolveBySource(source)).toEqual(provisionalSnapshot);
        expect(publishRecordId).not.toHaveBeenCalled();

        await expect(recordModule!.recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            adoption,
        })).resolves.toEqual({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        });

        expect(store.resolveRecordId(adoption.fromRecordId)).toEqual(expect.objectContaining({
            recordId: adoption.toRecordId,
            recordKey: stableKey,
        }));
        expect(store.resolveBySource(source)?.recordId).toBe(adoption.toRecordId);
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledTimes(2);
        expect(persistence.recordInBandSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                recordId: adoption.toRecordId,
                recordKey: stableKey,
            }),
            { sources: [source] },
        );
        expect(publishRecordId).toHaveBeenCalledOnce();

        await expect(recordModule!.recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            adoption,
        })).resolves.toEqual({
            status: 'already_adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        });

        expect(persistence.recordInBandSnapshot).toHaveBeenCalledTimes(2);
        expect(publishRecordId).toHaveBeenCalledOnce();
    });

    it('does not apply provider-owned adoption for unknown sessions', async () => {
        const recordModule = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(recordModule).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const store = storeModule!.createProviderAccountUsageStore();
        const provisionalKey = createRecordKey('provisional:native');
        const stableKey = createRecordKey('acct_stable_missing_session');
        const adoption = createAdoption({ fromKey: provisionalKey, toKey: stableKey });
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };

        await expect(recordModule!.recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'other_session' }],
            store,
            persistence,
            sessionId: 'sess_1',
            adoption,
        })).resolves.toEqual({ status: 'session_not_found' });

        expect(store.resolveRecordId(adoption.fromRecordId)).toBeNull();
        expect(persistence.recordInBandSnapshot).not.toHaveBeenCalled();
    });
});
