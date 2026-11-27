import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { TriageGetResultV1, TriageScanResultV1 } from './operations.js';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    defineProtocolUtf8String,
    TriageEntryRefV1Fields,
    TriageEntryRefV1Schema,
    TriageIdentifierV1ProtocolSchema,
    TriageCollisionScopeV1ProtocolSchema,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { ScmHostingProviderKindProtocolSchema, type ProtocolScmHostingProviderKind } from '@happier-dev/plugin-sdk/scm';

import {
    MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1,
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    TRIAGE_ENTRY_PRESENTATION_STATES_V1,
    TRIAGE_ROW_FACT_IMPORTANCES_V1,
    TRIAGE_ROW_FACT_NUMBER_FORMATS_V1,
    TRIAGE_ROW_FACT_STATUS_TONES_V1,
    TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TRIAGE_SOURCE_ATTENTION_LEVELS_V1,
    TRIAGE_VIEWER_INVOLVEMENTS_V1,
} from './constants.js';
import { defineTriageStringUnionV1, defineTriageSingleLineStringV1 } from './strings.js';
import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1, TRIAGE_SOURCE_FAILURE_CLASSES_V1 } from './constants.js';

export type TriageEntryRepositoryRefV1 = Readonly<{
    kind: ProtocolScmHostingProviderKind;
    deployment: string;
    repository: string;
}>;

/** A field-sort frontier retains a native page, rather than one scalar cursor.
 * Allocate its share by the existing scan row geometry; the aggregate envelope
 * allocator solves the resulting byte budget alongside every row and lane.
 */
export function triagePagingTokenUtf8BytesForFieldBytesV1(fieldBytes: number): number {
    return fieldBytes * MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
}

/** Pure construction shared by source schemas and the aggregate allocation. */
export function createTriageListSourceSchemasV1(fieldBytes: number) {
    const TriageTextV1ProtocolSchema = defineTriageSingleLineStringV1(fieldBytes);
    const TriageLocationV1ProtocolSchema = defineTriageSingleLineStringV1(fieldBytes);
    const TriageSourceEntryLocalRefV1Schema = defineProtocolObject({
        kindId: TriageIdentifierV1ProtocolSchema,
        collisionScope: TriageCollisionScopeV1ProtocolSchema,
        entryId: TriageIdentifierV1ProtocolSchema,
    }, { policy: 'closed' });

    const TriageSourceScopeUnitIdV1Schema = defineTriageSingleLineStringV1(
        MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
    );

    const TriageEntryLocatorV1Schema = defineProtocolObject({
        v: defineProtocolLiteral(1),
        webUrl: TriageLocationV1ProtocolSchema.optional(),
        displayPath: TriageTextV1ProtocolSchema.optional(),
        routingToken: defineTriageSingleLineStringV1(
            fieldBytes,
        ).optional(),
    }, { policy: 'closed' });

    const TriageSourceFailureClassV1ProtocolSchema = defineTriageStringUnionV1(TRIAGE_SOURCE_FAILURE_CLASSES_V1);


    const TriageSourceFailureV1Schema = defineProtocolObject({
        class: TriageSourceFailureClassV1ProtocolSchema,
        code: TriageIdentifierV1ProtocolSchema,
        /** Originating host-issued Action request identity, diagnostic only. */
        requestId: TriageIdentifierV1ProtocolSchema.optional(),
        detail: defineTriageSingleLineStringV1(fieldBytes).optional(),
        /** Provider-reported permission requirement, diagnostic only, never admission authority. */
        requiredPermissions: defineTriageSingleLineStringV1(fieldBytes).optional(),
        retryNotBeforeMs: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    }, { policy: 'closed' });

    const TriageListInvocationErrorV1Schema = defineProtocolObject({
        code: TriageIdentifierV1ProtocolSchema,
        retryable: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional(),
        requestId: TriageIdentifierV1ProtocolSchema.optional(),
    }, { policy: 'closed' });

    const triagePullRequestReviewRevisionFieldsV1 = {
        baseSha: TriageIdentifierV1ProtocolSchema,
        headSha: TriageIdentifierV1ProtocolSchema,
        nativeRevision: TriageIdentifierV1ProtocolSchema,
    } as const;

    const TriagePullRequestReviewRevisionV1Schema = defineProtocolObject(
        triagePullRequestReviewRevisionFieldsV1,
        { policy: 'closed' },
    );

    const triageRowFactTextV1 = defineTriageSingleLineStringV1(
        fieldBytes,
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
    const TriageRowFactValueV1Schema = defineProtocolUnion([
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
            format: defineTriageStringUnionV1(TRIAGE_ROW_FACT_TIMESTAMP_FORMATS_V1),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('number'),
            value: defineProtocolNumber(),
            format: defineTriageStringUnionV1(TRIAGE_ROW_FACT_NUMBER_FORMATS_V1),
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
            tone: defineTriageStringUnionV1(TRIAGE_ROW_FACT_STATUS_TONES_V1),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('detailOnly'),
        }, { policy: 'closed' }),
    ]);

    /**
     * One projected list-row fact. `id` uniqueness within a snapshot is a keyed
     * invariant the target enforces over the parsed value: two facts sharing an id
     * reject the trusted result atomically rather than selecting a winner
     * (`CONTRACT.md` §2.4).
     */
    const TriageRowFactV1Schema = defineProtocolObject({
        // A fact id is a source-local slug beside a list row, so it is bounded as a
        // row-fact string rather than as a provider identifier.
        id: triageRowFactTextV1,
        label: triageRowFactTextV1.optional(),
        importance: defineTriageStringUnionV1(TRIAGE_ROW_FACT_IMPORTANCES_V1),
        value: TriageRowFactValueV1Schema,
    }, { policy: 'closed' });

    /**
     * @internal Relative-only closed presentation state. `unknown` keeps the entry
     * present with its bounded `nativeLabel`; the generic target treatment is
     * nonterminal (`CONTRACT.md` §4).
     */
    const TriageEntryStateV1ProtocolSchema = defineProtocolObject({
        presentation: defineTriageStringUnionV1(TRIAGE_ENTRY_PRESENTATION_STATES_V1),
        /** The provider's own word, preserved because the enum is a lossy projection. */
        nativeLabel: TriageTextV1ProtocolSchema.optional(),
        stage: defineProtocolUnion([
            defineProtocolLiteral('backlog'), defineProtocolLiteral('unstarted'), defineProtocolLiteral('started'),
        ]).optional(),
        completionReason: defineProtocolUnion([
            defineProtocolLiteral('completed'), defineProtocolLiteral('canceled'),
        ]).optional(),
    }, { policy: 'closed' });
    // Derive the public type through the public snapshot. The schema above is
    // stripped from declaration output and must not leak into this alias.

    /** The only mixed-task category projection; unknown/suppressed is not invented work state. */
    /** Closed declaration vocabulary; providers authorize the actual edit at execution. */
    const TriageTaskFieldV1Schema = defineProtocolUnion([
        defineProtocolLiteral('title'), defineProtocolLiteral('body'),
        defineProtocolLiteral('assigneeIds'), defineProtocolLiteral('labelIds'),
        defineProtocolLiteral('scopeId'), defineProtocolLiteral('projectId'),
        defineProtocolLiteral('priority'), defineProtocolLiteral('dueDate'),
        defineProtocolLiteral('estimate'), defineProtocolLiteral('parent'), defineProtocolLiteral('blockedBy'),
    ]);

    const transitionFieldAddress = { id: TriageIdentifierV1ProtocolSchema, label: TriageTextV1ProtocolSchema };
    const transitionFieldOption = defineProtocolObject(transitionFieldAddress, { policy: 'closed' });
    /** Native input requirements, never a provider JSON payload or cached write authority. */
    const TriageTaskTransitionRequiredFieldV1Schema = defineProtocolUnion([
        defineProtocolObject({ ...transitionFieldAddress, kind: defineProtocolLiteral('text') }, { policy: 'closed' }),
        defineProtocolObject({ ...transitionFieldAddress, kind: defineProtocolLiteral('number') }, { policy: 'closed' }),
        defineProtocolObject({ ...transitionFieldAddress, kind: defineProtocolLiteral('choice'),
            options: defineProtocolArray(transitionFieldOption) }, { policy: 'closed' }),
        defineProtocolObject({ ...transitionFieldAddress, kind: defineProtocolLiteral('choices'),
            options: defineProtocolArray(transitionFieldOption) }, { policy: 'closed' }),
        // Retain the native transition when its input cannot be represented. The
        // source can explain/refuse it and the client can offer Open in source.
        defineProtocolObject({ ...transitionFieldAddress, kind: defineProtocolLiteral('unsupported') }, { policy: 'closed' }),
    ]);

    const TriageTaskTransitionV1Schema = defineProtocolObject({
        id: TriageIdentifierV1ProtocolSchema,
        label: TriageTextV1ProtocolSchema,
        state: TriageEntryStateV1ProtocolSchema,
        requiredFields: defineProtocolArray(TriageTaskTransitionRequiredFieldV1Schema).optional(),
    }, { policy: 'closed' });
    const TriageTaskCapabilitiesV1Schema = defineProtocolObject({
        /** The scan role honours completion windows for this task kind. Omission means unknown coverage. */
        completedScan: defineProtocolLiteral(true).optional(),
        createFields: defineProtocolUniqueArray(TriageTaskFieldV1Schema).optional(),
        /** States accepted at creation, not transitions from an existing task. Omission means unsupported. */
        initialStatuses: defineProtocolArray(defineProtocolObject({
            ...transitionFieldAddress, state: TriageEntryStateV1ProtocolSchema,
            /** This source uses this status when create omits initialStatusId; absent means unknown. */
            isDefault: triageProtocolTrue.optional(),
        }, { policy: 'closed' })).optional(),
        editFields: defineProtocolUniqueArray(TriageTaskFieldV1Schema).optional(),
        /** The source can answer `includeTaskFieldChoices` on an exact read: name-valued fields pick from its directory. */
        fieldChoices: defineProtocolLiteral(true).optional(),
        transitions: defineProtocolArray(TriageTaskTransitionV1Schema).optional(),
        /** Explicit source opt-in to one-step completion. A completed state alone never implies this; absent means use the workflow menu. */
        completingTransitionId: TriageIdentifierV1ProtocolSchema.optional(),
    }, { policy: 'closed' });

    /** Live read facts, not a second relationship store. Omitted facts remain unknown. */
    const TriageEntryRelationsV1Schema = defineProtocolObject({
        parent: TriageEntryRefV1Schema.optional(),
        children: defineProtocolObject({
            total: defineProtocolNumber({ integer: true, minimum: 0 }),
            completed: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
            entries: defineProtocolArray(defineProtocolObject({
                ...TriageEntryRefV1Fields,
                /** Presentation from the same relation read; identity remains the canonical ref. */
                title: TriageTextV1ProtocolSchema.optional(),
                locator: TriageEntryLocatorV1Schema.optional(),
            }, { policy: 'closed' })).optional(),
            complete: defineProtocolLiteral(true).optional(),
        }, { policy: 'closed' }).optional(),
        blockedBy: defineProtocolArray(TriageEntryRefV1Schema).optional(),
    }, { policy: 'closed' });

    /**
     * The bounded source projection of one provider entity's display content.
     *
     * The outer object is `additive-open/drop` presentation; every known child is
     * closed. `projectionTruncated` is entry-level presentation completeness: it is
     * set when display content was shortened or an optional locator omitted, and it never
     * increments scan `omittedItemCount`. Every identity-valid provider entity
     * still maps to a `present` observation (`CONTRACT.md` §2.1, §4).
     */
    const TriageSourceEntrySnapshotV1Schema = defineProtocolObject({
        v: defineProtocolLiteral(1),
        title: TriageTextV1ProtocolSchema,
        /**
         * One line of row subtitle, never a body excerpt. Body, description,
         * comment, activity, diff, and complete label/reviewer content belongs to
         * the live detail materialization and never rides this snapshot. Exact get
         * may separately supply complete taskFields for an explicit edit.
         */
        summary: TriageTextV1ProtocolSchema.optional(),
        /** Readable owning scope; presentation only, never parsed back into identity. */
        scopeLabel: TriageTextV1ProtocolSchema,
        /** Source-authored short scope name for compact rows; the full path stays in scopeLabel. */
        scopeDisplayName: TriageTextV1ProtocolSchema.optional(),
        /**
         * Source-native unit id for selection/filter joins (team, project, repository,
         * environment). Independent of immutable entry collision identity; sources
         * with deployment-wide entry ids must not rekey them to supply this fact.
         */
        scopeUnitId: TriageSourceScopeUnitIdV1Schema.optional(),
        /**
         * Who opened the entry, as the provider names them ("Mara Oduya", a login).
         * Presentation only: never an identity, a viewer match or a filter key. A
         * source with no author for an entry kind (an error group) omits it.
         */
        authorLabel: TriageTextV1ProtocolSchema.optional(),
        /** Source-owned assignment display only. Null is unassigned; omission is unknown. */
        assigneeLabel: defineProtocolUnion([TriageTextV1ProtocolSchema, defineProtocolLiteral(null)]).optional(),
        /** Source label names retain their string-array shape; colours are additive. */
        labels: defineProtocolArray(defineProtocolString()).optional(),
        /** Exact source label names plus theme token names, never resolved colour values. */
        labelColors: defineProtocolArray(defineProtocolObject({
            name: defineProtocolString(),
            colorToken: TriageIdentifierV1ProtocolSchema,
        }, { policy: 'closed' })).optional(),
        /**
         * The entry's short native designation as the provider writes it ("#2481",
         * "!88", "CHECKOUT-WEB-4F2"). Presentation only: never parsed back into
         * identity or routing. A kind with no designation omits it.
         */
        designation: TriageTextV1ProtocolSchema.optional(),
        createdAtMs: defineProtocolNumber({ integer: true }).optional(),
        /** ISO date or datetime, preserving a provider's calendar date rather than inventing a timezone. */
        dueDate: TriageTextV1ProtocolSchema.optional(),
        /** Authoritative completion time, never the entry's general updated time. Absence is unknown. */
        completedAtMs: defineProtocolNumber({ integer: true }).optional(),
        state: TriageEntryStateV1ProtocolSchema,
        relations: TriageEntryRelationsV1Schema.optional(),
        /** Entry-specific workflows may refine the kind's capability declaration. */
        taskCapabilities: TriageTaskCapabilitiesV1Schema.optional(),
        facts: defineProtocolArray(TriageRowFactV1Schema),
        /**
         * Present only for source rows that are pull/merge requests. This carries
         * the one provider read's base/head/native revision; target stamping adds
         * `observedAtMs` before it can request local preparation.
         */
        reviewRevision: TriagePullRequestReviewRevisionV1Schema.optional(),
        /** Source PR id for preview lookup, scoped by the enclosing observation's repository. */
        previewKey: TriageIdentifierV1ProtocolSchema.optional(),
        /**
         * A pull/merge request's branch names as the provider writes them: the branch it
         * merges from (`head`) and into (`base`). Presentation only, never a checkout or
         * revision fact (`reviewRevision` owns those). Omitted when either is unknown,
         * including on list rows whose provider read does not carry them.
         */
        branches: defineProtocolObject({
            head: TriageTextV1ProtocolSchema,
            base: TriageTextV1ProtocolSchema,
        }, { policy: 'closed' }).optional(),
        projectionTruncated: triageProtocolTrue.optional(),
    }, { policy: 'additive-open/drop' });

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
    const TriageSourceViewerFactsV1Schema = defineProtocolObject({
        involvement: defineProtocolUniqueArray(defineTriageStringUnionV1(TRIAGE_VIEWER_INVOLVEMENTS_V1), { maxItems: TRIAGE_VIEWER_INVOLVEMENTS_V1.length }),
        sourceAttention: defineProtocolUnion([
            defineProtocolObject({
                level: defineProtocolLiteral('none'),
            }, { policy: 'closed' }),
            defineProtocolObject({
                level: defineTriageStringUnionV1(TRIAGE_SOURCE_ATTENTION_LEVELS_V1),
                reasonId: TriageIdentifierV1ProtocolSchema,
                reasonLabel: TriageTextV1ProtocolSchema,
            }, { policy: 'closed' }),
        ]).optional(),
    }, { policy: 'closed' });

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
    const TriageEntryRepositoryRefV1Schema: ProtocolComposableSchema<TriageEntryRepositoryRefV1> = defineProtocolObject({
        /** The SCM hosting kind whose canonicalizer produced this identity. */
        kind: ScmHostingProviderKindProtocolSchema,
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

    /** @internal Relative-only fields of one authoritative present observation. */
    const TriageSourcePresentObservationV1Fields = {
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
    const TriageSourcePresentObservationV1ProtocolSchema = defineProtocolObject(
        TriageSourcePresentObservationV1Fields,
        { policy: 'closed' },
    );

    /** @internal Relative-only merged arm; its envelope is exactly kind/ref/successor. */
    const TriageSourceMergedObservationV1ProtocolSchema = defineProtocolObject({
        kind: defineProtocolLiteral('merged'),
        localRef: TriageSourceEntryLocalRefV1Schema,
        successor: TriageSourceEntryLocalRefV1Schema,
    }, { policy: 'closed' });

    /** @internal Relative-only unresolved arm: no authoritative presence conclusion. */
    const TriageSourceUnresolvedObservationV1ProtocolSchema = defineProtocolObject({
        kind: defineProtocolLiteral('unresolved'),
        localRef: TriageSourceEntryLocalRefV1Schema,
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' });

    /** @internal Relative-only absence fields, shared with the transient get result. */
    const TriageSourceAbsentObservationV1ProtocolSchema = defineProtocolObject({
        kind: defineProtocolLiteral('absent'),
        localRef: TriageSourceEntryLocalRefV1Schema,
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
    const TriageSourceObservationV1Schema = defineProtocolUnion([
        TriageSourcePresentObservationV1ProtocolSchema,
        TriageSourceAbsentObservationV1ProtocolSchema,
        TriageSourceMergedObservationV1ProtocolSchema,
        TriageSourceUnresolvedObservationV1ProtocolSchema,
    ]);

    /**
     * The scan-safe observation union. `scan` has no absent arm: a finished walk is
     * health evidence, never set-complement evidence (`CONTRACT.md` §4).
     */
    const TriageSourceScanObservationV1Schema = defineProtocolUnion([
        TriageSourcePresentObservationV1ProtocolSchema,
        TriageSourceMergedObservationV1ProtocolSchema,
        TriageSourceUnresolvedObservationV1ProtocolSchema,
    ]);

    /**
     * The source-private in-memory scan continuation. It binds the initial limit
     * and any provider-native page geometry, exists only for one scan invocation,
     * and is never persisted or promoted to another cursor type
     * (`CONTRACT.md` §5.1).
     */
    const TriageScanContinuationV1Schema = defineProtocolObject({
        v: defineProtocolLiteral(1),
        token: defineProtocolUtf8String({
            minLength: 1,
            maxUtf8Bytes: triagePagingTokenUtf8BytesForFieldBytesV1(fieldBytes),
            pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
        }),
    }, { policy: 'closed' });

    /**
     * Scan health evidence is exactly `walkFinished`, `partial`, or `moving`.
     * `omittedItemCount` is available only on `partial`, and counts provider rows
     * the source omitted while tolerantly decoding — never entry-level projection
     * truncation (`CONTRACT.md` §3.2).
     */
    const TriageSourceScanEvidenceV1Schema = defineProtocolUnion([
        defineProtocolObject({
            kind: defineProtocolLiteral('walkFinished'),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('partial'),
            reason: TriageIdentifierV1ProtocolSchema,
            omittedItemCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
            /** A failed sub-read beside readable observations, preserved for recovery presentation. */
            failure: TriageSourceFailureV1Schema.optional(),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('moving'),
            reason: TriageIdentifierV1ProtocolSchema,
        }, { policy: 'closed' }),
    ]);

    /** @internal Relative-only bounded page of scan observations. */
    const TriageScanObservationsV1ProtocolSchema = defineProtocolArray(
        TriageSourceScanObservationV1Schema,
    );

    const TriageScanPageV1Schema = defineProtocolUnion([
        defineProtocolObject({
            kind: defineProtocolLiteral('page'),
            observations: TriageScanObservationsV1ProtocolSchema,
            evidence: TriageSourceScanEvidenceV1Schema,
            continuation: TriageScanContinuationV1Schema,
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('complete'),
            observations: TriageScanObservationsV1ProtocolSchema,
            evidence: TriageSourceScanEvidenceV1Schema,
        }, { policy: 'closed' }),
    ]);

    return {
        TriageScanPageV1Schema,
        TriageSourceEntryLocalRefV1Schema,
        TriageSourceScopeUnitIdV1Schema,
        TriageEntryLocatorV1Schema,
        TriageSourceFailureClassV1ProtocolSchema,
        TriageSourceFailureV1Schema,
        TriageListInvocationErrorV1Schema,
        triagePullRequestReviewRevisionFieldsV1,
        TriagePullRequestReviewRevisionV1Schema,
        TriageRowFactValueV1Schema,
        TriageRowFactV1Schema,
        TriageEntryStateV1ProtocolSchema,
        TriageTaskFieldV1Schema,
        TriageTaskTransitionRequiredFieldV1Schema,
        TriageTaskTransitionV1Schema,
        TriageTaskCapabilitiesV1Schema,
        TriageEntryRelationsV1Schema,
        TriageSourceEntrySnapshotV1Schema,
        TriageSourceViewerFactsV1Schema,
        TriageEntryRepositoryRefV1Schema,
        TriageSourcePresentObservationV1Fields,
        TriageSourcePresentObservationV1ProtocolSchema,
        TriageSourceMergedObservationV1ProtocolSchema,
        TriageSourceUnresolvedObservationV1ProtocolSchema,
        TriageSourceAbsentObservationV1ProtocolSchema,
        TriageSourceObservationV1Schema,
        TriageSourceScanObservationV1Schema,
        TriageScanContinuationV1Schema,
        TriageSourceScanEvidenceV1Schema,
        TriageScanObservationsV1ProtocolSchema,
    };
}

/** Triage's keyed fact identity admission, after host structural decoding.
 * JSON Schema transport cannot preserve keyed-array semantics. Check the whole
 * result before any observation can be folded or published; ids are snapshot-local.
 */
export function admitSourceFacts<T extends TriageGetResultV1 | TriageScanResultV1>(result: T): T {
    const observations = result.kind === 'page' || result.kind === 'complete' ? result.observations : [result];
    for (const observation of observations) {
        if (observation.kind !== 'present') continue;
        const ids = new Set<string>();
        for (const fact of observation.snapshot.facts) {
            if (ids.has(fact.id)) {
                throw new PluginError({ code: 'plugin_targeted_operation_result_invalid', retryable: false });
            }
            ids.add(fact.id);
        }
    }
    return result;
}
