import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import type { ProviderAccountUsageAdoptionV1 } from './adoption';

type ProviderAccountUsageStore = Readonly<{
    recordSnapshot(
        snapshot: ProviderAccountUsageSnapshotV1,
        observation?: Readonly<{
            sources?: readonly ConnectedServiceUsageSourceV1[];
    }>,
    ): Readonly<{ status: 'recorded'; recordId: string }>;
    resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
    resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
    listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
    applyAdoption(adoption: ProviderAccountUsageAdoptionV1): Readonly<{
        status: 'adopted' | 'already_adopted';
        fromRecordId: string;
        toRecordId: string;
    }>;
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
            status: 'recorded',
            recordId: stableSnapshot.recordId,
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

        expect(store.applyAdoption(adoption)).toEqual({ status: 'adopted', fromRecordId, toRecordId });
        expect(store.applyAdoption(adoption)).toEqual({ status: 'already_adopted', fromRecordId, toRecordId });

        store.recordSnapshot(createSnapshot({
            recordKey: stableKey,
            recordId: toRecordId,
            accountSubject: { kind: 'providerSubject', id: stableKey.accountSubjectId },
        }));

        expect(store.resolveRecordId(fromRecordId)?.recordId).toBe(toRecordId);
        expect('resolveByAlias' in store).toBe(false);
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

        store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 2_000,
        });

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

        store.applyAdoption({
            providerId: 'claude',
            fromRecordId,
            toRecordId,
            stableRecordKey: stableKey,
            proof: { kind: 'provider_account_id_match' },
            observedAtMs: 3_500,
        });

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
