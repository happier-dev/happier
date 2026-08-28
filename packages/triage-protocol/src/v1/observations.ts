import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_ROW_FACTS_V1,
    MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1,
    TRIAGE_ENTRY_PRESENTATION_STATES_V1,
    TRIAGE_ROW_FACT_IMPORTANCES_V1,
    TRIAGE_ROW_FACT_NUMBER_FORMATS_V1,
    TRIAGE_ROW_FACT_STATUS_TONES_V1,
    TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TRIAGE_SOURCE_ATTENTION_LEVELS_V1,
    TRIAGE_VIEWER_INVOLVEMENTS_V1,
} from './bounds.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';
import {
    TriageEntryLocatorV1Schema,
    TriageIdentifierV1ProtocolSchema,
    TriageSourceEntryLocalRefV1Schema,
    TriageTextV1ProtocolSchema,
} from './identity.js';
import { defineTriageSingleLineStringV1 } from './strings.js';
import { TriagePullRequestReviewRevisionV1Schema } from './workspace.js';

const triageRowFactTextV1 = defineTriageSingleLineStringV1(
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
);
const triageProtocolTrue = defineProtocolLiteral(true);
const triageRepositoryPathV1 = defineTriageSingleLineStringV1(
    MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1,
);

/**
 * The six closed V1 row-fact value arms.
 *
 * `detailOnly` means the source knows the fact exists but deliberately loads it
 * only in its detail surface; an omitted fact means genuinely unavailable in
 * the list, and the two render differently (`CONTRACT.md` §4). There is no
 * unknown presentation-value bag: a seventh arm is a V2 change.
 */
export const TriageRowFactValueV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('text'),
        value: triageRowFactTextV1,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('actor'),
        value: triageRowFactTextV1,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('timestamp'),
        atMs: defineProtocolNumber({ integer: true }),
        format: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1[0]),
            defineProtocolLiteral(TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1[1]),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('number'),
        value: defineProtocolNumber(),
        format: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_ROW_FACT_NUMBER_FORMATS_V1[0]),
            defineProtocolLiteral(TRIAGE_ROW_FACT_NUMBER_FORMATS_V1[1]),
        ]),
        /**
         * A provider count measured over a retention or sampling window is not
         * the number of times something happened. Sources that cannot promise
         * an exact total set this rather than presenting a reduced number as a
         * total (`CONTRACT.md` §4).
         */
        approximate: triageProtocolTrue.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('status'),
        value: triageRowFactTextV1,
        tone: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_ROW_FACT_STATUS_TONES_V1[0]),
            defineProtocolLiteral(TRIAGE_ROW_FACT_STATUS_TONES_V1[1]),
            defineProtocolLiteral(TRIAGE_ROW_FACT_STATUS_TONES_V1[2]),
            defineProtocolLiteral(TRIAGE_ROW_FACT_STATUS_TONES_V1[3]),
            defineProtocolLiteral(TRIAGE_ROW_FACT_STATUS_TONES_V1[4]),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('detailOnly'),
    }, { policy: 'closed' }),
]);
export type TriageRowFactValueV1 = ReturnType<typeof TriageRowFactValueV1Schema.parse>;

/**
 * One projected list-row fact. `id` uniqueness within a snapshot is a keyed
 * invariant the target enforces over the parsed value: two facts sharing an id
 * reject the trusted result atomically rather than selecting a winner
 * (`CONTRACT.md` §2.4).
 */
export const TriageRowFactV1Schema = defineProtocolObject({
    // A fact id is a source-local slug beside a list row, so it is bounded as a
    // row-fact string rather than as a provider identifier: the snapshot carries
    // `MAX_TRIAGE_ROW_FACTS_V1` of them and every byte here is multiplied.
    id: triageRowFactTextV1,
    label: triageRowFactTextV1.optional(),
    importance: defineProtocolUnion([
        defineProtocolLiteral(TRIAGE_ROW_FACT_IMPORTANCES_V1[0]),
        defineProtocolLiteral(TRIAGE_ROW_FACT_IMPORTANCES_V1[1]),
        defineProtocolLiteral(TRIAGE_ROW_FACT_IMPORTANCES_V1[2]),
    ]),
    value: TriageRowFactValueV1Schema,
}, { policy: 'closed' });
export type TriageRowFactV1 = ReturnType<typeof TriageRowFactV1Schema.parse>;

/**
 * @internal Relative-only closed presentation state. `unknown` keeps the entry
 * present with its bounded `nativeLabel`; the generic target treatment is
 * nonterminal (`CONTRACT.md` §4).
 */
export const TriageEntryStateV1ProtocolSchema = defineProtocolObject({
    presentation: defineProtocolUnion([
        defineProtocolLiteral(TRIAGE_ENTRY_PRESENTATION_STATES_V1[0]),
        defineProtocolLiteral(TRIAGE_ENTRY_PRESENTATION_STATES_V1[1]),
        defineProtocolLiteral(TRIAGE_ENTRY_PRESENTATION_STATES_V1[2]),
        defineProtocolLiteral(TRIAGE_ENTRY_PRESENTATION_STATES_V1[3]),
        defineProtocolLiteral(TRIAGE_ENTRY_PRESENTATION_STATES_V1[4]),
    ]),
    /** The provider's own word, preserved because the enum is a lossy projection. */
    nativeLabel: TriageTextV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/**
 * The bounded source projection of one provider entity's display content.
 *
 * The outer object is `additive-open/drop` presentation; every known child is
 * closed. `projectionTruncated` is entry-level presentation completeness: it is
 * set when display content was shortened or fact-count bounded, and it never
 * increments scan `omittedItemCount`. Every identity-valid provider entity
 * still maps to a `present` observation (`CONTRACT.md` §2.1, §4).
 */
export const TriageSourceEntrySnapshotV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    title: TriageTextV1ProtocolSchema,
    /**
     * One line of row subtitle, never a body excerpt. Body, description,
     * comment, activity, diff, and complete label/reviewer content belongs to
     * the live detail materialization and never rides a scan or get result.
     */
    summary: TriageTextV1ProtocolSchema.optional(),
    /** Readable owning scope; presentation only, never parsed back into identity. */
    scopeLabel: TriageTextV1ProtocolSchema,
    createdAtMs: defineProtocolNumber({ integer: true }).optional(),
    state: TriageEntryStateV1ProtocolSchema,
    facts: defineProtocolArray(TriageRowFactV1Schema, { maxItems: MAX_TRIAGE_ROW_FACTS_V1 }),
    /**
     * Present only for source rows that are pull/merge requests. This carries
     * the one provider read's base/head/native revision; target stamping adds
     * `observedAtMs` before it can request local preparation.
     */
    reviewRevision: TriagePullRequestReviewRevisionV1Schema.optional(),
    projectionTruncated: triageProtocolTrue.optional(),
}, { policy: 'additive-open/drop' });
export type TriageSourceEntrySnapshotV1 = ReturnType<
    typeof TriageSourceEntrySnapshotV1Schema.parse
>;

/**
 * Presentation and attention evidence for the exact configured account. It
 * carries no cached mutation authority: every named source mutation
 * rematerializes the account and reauthorizes at execution time
 * (`CONTRACT.md` §4).
 *
 * `sourceAttention` is an input fact, not a shared displayed-attention owner.
 * Modelling "no meaningful candidate" as its own arm keeps a reason-free
 * declaration from becoming a zero-score display winner.
 */
export const TriageSourceViewerFactsV1Schema = defineProtocolObject({
    involvement: defineProtocolUniqueArray(defineProtocolUnion([
        defineProtocolLiteral(TRIAGE_VIEWER_INVOLVEMENTS_V1[0]),
        defineProtocolLiteral(TRIAGE_VIEWER_INVOLVEMENTS_V1[1]),
        defineProtocolLiteral(TRIAGE_VIEWER_INVOLVEMENTS_V1[2]),
        defineProtocolLiteral(TRIAGE_VIEWER_INVOLVEMENTS_V1[3]),
        defineProtocolLiteral(TRIAGE_VIEWER_INVOLVEMENTS_V1[4]),
        defineProtocolLiteral(TRIAGE_VIEWER_INVOLVEMENTS_V1[5]),
    ]), { maxItems: TRIAGE_VIEWER_INVOLVEMENTS_V1.length }),
    sourceAttention: defineProtocolUnion([
        defineProtocolObject({
            level: defineProtocolLiteral('none'),
        }, { policy: 'closed' }),
        defineProtocolObject({
            level: defineProtocolUnion([
                defineProtocolLiteral(TRIAGE_SOURCE_ATTENTION_LEVELS_V1[0]),
                defineProtocolLiteral(TRIAGE_SOURCE_ATTENTION_LEVELS_V1[1]),
            ]),
            reasonId: TriageIdentifierV1ProtocolSchema,
            reasonLabel: TriageTextV1ProtocolSchema,
        }, { policy: 'closed' }),
    ]).optional(),
}, { policy: 'closed' });
export type TriageSourceViewerFactsV1 = ReturnType<
    typeof TriageSourceViewerFactsV1Schema.parse
>;

/**
 * The forge repository one entry belongs to, spelled exactly as the SCM working
 * snapshot already resolves it.
 *
 * This is the ONE fact that makes launch placement answerable without inventing
 * an index. A project's working snapshot
 * (`packages/protocol/src/scm/workingSnapshot.ts`) already carries a RESOLVED
 * `hostingProvider` ref. The canonical SCM identity owner turns its provider
 * kind, base URL, and provider-owned repository name into the same three values
 * every forge source publishes here, including provider-specific casing. The
 * aggregate then joins the already-normalized records by exact equality.
 *
 * It is deliberately NOT a URL, a clone address, a remote name, or a repository
 * id. Matching a Triage entry to a checkout by normalizing remote URLs across
 * machines was the withdrawn design: it makes every source re-implement a URL
 * grammar, and it is wrong the moment two machines spell one remote differently.
 * Declaring the resolved identity is smaller and exact.
 *
 * It is optional because most sources have no forge repository at all — a Sentry
 * issue and a PostHog error belong to a project, not to a checkout. An entry
 * without one resolves no launch candidate, which is the honest answer rather
 * than a guessed directory.
 */
export const TriageEntryRepositoryRefV1Schema = defineProtocolObject({
    /** The SCM hosting kind whose canonicalizer produced this identity. */
    kind: defineProtocolUnion([
        defineProtocolLiteral('github'),
        defineProtocolLiteral('gitlab'),
        defineProtocolLiteral('bitbucket'),
        defineProtocolLiteral('azure-devops'),
    ]),
    /**
     * The forge DEPLOYMENT this repository lives on, spelled as the source's own
     * configured-origin owner already canonicalizes it: scheme and host
     * lowercased, default port dropped, base path preserved verbatim and without
     * a trailing slash. It is the same string
     * `readScmHostingRepositoryIdentity` derives from a resolved
     * `ScmHostingProviderRef.baseUrl`
     * (`packages/protocol/src/scm/hostingRepositoryIdentity.ts`).
     *
     * It is REQUIRED because one provider kind covers many deployments. For
     * Azure DevOps the organization lives in the base path, so `api/web` on two
     * organizations is two repositories. Without this component the join matches a repository to a
     * checkout of a DIFFERENT repository and puts an agent to work in it.
     *
     * The base path remains case-significant while URL host canonicalization is
     * owned by `normalizeScmHostingRepositoryIdentity`; downstream comparison
     * is exact.
     */
    deployment: TriageIdentifierV1ProtocolSchema,
    /** The provider-canonical repository identity. */
    repository: triageRepositoryPathV1,
}, { policy: 'closed' });
export type TriageEntryRepositoryRefV1 = ReturnType<
    typeof TriageEntryRepositoryRefV1Schema.parse
>;

/** @internal Relative-only fields of one authoritative present observation. */
export const TriageSourcePresentObservationV1Fields = {
    kind: defineProtocolLiteral('present'),
    localRef: TriageSourceEntryLocalRefV1Schema,
    locator: TriageEntryLocatorV1Schema,
    snapshot: TriageSourceEntrySnapshotV1Schema,
    viewer: TriageSourceViewerFactsV1Schema,
    /** The provider's clock. Display and presentation ordinal only; it decides nothing. */
    sourceUpdatedAtMs: defineProtocolNumber({ integer: true }).optional(),
    nativeRevision: TriageIdentifierV1ProtocolSchema.optional(),
    /**
     * The forge repository this entry belongs to, when it belongs to one. It is
     * the left half of the launch-placement join
     * (`packages/plugins/triage/src/sessions/launchPlacement.ts`); absent means
     * this source has no checkout to name, never that placement failed.
     */
    repository: TriageEntryRepositoryRefV1Schema.optional(),
} as const;

/** @internal Relative-only present arm shared by scan and authoritative get. */
export const TriageSourcePresentObservationV1ProtocolSchema = defineProtocolObject(
    TriageSourcePresentObservationV1Fields,
    { policy: 'closed' },
);

/** @internal Relative-only merged arm; its envelope is exactly kind/ref/successor. */
export const TriageSourceMergedObservationV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('merged'),
    localRef: TriageSourceEntryLocalRefV1Schema,
    successor: TriageSourceEntryLocalRefV1Schema,
}, { policy: 'closed' });

/** @internal Relative-only unresolved arm: no authoritative presence conclusion. */
export const TriageSourceUnresolvedObservationV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('unresolved'),
    localRef: TriageSourceEntryLocalRefV1Schema,
    failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/**
 * The complete four-arm authoritative observation union.
 *
 * `absent` is serialized exactly as `{ kind, localRef }`: a source may need
 * provider-specific corroboration before reaching that conclusion, but that is
 * an internal precondition, never a public second absence authority. `merged`
 * is emitted only when the same authoritative invocation has immediate
 * evidence for the direct successor; otherwise the result is `unresolved`
 * (`CONTRACT.md` §4).
 */
export const TriageSourceObservationV1Schema = defineProtocolUnion([
    TriageSourcePresentObservationV1ProtocolSchema,
    defineProtocolObject({
        kind: defineProtocolLiteral('absent'),
        localRef: TriageSourceEntryLocalRefV1Schema,
    }, { policy: 'closed' }),
    TriageSourceMergedObservationV1ProtocolSchema,
    TriageSourceUnresolvedObservationV1ProtocolSchema,
]);
export type TriageSourceObservationV1 = ReturnType<typeof TriageSourceObservationV1Schema.parse>;

/**
 * The scan-safe observation union. `scan` has no absent arm: a finished walk is
 * health evidence, never set-complement evidence (`CONTRACT.md` §4).
 */
export const TriageSourceScanObservationV1Schema = defineProtocolUnion([
    TriageSourcePresentObservationV1ProtocolSchema,
    TriageSourceMergedObservationV1ProtocolSchema,
    TriageSourceUnresolvedObservationV1ProtocolSchema,
]);
export type TriageSourceScanObservationV1 = ReturnType<
    typeof TriageSourceScanObservationV1Schema.parse
>;

/**
 * The source-private in-memory scan continuation. It binds the initial limit
 * and any provider-native page geometry, exists only for one scan invocation,
 * and is never persisted or promoted to another cursor type
 * (`CONTRACT.md` §5.1).
 */
export const TriageScanContinuationV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    token: defineProtocolUtf8String({
        minLength: 1,
        maxUtf8Bytes: MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
        pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    }),
}, { policy: 'closed' });
export type TriageScanContinuationV1 = ReturnType<typeof TriageScanContinuationV1Schema.parse>;

/**
 * Scan health evidence is exactly `walkFinished`, `partial`, or `moving`.
 * `omittedItemCount` is available only on `partial`, and counts provider rows
 * the source omitted while tolerantly decoding — never entry-level projection
 * truncation (`CONTRACT.md` §3.2).
 */
export const TriageSourceScanEvidenceV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('walkFinished'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('partial'),
        reason: TriageIdentifierV1ProtocolSchema,
        omittedItemCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('moving'),
        reason: TriageIdentifierV1ProtocolSchema,
    }, { policy: 'closed' }),
]);
export type TriageSourceScanEvidenceV1 = ReturnType<
    typeof TriageSourceScanEvidenceV1Schema.parse
>;

/** @internal Relative-only bounded page of scan observations. */
export const TriageScanObservationsV1ProtocolSchema = defineProtocolArray(
    TriageSourceScanObservationV1Schema,
);
