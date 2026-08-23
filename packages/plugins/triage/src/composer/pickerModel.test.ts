import type { ComposerAttachmentViewV1 } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import { foldTriageSearchValue } from '../projection/entrySearch.js';
import { selectTriageAttachedEntries } from './attachedEntries.js';
import { deriveTriageComposerEntryAttachmentKey } from './attachmentValue.js';
import {
    buildTriagePickerView,
    requestTriagePickerRefresh,
    type TriagePickerCorpusFactsV1,
    type TriagePickerCorpusRowV1,
} from './pickerModel.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const OTHER_SOURCE = { pluginId: 'happier.tracker', localId: 'issues' } as const;
const INSTANCE_ID = '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78';
const OTHER_INSTANCE_ID = '9a3d1f22-4c8b-4e01-8fa7-15d0c6b93e44';
const NOW_MS = 1_700_000_000_000;

function entryRef(entryId: string, source: typeof SOURCE | typeof OTHER_SOURCE = SOURCE) {
    return { source, kindId: 'pull-request', collisionScope: 'origin', entryId } as const;
}

function row(input: Readonly<{
    entryId: string;
    title: string;
    scopeLabel?: string;
    source?: typeof SOURCE | typeof OTHER_SOURCE;
    instanceId?: string | null;
    routingToken?: string;
}>): TriagePickerCorpusRowV1 {
    const source = input.source ?? SOURCE;
    const scopeLabel = input.scopeLabel ?? 'acme/web';
    return {
        entryRef: entryRef(input.entryId, source),
        title: input.title,
        scopeLabel,
        // The locator the fold's winning observation carried, exactly as
        // `pickerFacts` reads it; `null` when no connection reports the entry.
        locator: input.routingToken === undefined
            ? null
            : { v: 1, routingToken: input.routingToken },
        // Folded by the one search owner, exactly as `pickerFacts` projects it
        // from the real observations. `projection/entrySearch.test.ts` proves the
        // full field set; these synthetic rows carry only what they display.
        search: [input.title, scopeLabel].map(foldTriageSearchValue),
        instance: input.instanceId === null
            ? { kind: 'none', reason: 'noPresentObservation' }
            : { kind: 'selected', sourceInstanceId: input.instanceId ?? INSTANCE_ID, reason: 'onlyPresent' },
    };
}

function facts(overrides: Partial<TriagePickerCorpusFactsV1> = {}): TriagePickerCorpusFactsV1 {
    return {
        configuredSourceInstanceCount: 2,
        rows: [],
        coverage: 'complete',
        freshness: { kind: 'current' },
        refreshRunning: false,
        health: [],
        refreshBlocked: null,
        nowMs: NOW_MS,
        ...overrides,
    };
}

function attachment(entryId: string, instanceId: string): ComposerAttachmentViewV1 {
    const ref = entryRef(entryId);
    return {
        v: 1,
        instanceId,
        attachment: { pluginId: 'happier.triage', localId: 'entry' },
        key: deriveTriageComposerEntryAttachmentKey(ref),
        value: {
            v: 1,
            entryRef: ref,
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
        },
        presentation: { typeLabel: 'Pull request', label: `Fix ${entryId}` },
        availability: { status: 'ready' },
    } as ComposerAttachmentViewV1;
}

const ROWS: readonly TriagePickerCorpusRowV1[] = [
    row({ entryId: '42', title: 'Fix the parser crash' }),
    row({ entryId: '7', title: 'Add retry budget', scopeLabel: 'acme/api' }),
    row({
        entryId: 'E-9',
        title: 'Parser regression in checkout',
        scopeLabel: 'acme/web',
        source: OTHER_SOURCE,
        instanceId: OTHER_INSTANCE_ID,
    }),
];

describe('buildTriagePickerView — corpus search', () => {
    it('searches cached rows across every source without touching a provider', () => {
        // The view is a pure projection over rows the corpus already holds: it
        // takes no reader, no client and no signal, so opening or typing cannot
        // issue a provider call or start a refresh.
        const view = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: 'parser', attached: [] });

        expect(view.rows.map((entry) => entry.entryRef.entryId)).toEqual(['42', 'E-9']);
    });

    it('matches case-insensitively across the title and the owning scope', () => {
        const byScope = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: 'ACME/API', attached: [] });

        expect(byScope.rows.map((entry) => entry.entryRef.entryId)).toEqual(['7']);
    });

    it('requires every typed term to match, in any order', () => {
        const view = buildTriagePickerView({
            facts: facts({ rows: ROWS }),
            query: '  checkout   parser ',
            attached: [],
        });

        expect(view.rows.map((entry) => entry.entryRef.entryId)).toEqual(['E-9']);
    });

    it('keeps the corpus ordering instead of re-ranking its own results', () => {
        // The declared corpus order is the product's ordering decision; a picker
        // that re-sorts becomes a second ordering owner.
        const view = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: '', attached: [] });

        expect(view.rows.map((entry) => entry.entryRef.entryId)).toEqual(['42', '7', 'E-9']);
    });

    it('gives every row a stable identity that survives a re-read of the same entry', () => {
        const first = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: '', attached: [] });
        const reread = buildTriagePickerView({
            facts: facts({ rows: ROWS.map((entry) => ({ ...entry, title: `${entry.title} ` })) }),
            query: '',
            attached: [],
        });

        expect(reread.rows.map((entry) => entry.id)).toEqual(first.rows.map((entry) => entry.id));
    });
});

describe('buildTriagePickerView — selection and row actions', () => {
    const attached = selectTriageAttachedEntries([attachment('42', 'triage-1')]);

    it('derives multi-selection from the canonical attachment snapshot alone', () => {
        const view = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: '', attached });

        expect(view.rows.map((entry) => entry.attachment.kind))
            .toEqual(['attached', 'notAttached', 'notAttached']);
    });

    it('plans Remove for an attached row and Attach for the rest', () => {
        const view = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: '', attached });

        expect(view.rows[0]?.mutation).toEqual({ kind: 'remove', instanceId: 'triage-1' });
        expect(view.rows[1]?.mutation).toEqual({
            kind: 'attach',
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
            presentation: { label: 'Add retry budget', description: 'acme/api' },
        });
    });

    it('carries the observed locator into Attach as the routing hint', () => {
        // The picker is the only place that still holds the locator the fold
        // chose for this row. If it drops it here, an account-wide connection
        // has nothing to route with at dispatch and the attachment can never
        // resolve.
        const view = buildTriagePickerView({
            facts: facts({ rows: [row({ entryId: '7', title: 'Add retry budget', routingToken: 'acme/api' })] }),
            query: '',
            attached: [],
        });

        const mutation = view.rows[0]?.mutation;
        expect(mutation?.kind).toBe('attach');
        if (mutation?.kind !== 'attach') return;
        expect(mutation.lastKnownLocator).toEqual({ v: 1, routingToken: 'acme/api' });
    });

    it('keeps every row non-activating so only its two controls commit an effect', () => {
        const view = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: '', attached });

        expect(view.rows.every((entry) => entry.activatesOnPress === false)).toBe(true);
    });

    it('opens View details under the same instance the mutation would use', () => {
        const view = buildTriagePickerView({ facts: facts({ rows: ROWS }), query: '', attached: [] });

        expect(view.rows[2]?.viewDetails).toEqual({
            kind: 'open',
            sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: OTHER_INSTANCE_ID },
        });
    });

    it('refuses Attach and View details when no live instance observes the row', () => {
        const view = buildTriagePickerView({
            facts: facts({ rows: [row({ entryId: '99', title: 'Retired', instanceId: null })] }),
            query: '',
            attached: [],
        });

        expect(view.rows[0]?.mutation).toEqual({ kind: 'unavailable', reason: 'noObservingInstance' });
        expect(view.rows[0]?.viewDetails).toEqual({ kind: 'unavailable', reason: 'noObservingInstance' });
    });

    it('still offers Remove for an attached row whose instances are all retired', () => {
        // Removal addresses the host-minted instance in the draft, so it never
        // depends on the entry still being observable.
        const view = buildTriagePickerView({
            facts: facts({ rows: [row({ entryId: '42', title: 'Retired', instanceId: null })] }),
            query: '',
            attached,
        });

        expect(view.rows[0]?.mutation).toEqual({ kind: 'remove', instanceId: 'triage-1' });
    });

    it('bounds the attachment label the composer will freeze', () => {
        // A source title is bounded at 4 KiB while a composer attachment label is
        // bounded at 256 code points; passing the raw title straight through
        // makes the host reject the whole attach.
        const view = buildTriagePickerView({
            facts: facts({ rows: [row({ entryId: '42', title: `${'A'.repeat(400)} tail` })] }),
            query: '',
            attached: [],
        });

        const mutation = view.rows[0]?.mutation;
        expect(mutation?.kind).toBe('attach');
        if (mutation?.kind !== 'attach') return;
        expect(Array.from(mutation.presentation.label).length).toBeLessThanOrEqual(256);
        expect(mutation.presentation.label.trim()).toBe(mutation.presentation.label);
    });
});

describe('buildTriagePickerView — corpus result state', () => {
    it('asks for configuration when no source instance is configured', () => {
        const view = buildTriagePickerView({
            facts: facts({ configuredSourceInstanceCount: 0 }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'configureSources' });
        expect(view.refresh).toEqual({ kind: 'unavailable', reason: 'noConfiguredSources' });
    });

    it('never reads an unsynchronized projection as proof that no source is configured', () => {
        // A projection no pass has filled reports zero configured sources
        // because it knows none. Concluding "no sources are configured" from it
        // is the false-empty `REQ-14` forbids, and it also withdraws Refresh —
        // the one control that would have answered the question.
        const view = buildTriagePickerView({
            facts: facts({
                configuredSourceInstanceCount: 0,
                freshness: { kind: 'neverSynchronized' },
            }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'neverSynchronized' });
        expect(view.refresh).toEqual({ kind: 'available' });
        expect(requestTriagePickerRefresh(view)).toEqual({ status: 'invoke' });
    });

    it('reports a healthy empty result for a completed covered query', () => {
        expect(buildTriagePickerView({ facts: facts(), query: '', attached: [] }).state)
            .toEqual({ kind: 'empty' });
    });

    it('never claims exhaustion for a walk that has produced no row yet', () => {
        // Freshness and coverage are independent facts: a walk can be current
        // and still be walking. Reading "no rows" from one as "there is nothing
        // to attach" is the same false exhaustion the query arm already refuses,
        // and it hides the fact that the reader should keep waiting.
        const view = buildTriagePickerView({
            facts: facts({ coverage: 'progressive' }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'boundedWindow' });
        expect(view.coverage).toBe('progressive');
        // A reader who typed nothing has no match to be waiting for. The
        // contract is that the two answers differ, asserted against this same
        // builder's answer for the narrowed window rather than against copy.
        const narrowed = buildTriagePickerView({
            facts: facts({ coverage: 'progressive' }),
            query: 'nothing matches this',
            attached: [],
        });
        expect(narrowed.state).toEqual({ kind: 'noMatchYet' });
        expect(view.state).not.toEqual(narrowed.state);
    });

    it('separates a query with no match yet from one the completed walk answered', () => {
        const progressive = buildTriagePickerView({
            facts: facts({ rows: ROWS, coverage: 'progressive' }),
            query: 'nothing matches this',
            attached: [],
        });
        const complete = buildTriagePickerView({
            facts: facts({ rows: ROWS }),
            query: 'nothing matches this',
            attached: [],
        });

        expect(progressive.state).toEqual({ kind: 'noMatchYet' });
        expect(complete.state).toEqual({ kind: 'noMatch' });
    });

    it('keeps last-known-good rows visible while reporting that they were never synchronized', () => {
        const view = buildTriagePickerView({
            facts: facts({ rows: ROWS, freshness: { kind: 'neverSynchronized' } }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'neverSynchronized' });
        expect(view.rows).toHaveLength(3);
        expect(view.refresh).toEqual({ kind: 'available' });
    });

    it('reports the corpus-owned staleness rather than judging freshness itself', () => {
        const view = buildTriagePickerView({
            facts: facts({ rows: ROWS, freshness: { kind: 'stale', lastMaterializedAtMs: NOW_MS - 90_000 } }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'stale', lastMaterializedAtMs: NOW_MS - 90_000 });
    });

    it('shows one updating treatment over the rows while a refresh is already running', () => {
        const view = buildTriagePickerView({
            facts: facts({ rows: ROWS, refreshRunning: true, freshness: { kind: 'stale', lastMaterializedAtMs: NOW_MS - 90_000 } }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'refreshing' });
        expect(view.rows).toHaveLength(3);
        expect(requestTriagePickerRefresh(view)).toEqual({ status: 'refused', reason: 'running' });
    });

    it('names an unavailable source only when every configured connection failed', () => {
        const failed = (sourceInstanceId: string, displayName: string) => ({
            sourceInstance: { source: SOURCE, sourceInstanceId },
            displayName,
            failure: { class: 'permission', code: 'forbidden' },
        } as const);
        const every = [failed(INSTANCE_ID, 'acme on Forge'), failed(OTHER_INSTANCE_ID, 'widgets on Forge')] as const;

        const view = buildTriagePickerView({
            facts: facts({ rows: [], health: [...every] }),
            query: '',
            attached: [],
        });

        expect(view.state).toEqual({ kind: 'sourcesUnavailable' });
        expect(view.health).toEqual(every);
    });

    it('does not claim no source could be read while other configured connections are still walking', () => {
        // `health` is the FAILED SUBSET, never the whole set. Reading its mere
        // presence as the headline replaces the picker with "No source could be
        // read" while two of three connections are walking normally — and the
        // reader loses the search field, the rows and Refresh with it. The
        // warning banner beside the rows already names the broken one.
        const health = [{
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
            displayName: 'acme on Forge',
            failure: { class: 'permission', code: 'forbidden' },
        }] as const;
        const partial = facts({ configuredSourceInstanceCount: 3, rows: [], health: [...health] });

        // The walk is still running, so the answer is the same one this builder
        // gives for that window with nothing broken at all.
        const walking = buildTriagePickerView({
            facts: { ...partial, coverage: 'progressive' },
            query: '',
            attached: [],
        });
        expect(walking.state).toEqual(buildTriagePickerView({
            facts: facts({ configuredSourceInstanceCount: 3, coverage: 'progressive' }),
            query: '',
            attached: [],
        }).state);
        expect(walking.health).toEqual(health);

        // And a completed walk answers with its own honest empty, still naming
        // the connection that failed beside it.
        const complete = buildTriagePickerView({ facts: partial, query: '', attached: [] });
        expect(complete.state).toEqual({ kind: 'empty' });
        expect(complete.health).toEqual(health);
    });

    it('states the coordinator\'s wait immediately and keeps Refresh disabled until it passes', () => {
        const waiting = (nextEligibleAtMs: number) => facts({
            rows: ROWS,
            refreshBlocked: { reason: 'sourceRetryDeadline', nextEligibleAtMs },
        });

        const blocked = buildTriagePickerView({ facts: waiting(NOW_MS + 45_000), query: '', attached: [] });
        const elapsed = buildTriagePickerView({ facts: waiting(NOW_MS - 1), query: '', attached: [] });

        expect(blocked.refresh).toEqual({
            kind: 'blockedUntil',
            reason: 'sourceRetryDeadline',
            nextEligibleAtMs: NOW_MS + 45_000,
        });
        expect(blocked.rows).toHaveLength(3);
        expect(requestTriagePickerRefresh(blocked)).toEqual({ status: 'refused', reason: 'notYetEligible' });
        expect(elapsed.refresh).toEqual({ kind: 'available' });
        expect(requestTriagePickerRefresh(elapsed)).toEqual({ status: 'invoke' });
    });

    /**
     * The discriminating case for the split this model used to hold: an
     * aggregate transient backoff carries no rate-limit failure and no provider
     * deadline, so a local `class === 'rateLimit'` scan reports an available
     * Refresh while the coordinator refuses it — a press that does nothing and
     * says nothing.
     */
    it('refuses a Refresh the coordinator is blocking for a reason no failure states', () => {
        const view = buildTriagePickerView({
            facts: facts({
                rows: ROWS,
                health: [{
                    sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
                    displayName: 'acme on Forge',
                    failure: { class: 'transient', code: 'bad-gateway' },
                }],
                refreshBlocked: { reason: 'failureBackoff', nextEligibleAtMs: NOW_MS + 5_000 },
            }),
            query: '',
            attached: [],
        });

        expect(view.refresh).toEqual({
            kind: 'blockedUntil',
            reason: 'failureBackoff',
            nextEligibleAtMs: NOW_MS + 5_000,
        });
        expect(requestTriagePickerRefresh(view)).toEqual({ status: 'refused', reason: 'notYetEligible' });
    });

    it('offers Refresh while a failed source states no deadline of its own', () => {
        const view = buildTriagePickerView({
            facts: facts({
                rows: ROWS,
                health: [{
                    sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: OTHER_INSTANCE_ID },
                    displayName: 'acme on Tracker',
                    failure: { class: 'permission', code: 'forbidden' },
                }],
            }),
            query: '',
            attached: [],
        });

        expect(view.refresh).toEqual({ kind: 'available' });
        expect(requestTriagePickerRefresh(view)).toEqual({ status: 'invoke' });
    });
});
