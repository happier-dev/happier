import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    TriageSourceInstanceDraftV1Schema,
    type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionHandleV1 } from '../collections/handles.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import {
    MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1,
    administerConfiguredSourceInstance,
} from './administerConfiguredSourceInstance.js';

/**
 * The one canonical `source-instances` lifecycle writer.
 *
 * Every assertion below is about identity and lifecycle rather than storage
 * mechanics: the row address is the exact private match tuple, the stable
 * `sourceInstanceId` is minted once for that tuple and adopted by every loser,
 * and a removed source can only come back through the explicit `reactivate`
 * arm.
 */

const SOURCE: PluginContributionIdentity = Object.freeze({
    pluginId: 'happier.example.source',
    localId: 'example-forge',
});
const OTHER_SOURCE: PluginContributionIdentity = Object.freeze({
    pluginId: 'happier.other.source',
    localId: 'other-forge',
});
const PURPOSE = 'triage-source';

function draft(overrides: Readonly<{
    accountId?: string;
    localInstanceKey?: string;
    token?: string;
    purpose?: string;
}> = {}): TriageSourceInstanceDraftV1 {
    return TriageSourceInstanceDraftV1Schema.parse({
        v: 1,
        binding: {
            purpose: overrides.purpose ?? PURPOSE,
            account: {
                service: { pluginId: SOURCE.pluginId, localId: 'accounts' },
                accountId: overrides.accountId ?? 'account-1',
            },
        },
        localInstanceKey: overrides.localInstanceKey ?? 'example/repository',
        keyStability: 'stable',
        configuration: { v: 1, token: overrides.token ?? 'routing-token' },
        locator: { v: 1, displayLabel: 'example/repository' },
    });
}

function mintSequence(...ids: readonly string[]): () => string {
    let next = 0;
    return () => {
        const id = ids[next];
        next += 1;
        if (id === undefined) throw new Error('Minted more source instance ids than the test allowed');
        return id;
    };
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

async function liveRows(
    sourceInstances: CorpusCollectionHandleV1,
): Promise<readonly CorpusSourceInstanceRowV1[]> {
    const page = await sourceInstances.query({ index: 'by-lifecycle', order: 'asc', limit: 64 });
    return page.rows.map((row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row).value);
}

/**
 * Holds every caller inside its pre-write read until the expected number of
 * callers has arrived, so two same-tuple creates genuinely overlap rather than
 * running one after the other.
 */
function barrierAtRead(
    inner: CorpusCollectionHandleV1,
    arrivals: number,
): CorpusCollectionHandleV1 {
    let seen = 0;
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    return {
        ...inner,
        get: async (rowId, options) => {
            const row = await inner.get(rowId, options);
            seen += 1;
            if (seen >= arrivals) open();
            await gate;
            return row;
        },
    };
}

describe('the canonical configured source instance writer', () => {
    it('creates one stable source instance when two same-tuple administration creates race', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A, ID_B);
        const barriered = barrierAtRead(collections.sourceInstances, 2);

        const [first, second] = await Promise.all([
            administerConfiguredSourceInstance({
                collections: { sourceInstances: barriered },
                source: SOURCE,
                declaredPurpose: PURPOSE,
                request: { kind: 'create', draft: draft() },
                nowMs: 10,
                mintSourceInstanceId: mint,
            }),
            administerConfiguredSourceInstance({
                collections: { sourceInstances: barriered },
                source: SOURCE,
                declaredPurpose: PURPOSE,
                request: { kind: 'create', draft: draft() },
                nowMs: 11,
                mintSourceInstanceId: mint,
            }),
        ]);

        // One CAS winner mints the stable ref; the loser re-reads that exact
        // tuple-addressed row and adopts the winner's id rather than minting a
        // second one.
        expect(first.kind === 'active' || first.kind === 'reused').toBe(true);
        expect(second.kind === 'active' || second.kind === 'reused').toBe(true);
        expect('sourceInstanceId' in first && 'sourceInstanceId' in second
            && first.sourceInstanceId === second.sourceInstanceId).toBe(true);

        const rows = await liveRows(collections.sourceInstances);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.active);
        expect(rows[0]?.sourceQualifiedId).toBe(`${SOURCE.pluginId}/${SOURCE.localId}`);
    });

    it('keeps two exact accounts with one local key as distinct source instances', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A, ID_B);

        const first = await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft({ accountId: 'account-1' }) },
            nowMs: 10,
            mintSourceInstanceId: mint,
        });
        const second = await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft({ accountId: 'account-2' }) },
            nowMs: 11,
            mintSourceInstanceId: mint,
        });

        expect(first).toEqual({ kind: 'active', sourceInstanceId: ID_A });
        expect(second).toEqual({ kind: 'active', sourceInstanceId: ID_B });
        expect(await liveRows(collections.sourceInstances)).toHaveLength(2);
    });

    it('reuses the active row instead of minting a second id for a repeated create', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A);

        await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft() },
            nowMs: 10,
            mintSourceInstanceId: mint,
        });
        const repeat = await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft({ token: 'later-token' }) },
            nowMs: 20,
            mintSourceInstanceId: mint,
        });

        expect(repeat).toEqual({ kind: 'reused', sourceInstanceId: ID_A });
        const rows = await liveRows(collections.sourceInstances);
        // A repeat create is not a reconfiguration: it never overwrites the
        // routing value the user actually configured.
        expect(rows[0]?.configured.configuration.token).toBe('routing-token');
    });

    it('reactivates an eligible retired row but never auto-reactivates userRemoved through create', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A, ID_B);
        const common = {
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            mintSourceInstanceId: mint,
        } as const;

        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft() },
            nowMs: 10,
        });
        expect(await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'remove', sourceInstanceId: ID_A },
            nowMs: 20,
        })).toEqual({ kind: 'removed', sourceInstanceId: ID_A });

        // A removed source never silently returns through discovery or create.
        expect(await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft() },
            nowMs: 30,
        })).toEqual({ kind: 'conflict' });

        // Only the explicit reactivate arm may bring it back, and it reuses the
        // exact stable ref rather than minting a second one.
        expect(await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'reactivate', sourceInstanceId: ID_A, draft: draft({ token: 'refreshed-token' }) },
            nowMs: 40,
        })).toEqual({ kind: 'reactivated', sourceInstanceId: ID_A });

        const rows = await liveRows(collections.sourceInstances);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lifecycle).toBe(CORPUS_SOURCE_INSTANCE_LIFECYCLE.active);
        expect(rows[0]?.retiredReason).toBeUndefined();
        expect(rows[0]?.configured.configuration.token).toBe('refreshed-token');
    });

    it('refreshes source-private configuration in place when reconfigure keeps the tuple', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A);
        const common = {
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            mintSourceInstanceId: mint,
        } as const;

        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft() },
            nowMs: 10,
        });
        const result = await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'reconfigure', sourceInstanceId: ID_A, draft: draft({ token: 'next-token' }) },
            nowMs: 20,
        });

        expect(result).toEqual({ kind: 'reconfigured', sourceInstanceId: ID_A });
        const rows = await liveRows(collections.sourceInstances);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.configured.configuration.token).toBe('next-token');
    });

    it('retires the former tuple and mints a new stable ref when reconfigure changes the tuple', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A, ID_C);
        const common = {
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            mintSourceInstanceId: mint,
        } as const;

        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft() },
            nowMs: 10,
        });
        const result = await administerConfiguredSourceInstance({
            ...common,
            request: {
                kind: 'reconfigure',
                sourceInstanceId: ID_A,
                draft: draft({ localInstanceKey: 'example/other-repository' }),
            },
            nowMs: 20,
        });

        expect(result).toEqual({ kind: 'reconfigured', sourceInstanceId: ID_C });
        const rows = await liveRows(collections.sourceInstances);
        expect(rows).toHaveLength(2);
        const retired = rows.filter((row) => row.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired);
        const active = rows.filter((row) => row.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active);
        expect(retired).toHaveLength(1);
        expect(retired[0]?.retiredReason).toBe('reconfigured');
        expect(retired[0]?.configured.instance.sourceInstanceId).toBe(ID_A);
        expect(active).toHaveLength(1);
        expect(active[0]?.configured.instance.sourceInstanceId).toBe(ID_C);
        expect(active[0]?.configured.localInstanceKey).toBe('example/other-repository');
    });

    it('rejects a caller that does not own the named configured instance', async () => {
        const { collections } = createTestkitCorpusCollections();
        await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft() },
            nowMs: 10,
            mintSourceInstanceId: mintSequence(ID_A),
        });

        expect(await administerConfiguredSourceInstance({
            collections,
            source: OTHER_SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'remove', sourceInstanceId: ID_A },
            nowMs: 20,
            mintSourceInstanceId: mintSequence(),
        })).toEqual({ kind: 'invalidCaller' });

        expect(await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'remove', sourceInstanceId: ID_B },
            nowMs: 20,
            mintSourceInstanceId: mintSequence(),
        })).toEqual({ kind: 'invalidCaller' });

        expect(await liveRows(collections.sourceInstances)).toHaveLength(1);
    });

    it('rejects a draft whose binding purpose is not the admitted descriptor purpose', async () => {
        const { collections } = createTestkitCorpusCollections();

        const result = await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft({ purpose: 'some-other-purpose' }) },
            nowMs: 10,
            mintSourceInstanceId: mintSequence(ID_A),
        });

        expect(result).toEqual({ kind: 'invalidCaller' });
        expect(await liveRows(collections.sourceInstances)).toHaveLength(0);
    });

    it('cannot reactivate one configured tuple onto a different tuple', async () => {
        const { collections } = createTestkitCorpusCollections();
        const mint = mintSequence(ID_A);
        const common = {
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            mintSourceInstanceId: mint,
        } as const;

        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft() },
            nowMs: 10,
        });
        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'remove', sourceInstanceId: ID_A },
            nowMs: 20,
        });

        // Reactivation restores a preexisting row; it cannot turn a newly
        // discovered candidate into that instance.
        expect(await administerConfiguredSourceInstance({
            ...common,
            request: {
                kind: 'reactivate',
                sourceInstanceId: ID_A,
                draft: draft({ accountId: 'account-2' }),
            },
            nowMs: 30,
        })).toEqual({ kind: 'conflict' });
    });
});

describe('the configured maximum', () => {
    /**
     * The falsifier here is silence. The aggregate reads one bounded page of
     * active rows, so a writer with no maximum lets a user configure a source
     * that then never appears in the list, never reports an error, and never
     * comes back — which is indistinguishable from the source being broken.
     */
    async function fill(collections: ReturnType<typeof createTestkitCorpusCollections>['collections']): Promise<void> {
        for (let index = 0; index < MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1; index += 1) {
            const result = await administerConfiguredSourceInstance({
                collections,
                source: SOURCE,
                declaredPurpose: PURPOSE,
                request: { kind: 'create', draft: draft({ localInstanceKey: `example/repository-${String(index)}` }) },
                nowMs: index,
                mintSourceInstanceId: () => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
            });
            expect(result.kind, `create ${String(index)}`).toBe('active');
        }
    }

    it('refuses to configure one past the maximum, with a settled answer of its own', async () => {
        const { collections } = createTestkitCorpusCollections();
        await fill(collections);

        expect(await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            request: { kind: 'create', draft: draft({ localInstanceKey: 'example/one-too-many' }) },
            nowMs: 1_000,
            mintSourceInstanceId: () => ID_C,
        })).toEqual({ kind: 'atMaximum' });

        // The refusal wrote nothing: the set is exactly what the user chose.
        expect(await liveRows(collections.sourceInstances)).toHaveLength(
            MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1,
        );
    });

    it('meets the same maximum when restoring a removed connection', async () => {
        const { collections } = createTestkitCorpusCollections();
        const common = {
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            mintSourceInstanceId: mintSequence(ID_A),
        } as const;

        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft({ localInstanceKey: 'example/removed' }) },
            nowMs: 1,
        });
        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'remove', sourceInstanceId: ID_A },
            nowMs: 2,
        });
        // The retired row is still there, and it does not occupy a slot.
        await fill(collections);

        expect(await administerConfiguredSourceInstance({
            ...common,
            request: {
                kind: 'reactivate',
                sourceInstanceId: ID_A,
                draft: draft({ localInstanceKey: 'example/removed' }),
            },
            nowMs: 3,
        })).toEqual({ kind: 'atMaximum' });
    });

    it('lets a retired row be restored while the active set has room', async () => {
        const { collections } = createTestkitCorpusCollections();
        const common = {
            collections,
            source: SOURCE,
            declaredPurpose: PURPOSE,
            mintSourceInstanceId: mintSequence(ID_A),
        } as const;

        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'create', draft: draft() },
            nowMs: 1,
        });
        await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'remove', sourceInstanceId: ID_A },
            nowMs: 2,
        });

        expect(await administerConfiguredSourceInstance({
            ...common,
            request: { kind: 'reactivate', sourceInstanceId: ID_A, draft: draft() },
            nowMs: 3,
        })).toEqual({ kind: 'reactivated', sourceInstanceId: ID_A });
    });
});
