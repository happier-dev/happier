import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageIdentifierV1ProtocolSchema, TriageTextV1ProtocolSchema } from './identity.js';
import { TriageRowFactV1Schema } from './observations.js';

const count = defineProtocolNumber({ integer: true, minimum: 0 });
const nullableCount = defineProtocolUnion([count, defineProtocolLiteral(null)]);
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);

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
        startedAtMs: defineProtocolNumber({ integer: true }).optional(),
        completedAtMs: defineProtocolNumber({ integer: true }).optional(),
    }, { policy: 'closed' })),
    incomplete: boolean,
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
}, { policy: 'closed' });

const merge = defineProtocolObject({
    state: defineProtocolUnion([
        defineProtocolLiteral('mergeable'), defineProtocolLiteral('blocked'),
        defineProtocolLiteral('conflicts'), defineProtocolLiteral('unknown'),
    ]),
    blocker: defineProtocolUnion([TriageTextV1ProtocolSchema, defineProtocolLiteral(null)]),
}, { policy: 'closed' });

const branch = defineProtocolObject({
    head: TriageTextV1ProtocolSchema,
    base: TriageTextV1ProtocolSchema,
    additions: count.optional(),
    deletions: count.optional(),
}, { policy: 'closed' });

/**
 * Optional source-role result for one exact configured PR. It cannot conclude
 * absence; only `get` owns that decision. Unknown or unavailable parts are null,
 * incomplete walks stay explicit, and source-owned row facts use the existing
 * vocabulary. Array/result admission remains the host Action boundary's owner.
 */
export const TriagePullRequestStatusResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('status'),
        observedAtMs: defineProtocolNumber({ integer: true }),
        checks: defineProtocolUnion([checks, defineProtocolLiteral(null)]),
        review: defineProtocolUnion([review, defineProtocolLiteral(null)]),
        merge: defineProtocolUnion([merge, defineProtocolLiteral(null)]),
        branch: defineProtocolUnion([branch, defineProtocolLiteral(null)]),
        facts: defineProtocolArray(TriageRowFactV1Schema),
        projectionTruncated: defineProtocolLiteral(true).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriagePullRequestStatusResultV1 = ReturnType<typeof TriagePullRequestStatusResultV1Schema.parse>;
export type TriagePullRequestStatusV1 = Extract<TriagePullRequestStatusResultV1, { kind: 'status' }>;
