import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolJsonValue,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageIdentifierV1ProtocolSchema, TriageLocationV1ProtocolSchema, TriageTextV1ProtocolSchema } from './identity.js';
import { TriageRowFactV1Schema } from './observations.js';

const count = defineProtocolNumber({ integer: true, minimum: 0 });
const nullableCount = defineProtocolUnion([count, defineProtocolLiteral(null)]);
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const nullableBoolean = defineProtocolUnion([boolean, defineProtocolLiteral(null)]);
const nullableText = defineProtocolUnion([TriageTextV1ProtocolSchema, defineProtocolLiteral(null)]);

export const TRIAGE_PULL_REQUEST_MERGE_METHODS_V1 = Object.freeze(['merge', 'squash', 'rebase'] as const);

/** Source observation and successful-check clocks use the same admitted timestamp grammar. */
export const TriagePullRequestStatusCheckTimeV1Schema = defineProtocolNumber({ integer: true });

/** Named requirements acknowledged by the original source Action, not check outcomes. */
export const TriagePullRequestRequirementRefV1Schema = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('check'), defineProtocolLiteral('review'),
        defineProtocolLiteral('queue'), defineProtocolLiteral('policy'),
    ]),
    id: TriageIdentifierV1ProtocolSchema,
    label: TriageTextV1ProtocolSchema,
}, { policy: 'closed' });
export type TriagePullRequestRequirementRefV1 = ReturnType<typeof TriagePullRequestRequirementRefV1Schema.parse>;

/** Original Action operands are projected and validated by the admitting source. */
export const TriagePullRequestOperationOfferV1Schema = defineProtocolObject({
    id: TriageIdentifierV1ProtocolSchema,
    title: TriageTextV1ProtocolSchema,
    titleKey: TriageTextV1ProtocolSchema.optional(),
    disabledReason: nullableText,
    disabledReasonKey: TriageTextV1ProtocolSchema.optional(),
    actionRef: PluginContributionIdentityV1Schema,
    variants: defineProtocolArray(defineProtocolObject({
        id: TriageIdentifierV1ProtocolSchema,
        method: defineProtocolObject({
            title: TriageTextV1ProtocolSchema,
            titleKey: TriageTextV1ProtocolSchema.optional(),
        }, { policy: 'closed' }).optional(),
        input: defineProtocolJsonValue(),
    }, { policy: 'closed' })),
}, { policy: 'closed' });
export type TriagePullRequestOperationOfferV1 = ReturnType<typeof TriagePullRequestOperationOfferV1Schema.parse>;

/** One source-owned decision shared by source detail and portable PR cards. */
export const TriagePullRequestOperationsV1Schema = defineProtocolObject({
    readiness: defineProtocolUnion([
        defineProtocolLiteral('ready'), defineProtocolLiteral('blocked'), defineProtocolLiteral('unknown'),
    ]),
    unmetRequirements: defineProtocolArray(TriagePullRequestRequirementRefV1Schema),
    primary: TriagePullRequestOperationOfferV1Schema,
    alternatives: defineProtocolArray(TriagePullRequestOperationOfferV1Schema),
}, { policy: 'closed' });
export type TriagePullRequestOperationsV1 = ReturnType<typeof TriagePullRequestOperationsV1Schema.parse>;

/** Live PR detail, never a scan-time fanout or a second entry/presence authority. */
const checks = defineProtocolObject({
    state: defineProtocolUnion([
        defineProtocolLiteral('none'), defineProtocolLiteral('unknown'),
        defineProtocolLiteral('incomplete'), defineProtocolLiteral('complete'),
    ]),
    // Null means the provider did not establish a complete count, not zero.
    passed: nullableCount,
    failed: nullableCount,
    pending: nullableCount,
    total: nullableCount,
    rows: defineProtocolArray(defineProtocolObject({
        id: TriageIdentifierV1ProtocolSchema,
        name: TriageTextV1ProtocolSchema,
        state: defineProtocolUnion([
            defineProtocolLiteral('passed'), defineProtocolLiteral('failed'),
            defineProtocolLiteral('pending'), defineProtocolLiteral('neutral'),
            defineProtocolLiteral('unknown'),
        ]),
        // Only provider evidence establishes requiredness; missing/null is unknown.
        required: nullableBoolean.optional(),
        /** Native check or job destination, omitted when the provider did not establish one. */
        detailsUrl: TriageLocationV1ProtocolSchema.optional(),
        startedAtMs: defineProtocolNumber({ integer: true }).optional(),
        completedAtMs: defineProtocolNumber({ integer: true }).optional(),
    }, { policy: 'closed' })),
    incomplete: boolean,
    /** A partial provider read keeps its actual failure beside retained facts. */
    failure: TriageSourceFailureV1Schema.optional(),
}, { policy: 'closed' });

const review = defineProtocolObject({
    decision: defineProtocolUnion([
        defineProtocolLiteral('approved'), defineProtocolLiteral('changesRequested'),
        defineProtocolLiteral('reviewRequired'), defineProtocolLiteral(null),
    ]),
    reviewers: defineProtocolArray(defineProtocolObject({
        // Source-native user/team key, independent of display name and order.
        id: TriageIdentifierV1ProtocolSchema,
        name: TriageTextV1ProtocolSchema,
        verb: defineProtocolUnion([
            defineProtocolLiteral('approved'), defineProtocolLiteral('changesRequested'),
            defineProtocolLiteral('commented'), defineProtocolLiteral('dismissed'),
            defineProtocolLiteral('pending'),
        ]),
    }, { policy: 'closed' })),
    incomplete: boolean,
    /** Body-free provider thread resolution; missing or incomplete is not resolved. */
    threads: defineProtocolObject({
        rows: defineProtocolArray(defineProtocolObject({
            id: TriageIdentifierV1ProtocolSchema,
            isResolved: boolean,
        }, { policy: 'closed' })),
        incomplete: boolean,
        failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });

const merge = defineProtocolObject({
    state: defineProtocolUnion([
        defineProtocolLiteral('mergeable'), defineProtocolLiteral('blocked'),
        defineProtocolLiteral('conflicts'), defineProtocolLiteral('unknown'),
    ]),
    blocker: defineProtocolUnion([TriageTextV1ProtocolSchema, defineProtocolLiteral(null)]),
    draft: nullableBoolean.optional(),
    /** Independent native conflict fact; draft/blocked alone cannot establish false. */
    conflicts: nullableBoolean.optional(),
    nativeState: nullableText.optional(),
    queueRequired: nullableBoolean.optional(),
    // Missing is unavailable evidence; null is an observed absence of membership.
    queue: defineProtocolUnion([
        defineProtocolObject({
            id: TriageIdentifierV1ProtocolSchema,
            state: nullableText,
            position: nullableCount,
            estimatedTimeToMergeSeconds: nullableCount.optional(),
        }, { policy: 'closed' }),
        defineProtocolLiteral(null),
    ]).optional(),
    autoMerge: defineProtocolUnion([
        defineProtocolObject({
            enabled: nullableBoolean,
            method: defineProtocolUnion([
                defineProtocolLiteral(TRIAGE_PULL_REQUEST_MERGE_METHODS_V1[0]),
                defineProtocolLiteral(TRIAGE_PULL_REQUEST_MERGE_METHODS_V1[1]),
                ...TRIAGE_PULL_REQUEST_MERGE_METHODS_V1.slice(2).map(method => defineProtocolLiteral(method)),
                defineProtocolLiteral(null),
            ]),
        }, { policy: 'closed' }),
        defineProtocolLiteral(null),
    ]).optional(),
    // Native viewer capability; it never promotes a blocked PR to Ready.
    canMergeWithoutWaiting: nullableBoolean.optional(),
    nodeId: defineProtocolUnion([TriageIdentifierV1ProtocolSchema, defineProtocolLiteral(null)]).optional(),
    viewerCanUpdate: nullableBoolean.optional(),
    viewerCanEnableAutoMerge: nullableBoolean.optional(),
    viewerCanDisableAutoMerge: nullableBoolean.optional(),
    branchRules: defineProtocolObject({
        state: defineProtocolUnion([
            defineProtocolLiteral('complete'), defineProtocolLiteral('incomplete'),
            defineProtocolLiteral('unknown'),
        ]),
        rows: defineProtocolArray(defineProtocolObject({
            type: TriageTextV1ProtocolSchema,
            reviewThreadResolutionRequired: nullableBoolean.optional(),
            rulesetId: TriageIdentifierV1ProtocolSchema.optional(),
            sourceUrl: TriageLocationV1ProtocolSchema.optional(),
        }, { policy: 'closed' })),
        failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }).optional(),
    upToDateRequired: nullableBoolean.optional(),
}, { policy: 'closed' });

const branch = defineProtocolObject({
    /** Display names may be unavailable independently of the observed commit. */
    head: TriageTextV1ProtocolSchema.optional(),
    base: TriageTextV1ProtocolSchema.optional(),
    headRevision: TriageIdentifierV1ProtocolSchema.optional(),
    additions: count.optional(),
    deletions: count.optional(),
}, { policy: 'closed' });

/**
 * Optional source-role result for one exact configured PR. It cannot conclude
 * absence; only `get` owns that decision. Unknown or unavailable parts are null,
 * incomplete walks stay explicit, and source-owned row facts use the existing
 * vocabulary. Array/result admission remains the host Action boundary's owner.
 */
export const TriagePullRequestStatusV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('status'),
    observedAtMs: TriagePullRequestStatusCheckTimeV1Schema,
    /** Source-derived next read delay; omission requests no automatic refresh. */
    refreshAfterMs: count.optional(),
    /** Copied from the exact native PR read; omission means the title was not established. */
    title: TriageTextV1ProtocolSchema.optional(),
    /** Native PR destination from the same admitted read, never reconstructed from its identity. */
    sourceUrl: TriageLocationV1ProtocolSchema.optional(),
    operations: TriagePullRequestOperationsV1Schema.optional(),
    checks: defineProtocolUnion([checks, defineProtocolLiteral(null)]),
    review: defineProtocolUnion([review, defineProtocolLiteral(null)]),
    merge: defineProtocolUnion([merge, defineProtocolLiteral(null)]),
    branch: defineProtocolUnion([branch, defineProtocolLiteral(null)]),
    facts: defineProtocolArray(TriageRowFactV1Schema),
    projectionTruncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const TriagePullRequestStatusResultV1Schema = defineProtocolUnion([
    TriagePullRequestStatusV1Schema,
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriagePullRequestStatusResultV1 = ReturnType<typeof TriagePullRequestStatusResultV1Schema.parse>;
export type TriagePullRequestStatusV1 = Extract<TriagePullRequestStatusResultV1, { kind: 'status' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasRowId(value: unknown): value is Record<string, unknown> & { id: string } {
    return isRecord(value) && typeof value.id === 'string';
}

/** Structural sharing of admitted domain values; this is not another parser. */
function reconcileStatusValue(previous: unknown, next: unknown, observationRoot = false): unknown {
    if (previous === next) return previous;
    if (Array.isArray(previous) && Array.isArray(next)) {
        const previousRows: readonly unknown[] = previous;
        const nextRows: readonly unknown[] = next;
        const keyed = previousRows.every(hasRowId) && nextRows.every(hasRowId);
        const previousById = new Map<string, unknown>();
        if (keyed) {
            for (const row of previousRows) {
                if (hasRowId(row)) previousById.set(row.id, row);
            }
        }
        let rows: unknown[] | undefined;
        for (let index = 0; index < nextRows.length; index += 1) {
            const incoming = nextRows[index];
            const baseline = keyed && hasRowId(incoming)
                ? previousById.get(incoming.id)
                : previousRows[index];
            const row = reconcileStatusValue(baseline, incoming);
            if (!rows && row !== previousRows[index]) rows = previousRows.slice(0, index);
            rows?.push(row);
        }
        if (rows) return rows;
        return previousRows.length === nextRows.length ? previous : previousRows.slice(0, nextRows.length);
    }
    if (!isRecord(previous) || !isRecord(next)) return next;
    const nextKeys = Object.keys(next);
    let equal = Object.keys(previous).length === nextKeys.length;
    let value: Record<string, unknown> | undefined;
    for (const key of nextKeys) {
        // Only the enclosing successful observation clock is non-semantic.
        // Domain timestamps, failure provenance and currentness remain real facts.
        if (observationRoot && key === 'observedAtMs') continue;
        const child = reconcileStatusValue(previous[key], next[key]);
        if (!Object.hasOwn(previous, key) || child !== previous[key]) equal = false;
        if (child !== next[key]) {
            value ??= { ...next };
            value[key] = child;
        }
    }
    return equal ? previous : value ?? next;
}

/**
 * Reconcile successful admitted status at its retained producer. The caller
 * supplies a baseline only for the same authorized exact PR/head lifetime.
 * Equal facts retain their original observation carrier; checkedAtMs always
 * reports the newly admitted successful observation separately.
 */
export function reconcileTriagePullRequestStatusV1(
    previous: TriagePullRequestStatusV1 | null,
    next: TriagePullRequestStatusV1,
): { value: TriagePullRequestStatusV1; checkedAtMs: number } {
    return {
        // Sharing only substitutes equal admitted subtrees and preserves the schema.
        value: previous === null ? next : reconcileStatusValue(previous, next, true) as TriagePullRequestStatusV1,
        checkedAtMs: next.observedAtMs,
    };
}
