import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccountUsageAdoptionV1 } from './adoption';

type RecordModule = Readonly<{
    recordProviderAccountUsageSnapshotForSession(input: Readonly<{
        getChildren: () => readonly unknown[];
        store: Readonly<{
            recordSnapshot(
                snapshot: ProviderAccountUsageSnapshotV1,
                observation?: Readonly<{
                    sources?: readonly ConnectedServiceUsageSourceV1[];
                }>,
            ): Readonly<{ status: 'recorded'; recordId: string }>;
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
        sessionId: string;
        snapshot: ProviderAccountUsageSnapshotV1;
    }>): Promise<
        | Readonly<{ status: 'recorded'; recordId: string; persisted: boolean }>
        | Readonly<{ status: 'session_not_found' }>
    >;
    recordProviderAccountUsageAdoptionForSession(input: Readonly<{
        getChildren: () => readonly unknown[];
        store: Readonly<{
            applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
                status: 'adopted' | 'already_adopted';
                fromRecordId: string;
                toRecordId: string;
            }>;
            resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
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
        ): Readonly<{ status: 'recorded'; recordId: string }>;
        resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
        applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
            status: 'adopted' | 'already_adopted';
            fromRecordId: string;
            toRecordId: string;
        }>;
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
    it('forwards explicit source context into the store and persistence', async () => {
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
                return { status: 'recorded' as const, recordId: snapshot.recordId };
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
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'recorded',
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

    it('persists all observed connected-service sources for a session usage snapshot', async () => {
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
            groupGeneration: 4,
        };
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'recorded' as const,
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
        })).resolves.toEqual({
            status: 'recorded',
            recordId: snapshot.recordId,
            persisted: true,
        });

        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            recordId: snapshot.recordId,
        }), { sources: [profileSource, groupSource] });
    });

    it('returns session_not_found without mutating store or persistence when the runtime session is unknown', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const store = {
            recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1) => ({
                status: 'recorded' as const,
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

    it('suppresses metadata publication when persistence fails but keeps the in-memory record', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot();
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'recorded' as const,
                recordId: recorded.recordId,
            })),
            resolveRecordId: vi.fn(() => snapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => {
                throw new Error('store unavailable');
            }),
        };
        const publishRecordId = vi.fn(async () => {});

        await expect(module!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            publishRecordId,
            sessionId: 'sess_1',
            snapshot,
        })).resolves.toEqual({
            status: 'recorded',
            recordId: snapshot.recordId,
            persisted: false,
        });

        expect(store.recordSnapshot).toHaveBeenCalledOnce();
        expect(publishRecordId).not.toHaveBeenCalled();
    });

    it('keeps recording successful when session metadata publication fails after persistence succeeds', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const snapshot = createSnapshot();
        const store = {
            recordSnapshot: vi.fn((recorded: ProviderAccountUsageSnapshotV1) => ({
                status: 'recorded' as const,
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
            status: 'recorded',
            recordId: snapshot.recordId,
            persisted: true,
        });
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
            status: 'recorded',
            recordId: snapshot.recordId,
            persisted: false,
        });

        expect(store.resolveRecordId(snapshot.recordId)).toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            providerId: 'codex',
        }));
    });

    it('persists the redirected canonical snapshot when an adopted provisional session write arrives', async () => {
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
        store.applyAdoption({
            providerId: 'codex',
            fromRecordId: buildProviderAccountUsageRecordId(provisionalKey),
            toRecordId: buildProviderAccountUsageRecordId(stableKey),
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        });

        await recordModule!.recordProviderAccountUsageSnapshotForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: 'sess_1',
            snapshot: provisionalSnapshot,
        });

        expect(persistence.recordInBandSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            recordId: buildProviderAccountUsageRecordId(stableKey),
            recordKey: stableKey,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
        }), undefined);
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
        }));
        expect(publishRecordId).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            recordId: adoption.toRecordId,
        });
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
