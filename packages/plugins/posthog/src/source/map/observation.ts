/**
 * The one projection from this source's native snapshot into the shared Triage
 * observation contract.
 *
 * Everything above it — tolerant row decoding, identity, state mapping, fact selection,
 * truncation — has already happened. This module only renames those decided values into
 * the published shape, so a provider fact cannot acquire a different meaning on the way
 * out. In particular the three count facts keep their distinct provider semantics:
 * `occurrences` is exact for the configured ingested window and says so in its label,
 * while `users` and `sessions` are marked approximate rather than presented as totals.
 *
 * Severity is emitted as `detailOnly`. The list knows the fact exists but the CRUD plane
 * is the only place it lives, and fetching it per row would turn one scan page into an
 * N+1 read.
 */

import {
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    projectTriageDisplayTextV1,
    type TriageRowFactV1,
    type TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ENTRY_KIND, type PosthogEntrySnapshot } from './entrySnapshot.js';
import type { PosthogFact } from './facts.js';

type TriageRowFactImportance = TriageRowFactV1['importance'];

const FACT_PRESENTATION: Readonly<Record<PosthogFact['id'], Readonly<{
    id: string;
    label: string;
    importance: TriageRowFactImportance;
}>>> = {
    occurrences: {
        id: 'posthog/occurrences',
        // The window is named because the provider counts ingested events inside the
        // configured range, which is not "every time this happened".
        label: 'Occurrences in window',
        importance: 'primary',
    },
    lastSeen: { id: 'posthog/last-seen', label: 'Last seen', importance: 'primary' },
    function: { id: 'posthog/function', label: 'Function', importance: 'primary' },
    topFrame: { id: 'posthog/top-frame', label: 'Top frame', importance: 'primary' },
    release: { id: 'posthog/release', label: 'Release', importance: 'secondary' },
    users: { id: 'posthog/users', label: 'Users', importance: 'secondary' },
    sessions: { id: 'posthog/sessions', label: 'Sessions', importance: 'secondary' },
    source: { id: 'posthog/source', label: 'Source', importance: 'secondary' },
    library: { id: 'posthog/library', label: 'Library', importance: 'supplementary' },
    firstSeen: { id: 'posthog/first-seen', label: 'First seen', importance: 'supplementary' },
};

const SEVERITY_FACT_ID = 'posthog/severity';

function projectFact(fact: PosthogFact): TriageRowFactV1 {
    const presentation = FACT_PRESENTATION[fact.id];
    const common = {
        id: presentation.id,
        label: presentation.label,
        importance: presentation.importance,
    } as const;
    switch (fact.kind) {
        case 'count':
            return {
                ...common,
                value: fact.id === 'occurrences'
                    ? { kind: 'number', value: fact.value, format: 'compact' }
                    : { kind: 'number', value: fact.value, format: 'compact', approximate: true },
            };
        case 'text':
            return { ...common, value: { kind: 'text', value: fact.value } };
        case 'timestamp':
            return { ...common, value: { kind: 'timestamp', atMs: fact.atMs, format: 'relative' } };
    }
}

export type PosthogObservationInput = Readonly<{
    snapshot: PosthogEntrySnapshot;
    /** The provider's own clock for this entry; a display ordinal, never a decision. */
    sourceUpdatedAtMs?: number;
}>;

/**
 * Projects one present observation. `absent` and `merged` are deliberately
 * unreachable from here: V1 retains no fingerprint, so a plain provider 404 is
 * `unresolved` and no successor can be named.
 */
export function buildPosthogPresentObservation(
    input: PosthogObservationInput,
): Extract<TriageSourceObservationV1, Readonly<{ kind: 'present' }>> {
    const { snapshot } = input;
    const nativeLabel = projectTriageDisplayTextV1(
        snapshot.state.nativeLabel,
        MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    );
    const facts: TriageRowFactV1[] = snapshot.facts.map(projectFact);
    if (snapshot.severity !== undefined) {
        facts.push({
            id: SEVERITY_FACT_ID,
            label: 'Severity',
            importance: 'secondary',
            value: { kind: 'detailOnly' },
        });
    }

    return {
        kind: 'present',
        localRef: {
            kindId: POSTHOG_ENTRY_KIND,
            collisionScope: snapshot.locator.collisionScope,
            entryId: snapshot.locator.entryId,
        },
        // No `webUrl` is emitted: the exact issue permalink template is not
        // characterized for self-hosted deployments, and a guessed link would send a
        // user to a URL this source never verified.
        locator: { v: 1 },
        snapshot: {
            v: 1,
            title: snapshot.title,
            ...(snapshot.description === undefined ? {} : { summary: snapshot.description }),
            scopeLabel: snapshot.scopeLabel,
            state: {
                presentation: snapshot.state.presentation,
                // PostHog declares `status` as a bare string, so an unrecognized value
                // reaches here verbatim. It is projected into one bounded line like
                // every other display string; nothing surviving omits the label rather
                // than publishing a blank one the published string would reject.
                ...(nativeLabel.value.length === 0 ? {} : { nativeLabel: nativeLabel.value }),
            },
            facts,
            ...(snapshot.projectionTruncated ? { projectionTruncated: true as const } : {}),
        },
        // V1 emits no source-native attention claim, so involvement stays empty rather
        // than inferring one from a provider assignee that names no Happier viewer.
        viewer: { involvement: [] },
        ...(input.sourceUpdatedAtMs === undefined
            ? {}
            : { sourceUpdatedAtMs: input.sourceUpdatedAtMs }),
    };
}
