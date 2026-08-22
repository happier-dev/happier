import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import type { ProviderAccountUsageAdoptionV1 } from './adoption';

type PreparedAdoption = Readonly<{
    status: 'adopted' | 'already_adopted';
    fromRecordId: string;
    toRecordId: string;
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    commit(): Readonly<{
        status: 'adopted' | 'already_adopted';
        fromRecordId: string;
        toRecordId: string;
    }>;
}>;

type ProviderAccountUsageStore = Readonly<{
    recordSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        observation?: Readonly<{
            sources?: readonly ConnectedServiceUsageSourceV1[];
    }>,
    ): Readonly<{
        status: 'snapshot_advanced' | 'source_linked' | 'duplicate' | 'older';
        recordId: string;
        snapshotAdvanced: boolean;
        sourceLinked: boolean;
    }>;
    resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
    resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
    listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
    prepareAdoption(adoption: ProviderAccountUsageAdoptionV1): PreparedAdoption;
}>;

type StoreModule = Readonly<{
    createProviderAccountUsageStore(): ProviderAccountUsageStore;
    isProviderAccountUsageStoreMutationAccepted(result: Readonly<{
        status: 'snapshot_advanced' | 'source_linked' | 'duplicate' | 'older';
        recordId: string;
        snapshotAdvanced: boolean;
        sourceLinked: boolean;
    }>): boolean;
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
        planLabel: 'Team',
        accountLabel: 'same visible label',
        meters: [],
        ...overrides,
    };
}

describe('provider account usage store', () => {
    it('uses the typed status as the only mutation-acceptance authority', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const recordId = createSnapshot().recordId;
        expect(module!.isProviderAccountUsageStoreMutationAccepted({
            status: 'duplicate',
            recordId,
            snapshotAdvanced: true,
            sourceLinked: true,
        })).toBe(false);
        expect(module!.isProviderAccountUsageStoreMutationAccepted({
            status: 'snapshot_advanced',
            recordId,
            snapshotAdvanced: false,
            sourceLinked: false,
        })).toBe(true);
    });

    it('records one stable provider-subject snapshot and resolves explicit sources without exposing alias lookup', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const stableSnapshot = createSnapshot();
        const firstProvisionalKey = createKey('provisional:native');
        const secondProvisionalKey = createKey('provisional:connected');

        expect(store.recordSnapshot(stableSnapshot, {
            sources: [{
                serviceId: 'anthropic',
                profileId: 'work',
                bindingKind: 'profile',
            }],
        })).toEqual({
            status: 'snapshot_advanced',
            recordId: stableSnapshot.recordId,
            snapshotAdvanced: true,
            sourceLinked: true,
        });

        store.recordSnapshot(createSnapshot({
            recordKey: firstProvisionalKey,
            accountSubject: { kind: 'provisionalLocalSubject', id: firstProvisionalKey.accountSubjectId },
            accountLabel: 'same@example.com',
        }));
        store.recordSnapshot(createSnapshot({
            recordKey: secondProvisionalKey,
            accountSubject: { kind: 'provisionalLocalSubject', id: secondProvisionalKey.accountSubjectId },
            accountLabel: 'same@example.com',
        }));

        expect('resolveByAlias' in store).toBe(false);
        expect(store.resolveBySource({
            serviceId: 'anthropic',
            profileId: 'work',
            bindingKind: 'profile',
        })?.recordId).toBe(stableSnapshot.recordId);
        expect(store.listSnapshots().map((snapshot) => snapshot.recordKey.accountSubjectId).sort()).toEqual([
            'provisional:connected',
            'provisional:native',
            'sub_stable_1',
        ]);
    });

    it('uses explicit connected-service sources when resolving group-member policy state', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const snapshot = createSnapshot();

        store.recordSnapshot(snapshot, {
            sources: [{
                serviceId: 'anthropic',
                profileId: 'work',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 7,
            }],
        });

        expect(store.resolveBySource({
            serviceId: 'anthropic',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 7,
        })?.recordId).toBe(snapshot.recordId);
        expect(store.resolveBySource({
            serviceId: 'anthropic',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 6,
        })).toBeNull();
    });

    it('does not derive source lookup authority without an explicit source link', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const snapshot = createSnapshot();

        store.recordSnapshot(snapshot);

        expect(store.resolveBySource({
            serviceId: 'anthropic',
            profileId: 'alias-only',
            bindingKind: 'profile',
        })).toBeNull();
    });

    it('classifies effective snapshot revisions, new source edges, duplicates, and older delivery', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const sourceA: ConnectedServiceUsageSourceV1 = {
            serviceId: 'anthropic',
            profileId: 'work',
            bindingKind: 'profile',
        };
        const sourceB: ConnectedServiceUsageSourceV1 = {
            serviceId: 'anthropic',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 7,
        };
        const initial = createSnapshot({ fetchedAtMs: 2_000, observedAtMs: 2_000 });

        expect(store.recordSnapshot(initial, { sources: [sourceA] })).toEqual({
            status: 'snapshot_advanced',
            recordId: initial.recordId,
            snapshotAdvanced: true,
            sourceLinked: true,
        });
        expect(store.recordSnapshot(initial, { sources: [sourceA] })).toEqual({
            status: 'duplicate',
            recordId: initial.recordId,
            snapshotAdvanced: false,
            sourceLinked: false,
        });
        expect(store.recordSnapshot(createSnapshot({
            fetchedAtMs: 1_000,
            observedAtMs: 1_000,
            planLabel: 'outdated',
        }))).toEqual({
            status: 'older',
            recordId: initial.recordId,
            snapshotAdvanced: false,
            sourceLinked: false,
        });
        expect(store.recordSnapshot(createSnapshot({
            fetchedAtMs: 1_000,
            observedAtMs: 1_000,
            planLabel: 'outdated',
        }), { sources: [sourceB] })).toEqual({
            status: 'source_linked',
            recordId: initial.recordId,
            snapshotAdvanced: false,
            sourceLinked: true,
        });
        expect(store.resolveBySource(sourceB)).toEqual(initial);

        expect(store.recordSnapshot(createSnapshot({
            fetchedAtMs: 2_000,
            observedAtMs: 2_000,
            planLabel: 'Enterprise',
        }), { sources: [sourceA, sourceB] })).toEqual({
            status: 'snapshot_advanced',
            recordId: initial.recordId,
            snapshotAdvanced: true,
            sourceLinked: false,
        });
        expect(store.resolveRecordId(initial.recordId)?.planLabel).toBe('Enterprise');
    });

    it('adopts provisional records into stable records with a redirect', async () => {
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
        }));

        const adoption: ProviderAccountUsageAdoptionV1 = {
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        };

        const prepared = store.prepareAdoption(adoption);
        expect(prepared).toEqual(expect.objectContaining({
            status: 'adopted',
            fromRecordId,
            toRecordId,
            snapshot: expect.objectContaining({
                recordId: toRecordId,
                recordKey: stableKey,
            }),
        }));
        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(fromRecordId);
        expect(store.resolveRecordId(toRecordId)).toBeNull();

        expect(prepared.commit()).toEqual({ status: 'adopted', fromRecordId, toRecordId });
        expect(store.prepareAdoption(adoption).commit()).toEqual({ status: 'already_adopted', fromRecordId, toRecordId });

        store.recordSnapshot(createSnapshot({
            recordKey: stableKey,
            recordId: toRecordId,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
        }));

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(toRecordId);
        expect('resolveByAlias' in store).toBe(false);
    });

    it('rejects cross-provider and materially cross-scope adoption before mutation', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:native');
        const provisional = createSnapshot({
            recordKey: provisionalKey,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
        });
        store.recordSnapshot(provisional);

        const crossProviderKey: ProviderAccountUsageRecordKeyV1 = {
            providerId: 'openai-codex',
            accountSubjectId: 'acct-stable',
            subjectKind: 'account',
            quotaScope: 'account',
        };
        expect(() => store.prepareAdoption({
            providerId: 'openai-codex',
            fromRecordId: provisional.recordId,
            toRecordId: buildProviderAccountUsageRecordId(crossProviderKey),
            stableRecordKey: crossProviderKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        })).toThrow(/provider/i);

        const crossScopeKey = createKey('sub-stable-model') as ProviderAccountUsageRecordKeyV1;
        const materiallyCrossScopeKey: ProviderAccountUsageRecordKeyV1 = {
            ...crossScopeKey,
            quotaScope: 'model',
            quotaScopeId: 'gpt-5',
        };
        expect(() => store.prepareAdoption({
            providerId: 'claude',
            fromRecordId: provisional.recordId,
            toRecordId: buildProviderAccountUsageRecordId(materiallyCrossScopeKey),
            stableRecordKey: materiallyCrossScopeKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        })).toThrow(/scope/i);

        expect(store.resolveRecordId(provisional.recordId)?.recordId).toBe(provisional.recordId);
    });

    it('moves explicit source links during provisional record adoption without deriving source authority from adoption data', async () => {
        const module = await loadStoreModule();
        expect(module).not.toBeNull();
        const store = module!.createProviderAccountUsageStore();
        const provisionalKey = createKey('provisional:connected');
        const stableKey = createKey('sub_stable_4');
        const fromRecordId = buildProviderAccountUsageRecordId(provisionalKey);
        const toRecordId = buildProviderAccountUsageRecordId(stableKey);

        store.recordSnapshot(createSnapshot({
            recordKey: provisionalKey,
            recordId: fromRecordId,
            accountSubject: { kind: 'provisionalLocalSubject', id: provisionalKey.accountSubjectId },
        }), {
            sources: [{
                serviceId: 'anthropic',
                profileId: 'work',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 7,
            }],
        });

        store.prepareAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        }).commit();

        expect(store.resolveBySource({
            serviceId: 'anthropic',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 7,
        })?.recordId).toBe(toRecordId);
        expect(store.resolveBySource({
            serviceId: 'anthropic',
            profileId: 'alias-only',
            bindingKind: 'profile',
        })).toBeNull();
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
            observedAtMs: 3_000,
            fetchedAtMs: 3_000,
        }));

        store.prepareAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 3_500,
        }).commit();

        const redirected = store.resolveRecordId(fromRecordId);
        expect(redirected?.recordId).toBe(toRecordId);
        expect(redirected?.recordKey).toEqual(stableKey);
        expect(redirected?.accountSubject).toEqual({
            kind: 'providerSubject',
            id: stableKey.accountSubjectId,
        });
        expect('resolveByAlias' in store).toBe(false);
    });
});
