import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import {
    type TriageEntryPresentationStateV1,
    type TriageEntryRefV1,
    type TriageFixPullRequestStatusV1,
    type TriageFixPullRequestV1,
    type TriageSourceFailureV1,
    type TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
import type {
    CorpusFixPullRequestLinkV1,
    CorpusUserMarkRowV1,
} from '../collections/rows.js';
import { entryReferenceComponents, sameTriageEntryReference } from '../identity/components.js';
import { deriveUserMarkTag } from '../identity/tags.js';
import type { createTriageSourceSessionRelations } from '../../sessions/sourceSessionRelations.js';

/**
 * The read and resolution half of the fix-PR link (`design/FIX-LINK.md`).
 *
 * The relationship "this pull request fixes that issue or error group" has three
 * inputs and no store of its own:
 *
 * - the user's explicit choice, kept on the entry's `user-marks` row and written
 *   only by `setPinned.ts#setFixPullRequest`, the one `user-marks` writer;
 * - the candidates a fixing Session already implies through the composed
 *   source/corpus relation owner.
 * - current native associations supplied by the selected source's optional read role.
 *
 * Nothing here writes. The derived half is recomputed from the Session links on
 * every read, so unlinking the PR from the Session removes the candidate by
 * construction and there is no second copy of the relationship to drift.
 */

/** One pull request a fixing Session is linked to. */
export type TriageCoLinkedEntryV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    displayPath: string;
    linkedAtMs: number;
}>;

export type TriageFixPullRequestSourcesV1 = Readonly<{
    linked: readonly CorpusFixPullRequestLinkV1[];
    dismissed: readonly TriageEntryRefV1[];
    /** Every other entry a Session linked to this entry is also linked to, of any kind. */
    coLinked: readonly TriageCoLinkedEntryV1[];
    native?: readonly Omit<TriageFixPullRequestV1, 'origins'>[];
    /** A requested relation slice failed or was unavailable, so candidates may be missing. */
    incomplete: boolean;
}>;

type FixReadCollections = Pick<CorpusCollectionsV1, 'userMarks'>;
type FixSessionRelations = Pick<ReturnType<typeof createTriageSourceSessionRelations>, 'read' | 'readSessions'>;

export async function readFixPullRequestSources(input: Readonly<{
    collections: FixReadCollections;
    sourceRelations: FixSessionRelations;
    entryRef: TriageEntryRefV1;
    signal?: AbortSignal;
}>): Promise<TriageFixPullRequestSourcesV1> {
    const { collections, entryRef } = input;
    const options: PluginCancellationOptions | undefined = input.signal ? { signal: input.signal } : undefined;

    const markTag = await deriveUserMarkTag(collections.userMarks, entryRef, options);
    const stored = await collections.userMarks.get(markTag, options);
    const choice = stored ? fromCorpusStoredRow<CorpusUserMarkRowV1>(stored).value.fixPullRequests : undefined;

    let sessions: Awaited<ReturnType<FixSessionRelations['read']>>;
    try {
        sessions = await input.sourceRelations.read({ entryRef });
    } catch {
        throwIfAborted(input.signal);
        return Object.freeze({ linked: choice?.linked ?? [], dismissed: choice?.dismissed ?? [], coLinked: [], incomplete: true });
    }
    let incomplete = sessions.kind !== 'complete';

    const coLinked = new Map<string, TriageCoLinkedEntryV1>();
    const sessionIds = [...new Set(sessions.links.map(link => link.sessionId))];
    if (sessionIds.length > 0) {
        const siblings = await input.sourceRelations.readSessions(sessionIds, true).catch(() => {
            throwIfAborted(input.signal);
            return { kind: 'failed' as const, links: [] };
        });
        if (siblings.kind !== 'complete') incomplete = true;
        for (const sibling of siblings.links) {
            if (sameTriageEntryReference(sibling.entryRef, entryRef)) continue;
            const key = JSON.stringify(entryReferenceComponents(sibling.entryRef));
            const seen = coLinked.get(key);
            if (seen === undefined) {
                coLinked.set(key, {
                    entryRef: sibling.entryRef,
                    displayPath: sibling.displayPath,
                    linkedAtMs: sibling.linkedAtMs,
                });
            } else if (seen.linkedAtMs < sibling.linkedAtMs) {
                coLinked.set(key, { ...seen, linkedAtMs: sibling.linkedAtMs });
            }
        }
    }

    return Object.freeze({
        linked: choice?.linked ?? [],
        dismissed: choice?.dismissed ?? [],
        coLinked: Object.freeze([...coLinked.values()]),
        incomplete,
    });
}

/** The PR's lifecycle as the fix link reads it. */
export type { TriageFixPullRequestStatusV1, TriageFixPullRequestV1 } from '@happier-dev/triage-protocol/v1';
export type TriageFixPullRequestPresentationV1 = TriageEntryPresentationStateV1;

export type TriageResolvedFixPullRequestsV1 = Readonly<{
    /** Ranked: open, merged, unknown, then closed; a user link before a derived one; newest first. */
    candidates: readonly TriageFixPullRequestV1[];
    /** The PR whose Files and Checks the detail renders. Never a PR closed without merging. */
    primary: TriageFixPullRequestV1 | null;
    incomplete: boolean;
    nativeFailure?: TriageSourceFailureV1;
}>;

/** Private projection input: mounted facts or source-qualified exact reads, never caller-authored wire data. */
export type TriageFixPullRequestProjectionV1 = Readonly<{
    workflowSubjectOf(entryRef: TriageEntryRefV1): TriageSourceWorkflowSubjectV1 | null;
    presentationOf(entryRef: TriageEntryRefV1): TriageFixPullRequestPresentationV1 | null
        | Promise<TriageFixPullRequestPresentationV1 | null>;
    readNativeCandidates?(): Promise<Readonly<{
        candidates: readonly Omit<TriageFixPullRequestV1, 'origins'>[];
        incomplete: boolean;
        nativeFailure?: TriageSourceFailureV1;
    }>>;
}>;

/** A missing descriptor cannot invalidate a durable user choice. */
export function isKnownNonPullRequestSubject(subject: TriageSourceWorkflowSubjectV1 | null | undefined): boolean {
    return subject != null && subject !== 'pullRequest';
}

export async function readResolvedFixPullRequests(input: Readonly<{
    collections: FixReadCollections;
    sourceRelations: FixSessionRelations;
    entryRef: TriageEntryRefV1;
    projection: TriageFixPullRequestProjectionV1;
    signal?: AbortSignal;
}>): Promise<TriageResolvedFixPullRequestsV1> {
    const [relationships, native] = await Promise.all([
        readFixPullRequestSources(input), input.projection.readNativeCandidates?.(),
    ]);
    const sources = native === undefined ? relationships : {
        ...relationships, native: native.candidates, incomplete: relationships.incomplete || native.incomplete,
    };
    throwIfAborted(input.signal);
    // Let the canonical resolver filter, dismiss and deduplicate before any live source read.
    const candidates = resolveFixPullRequests(sources, {
        workflowSubjectOf: input.projection.workflowSubjectOf,
        presentationOf: () => null,
    }).candidates;
    const nativeKeys = new Set(sources.native?.map((candidate) => JSON.stringify(entryReferenceComponents(candidate.entryRef))));
    const presentations = await Promise.all(candidates.map(async ({ entryRef }) => {
        if (nativeKeys.has(JSON.stringify(entryReferenceComponents(entryRef)))) return null;
        if (input.projection.workflowSubjectOf(entryRef) !== 'pullRequest') return null;
        try {
            return await input.projection.presentationOf(entryRef);
        } catch {
            // Source reachability cannot erase a durable relationship; cancellation still aborts the read.
            throwIfAborted(input.signal);
            return null;
        }
    }));
    throwIfAborted(input.signal);
    const presentationsByEntry = new Map(candidates.map(({ entryRef }, index) => [
        JSON.stringify(entryReferenceComponents(entryRef)), presentations[index] ?? null,
    ]));
    const resolved = resolveFixPullRequests(sources, {
        workflowSubjectOf: input.projection.workflowSubjectOf,
        presentationOf: (entryRef) => presentationsByEntry.get(JSON.stringify(entryReferenceComponents(entryRef))) ?? null,
    });
    return native?.nativeFailure === undefined ? resolved : { ...resolved, nativeFailure: native.nativeFailure };
}

/**
 * Pull-request lifecycle in the source-neutral vocabulary (`CONTRACT.md` §4):
 * merged or completed is `resolved`; closed without merging is `closed`.
 */
function statusOf(presentation: TriageFixPullRequestPresentationV1 | null): TriageFixPullRequestStatusV1 {
    switch (presentation) {
        case 'active':
            return 'open';
        case 'resolved':
            return 'merged';
        case 'closed':
        case 'suppressed':
            return 'closed';
        default:
            return 'unknown';
    }
}

const STATUS_RANK: Readonly<Record<TriageFixPullRequestStatusV1, number>> = {
    open: 0,
    merged: 1,
    unknown: 2,
    closed: 3,
};

/** The first usable candidate in the canonical ranking; closed PRs never supply panels. */
export function selectPrimaryFixPullRequest(candidates: readonly TriageFixPullRequestV1[]): TriageFixPullRequestV1 | null {
    return candidates.find((candidate) => candidate.status !== 'closed') ?? null;
}

export function resolveFixPullRequests(
    sources: TriageFixPullRequestSourcesV1,
    projection: Readonly<{
        /** The kind's declared workflow subject, from the admitted source descriptors. */
        workflowSubjectOf(entryRef: TriageEntryRefV1): TriageSourceWorkflowSubjectV1 | null;
        /** The PR's presentation state in the reader's projection, or `null` when not projected. */
        presentationOf(entryRef: TriageEntryRefV1): TriageFixPullRequestPresentationV1 | null;
    }>,
): TriageResolvedFixPullRequestsV1 {
    const dismissed = new Set(sources.dismissed.map((entryRef) => JSON.stringify(entryReferenceComponents(entryRef))));

    type Draft = { candidate: TriageFixPullRequestV1; user: boolean; linkedAtMs: number };
    const drafts: Draft[] = [];
    const draftsByEntry = new Map<string, Draft>();

    for (const link of sources.linked) {
        const subject = projection.workflowSubjectOf(link.entryRef);
        if (isKnownNonPullRequestSubject(subject)) continue;
        const draft: Draft = {
            candidate: {
                entryRef: link.entryRef,
                origins: ['user'],
                status: statusOf(subject === null ? null : projection.presentationOf(link.entryRef)),
                display: { title: link.displayAtLink.title, scopeLabel: link.displayAtLink.scopeLabel },
            },
            user: true,
            linkedAtMs: link.linkedAtMs,
        };
        drafts.push(draft);
        const key = JSON.stringify(entryReferenceComponents(link.entryRef));
        if (!draftsByEntry.has(key)) draftsByEntry.set(key, draft);
    }
    for (const coLinked of sources.coLinked) {
        // A co-linked issue, error group or anything a source did not declare as
        // a pull request is not a fix candidate.
        if (projection.workflowSubjectOf(coLinked.entryRef) !== 'pullRequest') continue;
        const key = JSON.stringify(entryReferenceComponents(coLinked.entryRef));
        if (dismissed.has(key)) continue;
        const existing = draftsByEntry.get(key);
        if (existing) {
            existing.candidate = { ...existing.candidate, origins: ['user', 'session'] };
            continue;
        }
        const draft: Draft = {
            candidate: {
                entryRef: coLinked.entryRef,
                origins: ['session'],
                status: statusOf(projection.presentationOf(coLinked.entryRef)),
                display: { displayPath: coLinked.displayPath },
            },
            user: false,
            linkedAtMs: coLinked.linkedAtMs,
        };
        drafts.push(draft);
        draftsByEntry.set(key, draft);
    }

    for (const native of sources.native ?? []) {
        if (projection.workflowSubjectOf(native.entryRef) !== 'pullRequest') continue;
        const key = JSON.stringify(entryReferenceComponents(native.entryRef));
        if (dismissed.has(key)) continue;
        const existing = draftsByEntry.get(key);
        if (existing) {
            existing.candidate = { ...native, ...existing.candidate,
                status: native.status,
                display: { ...native.display, ...existing.candidate.display },
                ...(native.sourceContext === undefined ? {} : { sourceContext: native.sourceContext }),
                origins: existing.candidate.origins.includes('native') ? existing.candidate.origins : [...existing.candidate.origins, 'native'],
            };
        } else {
            const draft: Draft = { candidate: { ...native, origins: ['native'] }, user: false, linkedAtMs: 0 };
            drafts.push(draft);
            draftsByEntry.set(key, draft);
        }
    }

    drafts.sort((left, right) =>
        STATUS_RANK[left.candidate.status] - STATUS_RANK[right.candidate.status]
        || Number(right.user) - Number(left.user)
        || right.linkedAtMs - left.linkedAtMs);

    const candidates = Object.freeze(drafts.map((draft) => Object.freeze(draft.candidate)));
    const primary = selectPrimaryFixPullRequest(candidates);
    return Object.freeze({ candidates, primary, incomplete: sources.incomplete });
}
