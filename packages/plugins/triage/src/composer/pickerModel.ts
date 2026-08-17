import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    TriageEntryRefV1,
    TriageSourceFailureV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusSelectedInstanceV1 } from '../corpus/selection/selectObservationInstance.js';
import { findTriageAttachedEntry, type TriageAttachedEntryV1 } from './attachedEntries.js';
import { deriveTriageComposerEntryAttachmentKey } from './attachmentValue.js';
import { buildTriageEntryAttachmentPresentation } from './mutationPlan.js';

/**
 * The corpus-backed entry picker (`core/COMPOSER.md` §2).
 *
 * The picker is a pure projection over corpus rows the aggregate already holds
 * plus the canonical composer attachment snapshot. It takes no reader, client,
 * account or signal, which is what makes "opening and searching issue no
 * provider call" a property of the shape rather than a promise: there is
 * nothing here to call. The one exception is the explicit Refresh action, which
 * this module only *decides* — `requestTriagePickerRefresh` returns whether the
 * canonical Triage refresh coordinator may be invoked, and never invokes it.
 *
 * It also holds no selected set. Selection is derived from the snapshot on
 * every build, so a host badge removal, an undo, or a closed scope settles here
 * without a stale picker cache re-creating or undoing state.
 */

/** One already-read corpus row, as the aggregate's own reader projects it. */
export type TriagePickerCorpusRowV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    title: string;
    scopeLabel: string;
    /**
     * Which configured connection currently observes this entry, decided by the
     * corpus's one instance selector — never re-derived here.
     */
    instance: CorpusSelectedInstanceV1;
}>;

export type TriagePickerSourceHealthV1 = Readonly<{
    sourceInstance: TriageSourceInstanceRefV1;
    displayName: string;
    failure: TriageSourceFailureV1;
}>;

/**
 * Materialization freshness, decided by the corpus.
 *
 * Staleness arrives as a fact rather than a timestamp the picker judges: a local
 * ceiling here would be a second freshness owner and a guessed threshold.
 */
export type TriagePickerFreshnessV1 =
    | Readonly<{ kind: 'neverSynchronized' }>
    | Readonly<{ kind: 'current' }>
    | Readonly<{ kind: 'stale'; lastMaterializedAtMs: number }>;

export type TriagePickerCorpusFactsV1 = Readonly<{
    configuredSourceInstanceCount: number;
    /** The bounded page the corpus walk has produced so far, in its declared order. */
    rows: readonly TriagePickerCorpusRowV1[];
    coverage: 'complete' | 'progressive';
    freshness: TriagePickerFreshnessV1;
    refreshRunning: boolean;
    health: readonly TriagePickerSourceHealthV1[];
    nowMs: number;
}>;

export type TriagePickerRowMutationV1 =
    | Readonly<{
        kind: 'attach';
        sourceInstance: TriageSourceInstanceRefV1;
        presentation: ComposerAttachmentAuthorPresentationV1;
    }>
    | Readonly<{ kind: 'remove'; instanceId: string }>
    | Readonly<{ kind: 'unavailable'; reason: 'noObservingInstance' }>;

export type TriagePickerRowViewDetailsV1 =
    | Readonly<{ kind: 'open'; sourceInstance: TriageSourceInstanceRefV1 }>
    | Readonly<{ kind: 'unavailable'; reason: 'noObservingInstance' }>;

export type TriagePickerRowV1 = Readonly<{
    /** Stable list identity across re-reads: the entry's canonical attachment key. */
    id: string;
    entryRef: TriageEntryRefV1;
    title: string;
    scopeLabel: string;
    /** Always false: only the row's two explicit controls commit an effect. */
    activatesOnPress: false;
    attachment: Readonly<{ kind: 'attached'; instanceId: string }> | Readonly<{ kind: 'notAttached' }>;
    mutation: TriagePickerRowMutationV1;
    viewDetails: TriagePickerRowViewDetailsV1;
}>;

/** The one headline state; `health` names sources independently of it. */
export type TriagePickerStateV1 =
    | Readonly<{ kind: 'configureSources' }>
    | Readonly<{ kind: 'refreshing' }>
    | Readonly<{ kind: 'neverSynchronized' }>
    | Readonly<{ kind: 'stale'; lastMaterializedAtMs: number }>
    | Readonly<{ kind: 'sourcesUnavailable' }>
    | Readonly<{ kind: 'noMatchYet' }>
    | Readonly<{ kind: 'noMatch' }>
    | Readonly<{ kind: 'empty' }>
    | Readonly<{ kind: 'ready' }>;

export type TriagePickerRefreshV1 =
    | Readonly<{ kind: 'available' }>
    | Readonly<{ kind: 'running' }>
    | Readonly<{ kind: 'blockedUntil'; retryNotBeforeMs: number }>
    | Readonly<{ kind: 'unavailable'; reason: 'noConfiguredSources' }>;

export type TriagePickerViewV1 = Readonly<{
    rows: readonly TriagePickerRowV1[];
    state: TriagePickerStateV1;
    health: readonly TriagePickerSourceHealthV1[];
    refresh: TriagePickerRefreshV1;
    coverage: 'complete' | 'progressive';
}>;

export type TriagePickerRefreshRequestV1 =
    | Readonly<{ status: 'invoke' }>
    | Readonly<{ status: 'refused'; reason: 'running' | 'rateLimited' | 'noConfiguredSources' }>;

/** Every whitespace-separated term must appear, in any order, in either field. */
function matchesQuery(row: TriagePickerCorpusRowV1, terms: readonly string[]): boolean {
    if (terms.length === 0) return true;
    const haystack = `${row.title}\0${row.scopeLabel}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
}

/**
 * Whether the projection has concluded anything about configured sources.
 *
 * A projection no pass has ever filled reports zero configured sources because
 * it knows none, not because there are none. Reading that zero as an answer is
 * how a cold picker claims the reader has connected nothing — and then hides
 * the one control that would prove otherwise.
 */
function knowsConfiguredSources(facts: TriagePickerCorpusFactsV1): boolean {
    return facts.freshness.kind !== 'neverSynchronized';
}

function resolveRefresh(
    facts: TriagePickerCorpusFactsV1,
): TriagePickerRefreshV1 {
    if (knowsConfiguredSources(facts) && facts.configuredSourceInstanceCount === 0) {
        return { kind: 'unavailable', reason: 'noConfiguredSources' };
    }
    if (facts.refreshRunning) return { kind: 'running' };

    // The provider told us when it will answer again. Refresh stays disabled
    // until then, and the deadline is shown immediately rather than after a
    // failed retry. Several limited sources yield the furthest deadline,
    // because an earlier one would re-enable a refresh that cannot complete.
    let retryNotBeforeMs: number | null = null;
    for (const entry of facts.health) {
        if (entry.failure.class !== 'rateLimit') continue;
        const deadline = entry.failure.retryNotBeforeMs;
        if (deadline === undefined || deadline <= facts.nowMs) continue;
        retryNotBeforeMs = retryNotBeforeMs === null ? deadline : Math.max(retryNotBeforeMs, deadline);
    }
    return retryNotBeforeMs === null ? { kind: 'available' } : { kind: 'blockedUntil', retryNotBeforeMs };
}

function resolveState(input: Readonly<{
    facts: TriagePickerCorpusFactsV1;
    hasQuery: boolean;
    rowCount: number;
}>): TriagePickerStateV1 {
    const { facts, rowCount } = input;
    if (knowsConfiguredSources(facts) && facts.configuredSourceInstanceCount === 0) {
        return { kind: 'configureSources' };
    }
    // A running refresh outranks the freshness it is already repairing: the rows
    // stay visible under one updating treatment instead of two competing states.
    if (facts.refreshRunning) return { kind: 'refreshing' };
    if (facts.freshness.kind === 'neverSynchronized') return { kind: 'neverSynchronized' };
    if (facts.freshness.kind === 'stale') {
        return { kind: 'stale', lastMaterializedAtMs: facts.freshness.lastMaterializedAtMs };
    }
    // Only when no cached row can answer does source health become the headline;
    // otherwise the rows are the answer and health is named beside them.
    if (rowCount === 0 && facts.health.length > 0) return { kind: 'sourcesUnavailable' };
    if (rowCount > 0) return { kind: 'ready' };
    if (input.hasQuery) {
        return facts.coverage === 'progressive' ? { kind: 'noMatchYet' } : { kind: 'noMatch' };
    }
    return { kind: 'empty' };
}

export function buildTriagePickerView(input: Readonly<{
    facts: TriagePickerCorpusFactsV1;
    /** Ephemeral picker text. It is never persisted and never leaves this build. */
    query: string;
    /** The Triage records of the current canonical composer snapshot. */
    attached: readonly TriageAttachedEntryV1[];
}>): TriagePickerViewV1 {
    const { facts, attached } = input;
    const terms = input.query.trim().toLocaleLowerCase().split(/\s+/u).filter((term) => term !== '');

    const rows = facts.rows
        // Filtered, never re-ranked: the declared corpus order is the product's
        // one ordering decision.
        .filter((row) => matchesQuery(row, terms))
        .map((row): TriagePickerRowV1 => {
            const attachedRecord = findTriageAttachedEntry(attached, row.entryRef);
            const sourceInstance: TriageSourceInstanceRefV1 | null = row.instance.kind === 'selected'
                ? { source: row.entryRef.source, sourceInstanceId: row.instance.sourceInstanceId }
                : null;
            return {
                id: deriveTriageComposerEntryAttachmentKey(row.entryRef),
                entryRef: row.entryRef,
                title: row.title,
                scopeLabel: row.scopeLabel,
                activatesOnPress: false,
                attachment: attachedRecord
                    ? { kind: 'attached', instanceId: attachedRecord.instanceId }
                    : { kind: 'notAttached' },
                // Removal addresses the record already in the draft, so it stays
                // available even when every observing instance has retired.
                mutation: attachedRecord
                    ? { kind: 'remove', instanceId: attachedRecord.instanceId }
                    : sourceInstance === null
                        ? { kind: 'unavailable', reason: 'noObservingInstance' }
                        : {
                            kind: 'attach',
                            sourceInstance,
                            presentation: buildTriageEntryAttachmentPresentation(row),
                        },
                viewDetails: sourceInstance === null
                    ? { kind: 'unavailable', reason: 'noObservingInstance' }
                    : { kind: 'open', sourceInstance },
            };
        });

    return {
        rows,
        state: resolveState({ facts, hasQuery: terms.length > 0, rowCount: rows.length }),
        health: facts.health,
        refresh: resolveRefresh(facts),
        coverage: facts.coverage,
    };
}

/**
 * Whether the explicit Refresh control may invoke the canonical Triage refresh
 * coordinator. It is the only path from this picker to a provider read, and it
 * never starts a second refresh or retries before the provider's own deadline.
 */
export function requestTriagePickerRefresh(view: TriagePickerViewV1): TriagePickerRefreshRequestV1 {
    switch (view.refresh.kind) {
        case 'running':
            return { status: 'refused', reason: 'running' };
        case 'blockedUntil':
            return { status: 'refused', reason: 'rateLimited' };
        case 'unavailable':
            return { status: 'refused', reason: 'noConfiguredSources' };
        case 'available':
            return { status: 'invoke' };
    }
}
