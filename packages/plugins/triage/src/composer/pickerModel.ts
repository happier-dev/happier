import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusSelectedInstanceV1 } from '../corpus/selection/selectObservationInstance.js';
import {
    isTriageRefreshPacingBlockActiveV1,
    type TriageRefreshPacingBlockV1,
} from '../refresh/refreshEligibility.js';
import {
    parseTriageSearchQuery,
    triageEntryMatchesSearch,
    type TriageEntrySearchTextV1,
} from '../projection/entrySearch.js';
import type { TriageSourceHealthV1 } from '../projection/sourceHealth.js';
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
     * What a reader can find this row by, projected by the one search owner.
     *
     * It is carried rather than re-derived because the picker must answer a
     * query exactly as the list does: a private haystack here is how the same
     * query came to mean two things over one projection.
     */
    search: TriageEntrySearchTextV1;
    /**
     * The locator the fold's winning observation carried, or `null` when no
     * connection reports the entry at all.
     *
     * The picker is the last surface that still holds it: once an entry is
     * attached, the draft is all the dispatch resolver has. Dropping it here
     * leaves an account-wide connection with no provider scope to knock at, and
     * the attachment can then never resolve.
     */
    locator: TriageEntryLocatorV1 | null;
    /**
     * Which configured connection currently observes this entry, decided by the
     * corpus's one instance selector — never re-derived here.
     */
    instance: CorpusSelectedInstanceV1;
}>;

/*
 * Which connections could not be read is `projection/sourceHealth.ts`'s
 * `TriageSourceHealthV1`, used here verbatim. The picker names them; it does
 * not decide them, because the shell names the same connections beside the list
 * and two joins would be two answers to one question.
 */

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
    health: readonly TriageSourceHealthV1[];
    /**
     * The refresh coordinator's own refusal, when a read cannot start yet.
     *
     * It arrives as a decided fact for the same reason freshness does: a local
     * derivation here would be a second pacing owner, and the narrower one this
     * module used to compute knew only about rate limits — so an aggregate
     * transient backoff left Refresh enabled and silent.
     */
    refreshBlocked: TriageRefreshPacingBlockV1 | null;
    nowMs: number;
}>;

export type TriagePickerRowMutationV1 =
    | Readonly<{
        kind: 'attach';
        sourceInstance: TriageSourceInstanceRefV1;
        presentation: ComposerAttachmentAuthorPresentationV1;
        /** The observed routing hint, absent when the row carries no locator. */
        lastKnownLocator?: TriageEntryLocatorV1;
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
    /**
     * The window has not exhausted every lane and the reader has narrowed it.
     * Spelled as `ui/shell/emptyState.ts` spells the same two facts, so one
     * concept keeps one word across the two surfaces that report it.
     */
    | Readonly<{ kind: 'noMatchYet' }>
    /** Not exhausted, and nothing narrowing it: there is no match to be waiting for. */
    | Readonly<{ kind: 'boundedWindow' }>
    | Readonly<{ kind: 'noMatch' }>
    | Readonly<{ kind: 'empty' }>
    | Readonly<{ kind: 'ready' }>;

export type TriagePickerRefreshV1 =
    | Readonly<{ kind: 'available' }>
    | Readonly<{ kind: 'running' }>
    | (Readonly<{ kind: 'blockedUntil' }> & TriageRefreshPacingBlockV1)
    | Readonly<{ kind: 'unavailable'; reason: 'noConfiguredSources' }>;

export type TriagePickerViewV1 = Readonly<{
    rows: readonly TriagePickerRowV1[];
    state: TriagePickerStateV1;
    health: readonly TriageSourceHealthV1[];
    refresh: TriagePickerRefreshV1;
    coverage: 'complete' | 'progressive';
}>;

export type TriagePickerRefreshRequestV1 =
    | Readonly<{ status: 'invoke' }>
    | Readonly<{ status: 'refused'; reason: 'running' | 'notYetEligible' | 'noConfiguredSources' }>;

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

    // A provider deadline or an aggregate backoff is still running. Refresh stays
    // disabled until it passes, and it is stated immediately rather than after a
    // press that does nothing. Which deadline, and whether any connection is
    // still readable, are the coordinator's answers — read, never recomputed.
    const blocked = facts.refreshBlocked;
    // The boundary comparison itself has one owner, so the picker and the shell
    // cannot disagree about whether a deadline has passed.
    return isTriageRefreshPacingBlockActiveV1(blocked, facts.nowMs)
        ? { kind: 'blockedUntil', reason: blocked.reason, nextEligibleAtMs: blocked.nextEligibleAtMs }
        : { kind: 'available' };
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
    // Only when no configured connection could be read at all does source health
    // become the headline; otherwise the rows are the answer and health is named
    // beside them. `health` is the failed SUBSET, so its mere presence proves
    // nothing about the connections it does not name: reading it that way
    // replaced the whole picker — search field, rows and Refresh — with "No
    // source could be read" while every other connection was walking normally.
    if (rowCount === 0 && facts.health.length >= facts.configuredSourceInstanceCount) {
        return { kind: 'sourcesUnavailable' };
    }
    if (rowCount > 0) return { kind: 'ready' };
    // Coverage decides both empty arms, because a bounded window that has not
    // exhausted every lane has concluded nothing — with or without a query.
    // Freshness is a separate fact: a walk can be current and still be walking,
    // so "Nothing to attach" read from a fresh progressive window is the same
    // false claim of exhaustion "No match" would be over the same rows. Which
    // of the two unexhausted answers applies is the reader's own lens, exactly
    // as `ui/shell/emptyState.ts` decides it: with nothing typed there is no
    // match to be waiting for, only a list that is not complete yet.
    if (facts.coverage === 'progressive') {
        return input.hasQuery ? { kind: 'noMatchYet' } : { kind: 'boundedWindow' };
    }
    return input.hasQuery ? { kind: 'noMatch' } : { kind: 'empty' };
}

export function buildTriagePickerView(input: Readonly<{
    facts: TriagePickerCorpusFactsV1;
    /** Ephemeral picker text. It is never persisted and never leaves this build. */
    query: string;
    /** The Triage records of the current canonical composer snapshot. */
    attached: readonly TriageAttachedEntryV1[];
}>): TriagePickerViewV1 {
    const { facts, attached } = input;
    // The one search owner decides both halves. Folding the query here would
    // reintroduce the divergence: the list and the picker must fold the same
    // way, and locale-dependent folding made them disagree per device.
    const terms = parseTriageSearchQuery(input.query);

    const rows = facts.rows
        // Filtered, never re-ranked: the declared corpus order is the product's
        // one ordering decision.
        .filter((row) => triageEntryMatchesSearch(row.search, terms))
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
                            ...(row.locator === null ? {} : { lastKnownLocator: row.locator }),
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
            return { status: 'refused', reason: 'notYetEligible' };
        case 'unavailable':
            return { status: 'refused', reason: 'noConfiguredSources' };
        case 'available':
            return { status: 'invoke' };
    }
}
