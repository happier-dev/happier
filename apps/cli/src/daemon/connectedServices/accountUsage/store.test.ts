import {
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageAdoptionV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

type ProviderAccountUsageStore = Readonly<{
    recordSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Readonly<{ status: 'recorded'; recordId: string }>;
    resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
    resolveByAlias(alias: Readonly<{
        kind: string;
        providerId: string;
        serviceId?: string;
        profileId?: string;
        localCredentialRef?: string;
        sessionId?: string;
    }>): ProviderAccountUsageSnapshotV1 | null;
    listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
    applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string }>;
}>;

type StoreModule = Readonly<{
    createProviderAccountUsageStore(): ProviderAccountUsageStore;
}>;

async function loadStoreModule(): Promise<StoreModule | null> {
    return await import('./store').catch(() => null) as StoreModule | null;
}

function createKey(accountSubjectId: string): ProviderAccountUsageRecordKeyV1 {
    return {
        providerId: 'claude',
        accountSubjectId,
        subjectKind: accountSubjectId.startsWith('provisional:') ? 'unknown' : 'subscription',
        quotaScope: 'account',
    };
}

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
    const recordKey = overrides.recordKey ?? createKey('sub_stable_1');
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    return {
        v: 1,
        recordId,
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: recordKey.accountSubjectId.startsWith('provisional:') ? 'provisionalLocalSubject' : 'providerSubject',
            id: recordKey.accountSubjectId,
        },
        aliases: [],
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Team',
        accountLabel: 'same visible email',
        meters: [],
        ...overrides,
    };
}

describe('provider account usage store', () => {
    it('indexes native and connected aliases for the same stable provider subject as one latest record', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const snapshot = createSnapshot({
            aliases: [
                {
                    kind: 'connectedServiceProfile',
                    providerId: 'claude',
                    serviceId: 'anthropic',
                    profileId: 'work',
                    accountSubjectId: 'sub_stable_1',
                },
                {
                    kind: 'nativeCli',
                    providerId: 'claude',
                    localCredentialRef: 'claude-native',
                    accountSubjectId: 'sub_stable_1',
                },
                {
                    kind: 'connectedServiceProfile',
                    providerId: 'claude',
                    serviceId: 'anthropic',
                    profileId: 'work',
                    accountSubjectId: 'sub_stable_1',
                },
            ],
        });

        expect(store.recordSnapshot(snapshot)).toEqual({ status: 'recorded', recordId: snapshot.recordId });
        expect(store.listSnapshots()).toHaveLength(1);
        expect(store.listSnapshots()[0]?.aliases).toHaveLength(2);
        expect(store.resolveByAlias({
            kind: 'connectedServiceProfile',
            providerId: 'claude',
            serviceId: 'anthropic',
            profileId: 'work',
        })?.recordId).toBe(snapshot.recordId);
        expect(store.resolveByAlias({
            kind: 'nativeCli',
            providerId: 'claude',
        })?.recordId).toBe(snapshot.recordId);
    });

    it('keeps provisional records separate when visible labels match but stable subject proof is absent', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const nativeKey = createKey('provisional:native');
        const connectedKey = createKey('provisional:connected');

        store.recordSnapshot(createSnapshot({
            recordKey: nativeKey,
            recordId: buildProviderAccountUsageRecordId(nativeKey),
            accountSubject: { kind: 'provisionalLocalSubject', id: nativeKey.accountSubjectId },
            accountLabel: 'same@example.com',
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: nativeKey.accountSubjectId }],
        }));
        store.recordSnapshot(createSnapshot({
            recordKey: connectedKey,
            recordId: buildProviderAccountUsageRecordId(connectedKey),
            accountSubject: { kind: 'provisionalLocalSubject', id: connectedKey.accountSubjectId },
            accountLabel: 'same@example.com',
            aliases: [{
                kind: 'connectedServiceProfile',
                providerId: 'claude',
                serviceId: 'anthropic',
                profileId: 'work',
                accountSubjectId: connectedKey.accountSubjectId,
            }],
        }));

        expect(store.listSnapshots().map((snapshot) => snapshot.recordKey.accountSubjectId).sort()).toEqual([
            'provisional:connected',
            'provisional:native',
        ]);
    });

    it('adopts provisional records into stable records with a redirect without duplicating aliases', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const stableKey = createKey('sub_stable_2');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);

        store.recordSnapshot(createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
        }));

        const adoption: ProviderAccountUsageAdoptionV1 = {
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
        };

        expect(store.applyAdoption(adoption)).toEqual({ status: 'adopted', fromRecordId, toRecordId });
        expect(store.applyAdoption(adoption)).toEqual({ status: 'already_adopted', fromRecordId, toRecordId });
        store.recordSnapshot(createSnapshot({
            recordKey: stableKey,
            recordId: toRecordId,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
        }));

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(toRecordId);
        expect(store.listSnapshots().map((snapshot) => snapshot.recordId)).toEqual([toRecordId]);
        expect(store.listSnapshots()[0]?.aliases).toHaveLength(1);
    });

    it('keeps the latest provisional snapshot visible immediately when adoption arrives before the stable snapshot', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const stableKey = createKey('sub_stable_3');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);

        store.recordSnapshot(createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
            aliases: [{
                kind: 'nativeCli',
                providerId: 'claude',
                localCredentialRef: 'claude-native',
                accountSubjectId: provisionalKey.accountSubjectId,
            }],
            observedAtMs: 3_000,
            fetchedAtMs: 3_000,
        }));

        store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 3_500,
            aliases: [{
                kind: 'nativeCli',
                providerId: 'claude',
                localCredentialRef: 'claude-native',
                accountSubjectId: stableKey.accountSubjectId,
            }],
        });

        const redirected = store.resolveRecordId(fromRecordId);
        expect(redirected?.recordId).toBe(toRecordId);
        expect(redirected?.recordKey).toEqual(stableKey);
        expect(redirected?.accountSubject).toEqual({
            kind: 'providerSubject',
            id: stableKey.accountSubjectId,
        });
        expect(store.listSnapshots().map((snapshot) => snapshot.recordId)).toEqual([toRecordId]);
        expect(store.resolveByAlias({
            kind: 'nativeCli',
            providerId: 'claude',
            localCredentialRef: 'claude-native',
        })?.recordId).toBe(toRecordId);
    });

    it('rejects adoption attempts that would create a redirect cycle', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const stableKey = createKey('sub_stable_4');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);

        store.recordSnapshot(createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
        }));
        store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 4_000,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
        });

        expect(() => store.applyAdoption({
            providerId: 'claude',
            fromRecordId: toRecordId,
            toRecordId: fromRecordId,
            stableRecordKey: provisionalKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 4_500,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
        })).toThrow(/redirect cycle/i);

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(toRecordId);
        expect(store.resolveRecordId(toRecordId)?.recordId).toBe(toRecordId);
        expect(store.listSnapshots().map((snapshot) => snapshot.recordId)).toEqual([toRecordId]);
    });

    it('rejects adoption with a target record id that does not match the stable record key without mutating redirects', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const stableKey = createKey('sub_stable_4');
        const mismatchedStableKey = createKey('sub_stable_mismatch');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);

        store.recordSnapshot(createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
        }));

        expect(() => store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: mismatchedStableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 4_200,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: mismatchedStableKey.accountSubjectId }],
        })).toThrow();

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(fromRecordId);
        expect(store.resolveRecordId(toRecordId)).toBeNull();
        expect(store.listSnapshots().map((snapshot) => snapshot.recordId)).toEqual([fromRecordId]);
    });

    it('keeps newer canonical snapshot data when an older redirected write arrives later', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const stableKey = createKey('sub_stable_5');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);
        const oldProvisional = createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
            observedAtMs: 1_000,
            fetchedAtMs: 1_000,
            planLabel: 'Old provisional',
        });

        store.recordSnapshot(oldProvisional);
        store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
        });
        store.recordSnapshot(createSnapshot({
            recordKey: stableKey,
            recordId: toRecordId,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
            observedAtMs: 5_000,
            fetchedAtMs: 5_000,
            planLabel: 'Fresh stable',
        }));
        store.recordSnapshot(oldProvisional);

        const snapshot = store.resolveRecordId(toRecordId);
        expect(snapshot?.fetchedAtMs).toBe(5_000);
        expect(snapshot?.planLabel).toBe('Fresh stable');
        expect(snapshot?.aliases).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'nativeCli',
                accountSubjectId: stableKey.accountSubjectId,
            }),
        ]));
    });

    it('rejects conflicting adoption for a provisional record already adopted to another stable record', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const stableKey = createKey('sub_stable_6');
        const conflictingStableKey = createKey('sub_stable_7');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);
        const conflictingToRecordId = buildProviderAccountUsageRecordId(conflictingStableKey);

        store.recordSnapshot(createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
        }));
        store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 6_000,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
        });

        expect(() => store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId: conflictingToRecordId,
            stableRecordKey: conflictingStableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 6_500,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: conflictingStableKey.accountSubjectId }],
        })).toThrow(/already adopted/i);

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(toRecordId);
        expect(store.resolveRecordId(conflictingToRecordId)).toBeNull();
        expect(store.listSnapshots().map((snapshot) => snapshot.recordId)).toEqual([toRecordId]);
    });

    it('rejects adoption that would move a stable record back to a provisional subject', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const stableKey = createKey('sub_stable_8');
        const provisionalKey = createKey('provisional:regression');
        const fromRecordId = buildProviderAccountUsageRecordId(stableKey);
        const toRecordId = buildProviderAccountUsageRecordId(provisionalKey);

        store.recordSnapshot(createSnapshot({
            recordKey: stableKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: stableKey.accountSubjectId }],
        }));

        expect(() => store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: provisionalKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 8_000,
            aliases: [{ kind: 'nativeCli', providerId: 'claude', accountSubjectId: provisionalKey.accountSubjectId }],
        })).toThrow(/stable target/i);

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(fromRecordId);
        expect(store.resolveRecordId(toRecordId)).toBeNull();
        expect(store.listSnapshots().map((snapshot) => snapshot.recordId)).toEqual([fromRecordId]);
    });
});
