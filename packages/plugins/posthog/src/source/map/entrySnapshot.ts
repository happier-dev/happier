/**
 * Snapshot projection for one PostHog error issue.
 *
 * A provider-valid issue always stays visible. This projection never rejects a whole
 * entity for exceeding a byte ceiling: overlong title and description text is
 * Unicode-safe truncated to the shared display bound, facts are selected in a stable
 * source-owned priority order and bounded by the shared fact count, and the entry
 * records `projectionTruncated` when anything was shortened or dropped. Identity,
 * native state, and the destructive `suppressed` semantics are never truncated or
 * substituted, and a missing required identity or state is a malformed-row diagnostic
 * upstream rather than a reason to hide other valid rows.
 *
 * The mapped shape is intentionally source-local. Binding it to the shared Triage entry
 * contract is a separate, mechanical step.
 */

import type {
    PosthogIssueCrudRead,
    PosthogIssueQueryDetail,
    PosthogIssueRow,
} from '../../api/types/issues.js';
import type { PosthogEntryLocator } from '../identity.js';
import { projectTriageDisplayTextV1 } from '@happier-dev/triage-protocol/v1';

import type { PosthogProjectionBounds } from './bounds.js';
import { projectPosthogFacts, type PosthogFact } from './facts.js';
import { mapPosthogIssueState, type PosthogMappedState } from './state.js';

/** The one kind this source emits. */
export const POSTHOG_ENTRY_KIND = 'error-issue';

export type PosthogEntrySnapshot = Readonly<{
    kind: typeof POSTHOG_ENTRY_KIND;
    locator: PosthogEntryLocator;
    title: string;
    description?: string;
    state: PosthogMappedState;
    /** Presentation-only environment label; never identity and never a route. */
    scopeLabel: string;
    facts: readonly PosthogFact[];
    /** Detail-only: severity exists on the CRUD plane alone. */
    severity?: 'low' | 'medium' | 'high' | 'critical';
    projectionTruncated: boolean;
}>;

export type PosthogScopeLabelInput = Readonly<{
    /** The configured Team/environment display name. */
    displayName?: string;
    /** Display fallback only. A parent project id is never used here. */
    teamRouteId: number;
}>;

/**
 * Builds the environment label. When the configured display name is missing, the Team
 * route id is the display fallback — the parent project id never is, because it names a
 * different provider object.
 */
export function buildPosthogScopeLabel(
    input: PosthogScopeLabelInput,
    bounds: PosthogProjectionBounds,
): Readonly<{ value: string; truncated: boolean }> {
    const name = input.displayName?.trim() ?? '';
    if (name.length === 0) {
        return { value: `Environment ${String(input.teamRouteId)}`, truncated: false };
    }
    const label = projectTriageDisplayTextV1(name, bounds.textUtf8Bytes);
    return label.value.length === 0
        ? { value: `Environment ${String(input.teamRouteId)}`, truncated: false }
        : label;
}

export type PosthogSnapshotInput = Readonly<{
    locator: PosthogEntryLocator;
    row: PosthogIssueRow;
    scope: PosthogScopeLabelInput;
    /** Present only on a detail read, where the CRUD plane supplied severity. */
    crud?: PosthogIssueCrudRead;
    /** Query-only detail fields that a paid enrichment request already returned. */
    enrichment?: PosthogIssueQueryDetail;
    /** Localized fallback used when the provider supplied neither name nor description. */
    untitledLabel: string;
    /** Shared contract limits, supplied by the caller. */
    bounds: PosthogProjectionBounds;
}>;

export function buildPosthogEntrySnapshot(input: PosthogSnapshotInput): PosthogEntrySnapshot {
    const { bounds } = input;
    let projectionTruncated = false;

    // A PostHog exception name carries the thrown message, which routinely spans lines.
    // Every V1 string is single-line and the target rejects a control-bearing result
    // ATOMICALLY, so the shared owner normalizes before this projection measures
    // anything. Nothing survives normalization only when the provider supplied nothing
    // renderable, which is what the localized fallback is for.
    const rawTitle = input.row.name ?? input.row.description ?? '';
    const titleSource = rawTitle.trim().length === 0 ? input.untitledLabel : rawTitle;
    const projectedTitle = projectTriageDisplayTextV1(titleSource, bounds.textUtf8Bytes);
    const title = projectedTitle.value.length === 0
        ? projectTriageDisplayTextV1(input.untitledLabel, bounds.textUtf8Bytes)
        : projectedTitle;
    projectionTruncated = projectionTruncated || title.truncated;

    // The description is omitted when it is the same string already used as the title.
    const rawDescription = input.row.description;
    const description = rawDescription !== null
        && rawDescription.trim().length > 0
        && rawDescription !== titleSource
        ? projectTriageDisplayTextV1(rawDescription, bounds.textUtf8Bytes)
        : null;
    if (description !== null) {
        projectionTruncated = projectionTruncated || description.truncated;
    }

    const scopeLabel = buildPosthogScopeLabel(input.scope, bounds);
    projectionTruncated = projectionTruncated || scopeLabel.truncated;

    const projectedFacts = projectPosthogFacts(input.row, bounds, input.enrichment);
    projectionTruncated = projectionTruncated || projectedFacts.truncated;

    const severity = input.crud?.severity ?? null;

    return {
        kind: POSTHOG_ENTRY_KIND,
        locator: input.locator,
        title: title.value,
        ...(description === null || description.value.length === 0
            ? {}
            : { description: description.value }),
        state: mapPosthogIssueState(input.row.nativeStatus),
        scopeLabel: scopeLabel.value,
        facts: projectedFacts.facts,
        ...(severity === null ? {} : { severity }),
        projectionTruncated,
    };
}
