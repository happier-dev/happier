/**
 * The fixture source's provider mapping.
 *
 * This is the layer the public contract is really testing: raw provider rows in,
 * strict public V1 observations out. Two rules are load-bearing and both are
 * implemented here rather than delegated to a schema:
 *
 * 1. Raw rows are decoded one at a time. One malformed row is omitted and
 *    counted; its valid siblings still map. No malformed raw byte crosses into
 *    the strict result.
 * 2. A fact the source knows exists but loads only in its detail surface is
 *    projected as the labelled `detailOnly` arm. The list never invents a value
 *    it did not read.
 */
import {
    MAX_TRIAGE_ROW_FACTS_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';

/** The source's own kind vocabulary, declared in its descriptor. */
const KIND_BY_PROVIDER_TYPE = Object.freeze({ change: 'change', ticket: 'ticket' });

const PRESENTATION_BY_PROVIDER_STATUS = Object.freeze({
    open: 'active',
    triaged: 'active',
    closed: 'closed',
    resolved: 'resolved',
    merged_into: 'closed',
});

const TEXT_ENCODER = new TextEncoder();

function truncateToUtf8Bytes(value, maxUtf8Bytes) {
    if (TEXT_ENCODER.encode(value).length <= maxUtf8Bytes) return { value, truncated: false };
    let candidate = value;
    while (candidate.length > 0 && TEXT_ENCODER.encode(candidate).length > maxUtf8Bytes) {
        candidate = candidate.slice(0, -1);
    }
    return { value: candidate, truncated: true };
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

function isIntegerMs(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The source's collision scope: the provider space it read the row from. */
function localRefFor(row, collisionScope) {
    const kindId = KIND_BY_PROVIDER_TYPE[row.type];
    if (kindId === undefined || !isNonEmptyString(row.ref)) return null;
    return Object.freeze({ kindId, collisionScope, entryId: row.ref });
}

function projectFacts(row) {
    const facts = [];
    let truncated = false;

    if (isIntegerMs(row.updated_at)) {
        facts.push({
            id: 'acme/updated',
            label: 'Updated',
            importance: 'secondary',
            value: { kind: 'timestamp', atMs: row.updated_at, format: 'relative' },
        });
    }
    if (row.checks !== undefined && isNonEmptyString(row.checks?.label)) {
        facts.push({
            id: 'acme/checks',
            label: 'Checks',
            importance: 'primary',
            value: {
                kind: 'status',
                value: row.checks.label,
                tone: row.checks.state === 'passing' ? 'success' : 'warning',
            },
        });
    }
    if (isNonEmptyString(row.owner)) {
        // The provider carries the owner on the row, but this source resolves
        // owner presentation only in its detail surface. Declaring the fact
        // without a value is the exact difference between "loaded later" and
        // "genuinely unavailable".
        facts.push({
            id: 'acme/owner',
            label: 'Owner',
            importance: 'supplementary',
            value: { kind: 'detailOnly' },
        });
    }

    if (facts.length > MAX_TRIAGE_ROW_FACTS_V1) {
        truncated = true;
        facts.length = MAX_TRIAGE_ROW_FACTS_V1;
    }
    return { facts, truncated };
}

function projectViewer(row) {
    const involvement = [];
    if (Array.isArray(row.reviewers) && row.reviewers.includes('viewer')) {
        involvement.push('reviewRequested');
    }
    if (Array.isArray(row.assignees) && row.assignees.includes('viewer')) {
        involvement.push('assignee');
    }
    return involvement.includes('reviewRequested')
        ? {
            involvement,
            sourceAttention: {
                level: 'required',
                reasonId: 'acme/review-requested',
                reasonLabel: 'Your review is requested',
            },
        }
        : { involvement };
}

/**
 * Maps one raw provider row to one strict `present` observation, or returns
 * `null` when the row is malformed for this source's own contract.
 */
export function mapLedgerRow(row, collisionScope) {
    if (row === null || typeof row !== 'object') return null;
    const localRef = localRefFor(row, collisionScope);
    if (localRef === null) return null;
    if (!isNonEmptyString(row.headline) || !isNonEmptyString(row.space)) return null;

    const presentation = PRESENTATION_BY_PROVIDER_STATUS[row.status] ?? 'unknown';
    const title = truncateToUtf8Bytes(row.headline, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    const { facts, truncated: factsTruncated } = projectFacts(row);

    const snapshot = {
        v: 1,
        title: title.value,
        scopeLabel: row.space,
        state: { presentation, nativeLabel: String(row.status) },
        facts,
    };
    if (isNonEmptyString(row.detail)) snapshot.summary = row.detail;
    if (isIntegerMs(row.opened_at)) snapshot.createdAtMs = row.opened_at;
    if (title.truncated || factsTruncated) snapshot.projectionTruncated = true;

    const observation = {
        kind: 'present',
        localRef,
        locator: {
            v: 1,
            ...(isNonEmptyString(row.url) ? { webUrl: row.url } : {}),
            displayPath: `${row.space} ${row.ref}`,
        },
        snapshot,
        viewer: projectViewer(row),
    };
    if (isIntegerMs(row.updated_at)) observation.sourceUpdatedAtMs = row.updated_at;
    if (isNonEmptyString(row.revision)) observation.nativeRevision = row.revision;
    return observation;
}

/**
 * Tolerantly decodes one raw provider page.
 *
 * Every valid row survives an independently malformed sibling, and the omitted
 * count is the exact number of rows this source could not map.
 */
export function mapLedgerPage(rows, collisionScope) {
    const observations = [];
    let omittedItemCount = 0;
    for (const row of rows) {
        const observation = mapLedgerRow(row, collisionScope);
        if (observation === null) {
            omittedItemCount += 1;
            continue;
        }
        observations.push(observation);
    }
    return { observations, omittedItemCount };
}

/**
 * Maps one exact authoritative read.
 *
 * Only this path may conclude absence, and `merged` is emitted only when the
 * same read already carries its immediate successor.
 */
export function mapLedgerAuthoritativeRead(row, localRef, collisionScope) {
    if (row === null) return { kind: 'absent', localRef };
    if (isNonEmptyString(row.merged_into)) {
        const successor = localRefFor(
            { ref: row.merged_into, type: row.type },
            collisionScope,
        );
        if (successor !== null) return { kind: 'merged', localRef, successor };
    }
    const observation = mapLedgerRow(row, collisionScope);
    return observation === null
        ? {
            kind: 'unresolved',
            localRef,
            failure: {
                class: 'unsupportedContract',
                code: 'acme/unmappable-row',
                detail: 'The provider row could not be mapped by this source contract.',
            },
        }
        : observation;
}
