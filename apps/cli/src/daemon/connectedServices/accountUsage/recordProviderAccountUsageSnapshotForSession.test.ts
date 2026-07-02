import {
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageAdoptionV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type RecordModule = Readonly<{
    recordProviderAccountUsageSnapshotForSession(input: Readonly<{
        getChildren: () => readonly unknown[];
        store: Readonly<{
            recordSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Readonly<{ status: 'recorded'; recordId: string }>;
            resolveRecordId?(recordId: string): ProviderAccountUsageSnapshotV1 | null;
        }>;
        persistence: Readonly<{
            recordInBandSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Promise<unknown>;
        }> | null;
        publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
        sessionId: string;
        snapshot: ProviderAccountUsageSnapshotV1;
    }>): Promise<
        | Readonly<{ status: 'recorded'; recordId: string; persisted: boolean }>
        | Readonly<{ status: 'session_not_found' }>
    >;
    recordProviderAccountUsageAdoptionForSession(input: Readonly<{
        getChildren: () => readonly unknown[];
        store: Readonly<{
            applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string }>;
            resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
        }>;
        persistence: Readonly<{
            recordInBandSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Promise<unknown>;
        }> | null;
        publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
        sessionId: string;
        adoption: ProviderAccountUsageAdoptionV1;
    }>): Promise<
        | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string; persisted: boolean }>
        | Readonly<{ status: 'session_not_found' }>
    >;
}>;

async function loadRecordModule(): Promise<RecordModule | null> {
    return await import('./recordProviderAccountUsageSnapshotForSession').catch(() => null) as RecordModule | null;
}

type StoreModule = Readonly<{
    createProviderAccountUsageStore(): Readonly<{
        recordSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Readonly<{ status: 'recorded'; recordId: string }>;
        resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
        applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string }>;
    }>;
}>;

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
        providerId: 'codex',
        accountSubject: {
            kind: recordKey.accountSubjectId.startsWith('provisional:') ? 'provisionalLocalSubject' : 'providerSubject',
            id: recordKey.accountSubjectId,
        },
        aliases: [{ kind: 'appServerNative', providerId: 'codex', accountSubjectId: recordKey.accountSubjectId }],
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
        aliases: [{ kind: 'appServerNative', providerId: params.toKey.providerId, accountSubjectId: params.toKey.accountSubjectId }],
    };
}

describe('recordProviderAccountUsageSnapshotForSession', () => {
    it('adds a runtime-session alias, records latest state, and queues persistence', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        let latestSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
        const store = {
            recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1) => {
                latestSnapshot = snapshot;
                return {
                    status: 'recorded' as const,
                    recordId: snapshot.recordId,
                };
            }),
            resolveRecordId: vi.fn(() => latestSnapshot),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {});
        const snapshot = createSnapshot();

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
        expect(store.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            aliases: expect.arrayContaining([
                expect.objectContaining({
                    kind: 'runtimeSession',
                    sessionId: 'sess_1',
                    accountSubjectId: 'acct_123',
                }),
            ]),
        }));
        expect(persistence.recordInBandSnapshot).toHaveBeenCalledOnce();
        expect(publishRecordId).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            recordId: snapshot.recordId,
        });
    });

    it('does not publish a session metadata ref when persistence fails', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const store = {
            recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1) => ({
                status: 'recorded' as const,
                recordId: snapshot.recordId,
            })),
            resolveRecordId: vi.fn((recordId: string) => (recordId ? createSnapshot() : null)),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => {
                throw new Error('store unavailable');
            }),
        };
        const publishRecordId = vi.fn(async () => {});
        const snapshot = createSnapshot();

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

        expect(publishRecordId).not.toHaveBeenCalled();
    });

    it('keeps usage recording successful when session metadata publication fails', async () => {
        const module = await loadRecordModule();
        expect(module).not.toBeNull();
        const store = {
            recordSnapshot: vi.fn((snapshot: ProviderAccountUsageSnapshotV1) => ({
                status: 'recorded' as const,
                recordId: snapshot.recordId,
            })),
            resolveRecordId: vi.fn((recordId: string) => (recordId ? createSnapshot() : null)),
        };
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {
            throw new Error('metadata write unavailable');
        });
        const snapshot = createSnapshot();

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
            aliases: [{ kind: 'appServerNative', providerId: 'codex', accountSubjectId: stableKey.accountSubjectId }],
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
            accountSubject: {
                kind: 'providerSubject',
                id: stableKey.accountSubjectId,
            },
        }));
    });

    it('applies provider-owned adoption for tracked sessions and persists the stable record', async () => {
        const recordModule = await loadRecordModule();
        const storeModule = await loadStoreModule();
        expect(recordModule).not.toBeNull();
        expect(storeModule).not.toBeNull();
        const store = storeModule!.createProviderAccountUsageStore();
        const provisionalKey = createRecordKey('provisional:native');
        const stableKey = createRecordKey('acct_stable_adopted');
        const provisionalSnapshot = createSnapshot(provisionalKey);
        const adoption = createAdoption({ fromKey: provisionalKey, toKey: stableKey });
        const persistence = {
            recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' })),
        };
        const publishRecordId = vi.fn(async () => {});

        store.recordSnapshot(provisionalSnapshot);

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
            accountSubject: {
                kind: 'providerSubject',
                id: stableKey.accountSubjectId,
            },
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
