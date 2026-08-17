/**
 * The PostHog-owned detail body model.
 *
 * The aggregate detail shell owns the stable common chrome — title, presentation state,
 * scope, attention and the linked-Session projection — so this model deliberately carries
 * none of them. What it carries is the provider-native part the shell cannot know: the
 * PostHog fact vocabulary with its own disclosures, the deferred detail-plane facts, and
 * the relationship between the observation the shell applied and the live materialization
 * this surface asks the source for.
 *
 * PostHog-derived Triage data is not an authoritative persisted corpus. The applied
 * observation is a bounded list projection that may be stale, so this model keeps it
 * visible as the pre-live body while a live `get` settles, and replaces it only when that
 * read returns the same exact entry. A live read that names another entry, concludes an
 * arm this source never emits, or fails is never allowed to blank a body the reader
 * already had.
 */

import type {
    TriageDetailSurfaceInputV1,
    TriageGetInputV1,
    TriageRowFactImportanceV1,
    TriageRowFactNumberFormatV1,
    TriageRowFactStatusToneV1,
    TriageRowFactTimestampFormatV1,
    TriageRowFactV1,
    TriageSourceEntryLocalRefV1,
    TriageSourceEntrySnapshotV1,
    TriageSourceFailureV1,
    TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_PLUGIN_ID, POSTHOG_SOURCE_CONTRIBUTION_ID } from '../../posthogContracts.js';
import { POSTHOG_ENTRY_KIND } from '../../source/map/entrySnapshot.js';

/**
 * One provider-native detail row.
 *
 * `pending` is the projection of a `detailOnly` fact. The list deliberately defers such a
 * fact to the detail plane, so rendering it as an empty value would claim the provider has
 * nothing to say about it.
 */
export type PosthogDetailFieldV1 =
    | Readonly<{
        kind: 'text';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        value: string;
    }>
    | Readonly<{
        kind: 'timestamp';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        atMs: number;
        format: TriageRowFactTimestampFormatV1;
    }>
    | Readonly<{
        kind: 'number';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        value: number;
        format: TriageRowFactNumberFormatV1;
        approximate: boolean;
        /**
         * The provider-native meaning of an exact-looking count, or `null` when the
         * number needs none. PostHog's occurrence count is exact only for the exceptions
         * it ingested inside the configured window, so it carries that sentence rather
         * than being presented as a lifetime total.
         */
        disclosure: string | null;
    }>
    | Readonly<{
        kind: 'status';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        value: string;
        tone: TriageRowFactStatusToneV1;
    }>
    | Readonly<{
        kind: 'pending';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
    }>;

/** Which observation the rendered rows came from. */
export type PosthogDetailBodyOriginV1 = 'applied' | 'live';

export type PosthogDetailBodyV1 = Readonly<{
    origin: PosthogDetailBodyOriginV1;
    fields: readonly PosthogDetailFieldV1[];
    /** `true` when the projected provider content itself was shortened or count-bounded. */
    projectionTruncated: boolean;
    /**
     * The target clock stamped on the applied observation. It is a fact about the mount,
     * never about the live read, so it is not restamped when a live body replaces it.
     */
    appliedObservedAtMs: number;
    /** The provider's own clock for the rendered body; a display ordinal only. */
    sourceUpdatedAtMs: number | null;
}>;

/** The settled relationship between the applied observation and the live read. */
export type PosthogDetailReadV1 =
    | Readonly<{ kind: 'applied' }>
    | Readonly<{ kind: 'materialized' }>
    | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>
    | Readonly<{ kind: 'refused'; reason: 'localRefMismatch' | 'unsupportedObservation' }>;

export type PosthogDetailNativeStateV1 = Readonly<{
    presentation: TriageSourceEntrySnapshotV1['state']['presentation'];
    /** PostHog's own word, kept because the shared presentation enum is lossy. */
    nativeLabel: string | null;
}>;

export type PosthogDetailSurfaceModelV1 = Readonly<{
    read: PosthogDetailReadV1;
    body: PosthogDetailBodyV1;
    /**
     * The native state the live read found when it disagrees with the state the shell is
     * already showing, and `null` otherwise. The shell owns the state chrome; this is the
     * provider-native disagreement it cannot know about, not a second copy of it.
     */
    nativeStateNow: PosthogDetailNativeStateV1 | null;
}>;

/**
 * `get` addresses one local ref through one exact configured instance. The qualified
 * source identity in the mounted entry ref is the address that selected this surface, not
 * payload, so it is dropped rather than carried into the request.
 */
export type PosthogDetailGetRequestV1 =
    | Readonly<{ kind: 'ready'; input: TriageGetInputV1 }>
    | Readonly<{ kind: 'refused'; reason: 'foreignSource' | 'foreignKind' }>;

const OCCURRENCES_FACT_ID = 'posthog/occurrences';

/**
 * The disclosure PostHog's occurrence count requires.
 *
 * Project-level and per-issue ingest limits and suppression sampling all reduce it, so the
 * number is exact for what PostHog ingested and is never every exception that occurred.
 */
const OCCURRENCES_DISCLOSURE =
    'Exact for the exceptions PostHog ingested in the configured window.'
    + ' Ingest limits and suppression sampling reduce it.';

function toDetailField(fact: TriageRowFactV1): PosthogDetailFieldV1 | null {
    const label = fact.label ?? fact.id;
    const common = { id: fact.id, label, importance: fact.importance } as const;
    switch (fact.value.kind) {
        case 'text':
        case 'actor':
            return { kind: 'text', ...common, value: fact.value.value };
        case 'timestamp':
            return {
                kind: 'timestamp',
                ...common,
                atMs: fact.value.atMs,
                format: fact.value.format,
            };
        case 'number':
            return {
                kind: 'number',
                ...common,
                value: fact.value.value,
                format: fact.value.format,
                approximate: fact.value.approximate === true,
                disclosure: fact.id === OCCURRENCES_FACT_ID ? OCCURRENCES_DISCLOSURE : null,
            };
        case 'status':
            return {
                kind: 'status',
                ...common,
                value: fact.value.value,
                tone: fact.value.tone,
            };
        case 'detailOnly':
            return { kind: 'pending', ...common };
        default:
            // A value arm this build does not know is presentation-only. The row is
            // skipped; the entry stays on the surface.
            return null;
    }
}

function projectBody(
    origin: PosthogDetailBodyOriginV1,
    snapshot: TriageSourceEntrySnapshotV1,
    appliedObservedAtMs: number,
    sourceUpdatedAtMs: number | undefined,
): PosthogDetailBodyV1 {
    return {
        origin,
        fields: snapshot.facts
            .map(toDetailField)
            .filter((field): field is PosthogDetailFieldV1 => field !== null),
        projectionTruncated: snapshot.projectionTruncated === true,
        appliedObservedAtMs,
        sourceUpdatedAtMs: sourceUpdatedAtMs ?? null,
    };
}

function sameLocalRef(
    left: TriageSourceEntryLocalRefV1,
    right: TriageSourceEntryLocalRefV1,
): boolean {
    return left.kindId === right.kindId
        && left.collisionScope === right.collisionScope
        && left.entryId === right.entryId;
}

function localRefOf(input: TriageDetailSurfaceInputV1): TriageSourceEntryLocalRefV1 {
    const { kindId, collisionScope, entryId } = input.observation.entryRef;
    return { kindId, collisionScope, entryId };
}

export function buildPosthogDetailGetRequest(
    input: TriageDetailSurfaceInputV1,
): PosthogDetailGetRequestV1 {
    const { source } = input.observation.entryRef;
    if (source.pluginId !== POSTHOG_PLUGIN_ID || source.localId !== POSTHOG_SOURCE_CONTRIBUTION_ID) {
        return { kind: 'refused', reason: 'foreignSource' };
    }
    if (input.observation.entryRef.kindId !== POSTHOG_ENTRY_KIND) {
        return { kind: 'refused', reason: 'foreignKind' };
    }
    return {
        kind: 'ready',
        input: {
            v: 1,
            instance: input.instance,
            localRef: localRefOf(input),
            // The mount already carries the locator the aggregate routed with, so the
            // live read starts from the location this reader is looking at rather than
            // re-deriving one.
            lastKnownLocator: input.observation.locator,
        },
    };
}

/**
 * Projects the mounted detail input, and the live read when one has settled, into the
 * body this source renders.
 *
 * `live` is `null` until the surface's own materialization settles. Every non-`present`
 * outcome keeps the applied body: a reader who could see the provider's facts a moment ago
 * must not lose them because a refresh failed.
 */
export function projectPosthogDetailSurface(
    input: TriageDetailSurfaceInputV1,
    live: TriageSourceObservationV1 | null,
): PosthogDetailSurfaceModelV1 {
    const appliedBody = projectBody(
        'applied',
        input.observation.snapshot,
        input.observation.observedAtMs,
        input.observation.sourceUpdatedAtMs,
    );

    if (live === null) {
        return { read: { kind: 'applied' }, body: appliedBody, nativeStateNow: null };
    }

    // V1 retains no fingerprint, so this source concludes neither absence nor a merge.
    // Such an arm did not come from this vertical and is not rendered as provider truth.
    if (live.kind === 'absent' || live.kind === 'merged') {
        return {
            read: { kind: 'refused', reason: 'unsupportedObservation' },
            body: appliedBody,
            nativeStateNow: null,
        };
    }

    if (!sameLocalRef(live.localRef, localRefOf(input))) {
        return {
            read: { kind: 'refused', reason: 'localRefMismatch' },
            body: appliedBody,
            nativeStateNow: null,
        };
    }

    if (live.kind === 'unresolved') {
        return {
            read: { kind: 'unavailable', failure: live.failure },
            body: appliedBody,
            nativeStateNow: null,
        };
    }

    const appliedState = input.observation.snapshot.state;
    const liveState = live.snapshot.state;
    const stateChanged = liveState.presentation !== appliedState.presentation
        || (liveState.nativeLabel ?? null) !== (appliedState.nativeLabel ?? null);

    return {
        read: { kind: 'materialized' },
        body: projectBody(
            'live',
            live.snapshot,
            input.observation.observedAtMs,
            live.sourceUpdatedAtMs,
        ),
        nativeStateNow: stateChanged
            ? { presentation: liveState.presentation, nativeLabel: liveState.nativeLabel ?? null }
            : null,
    };
}
