import {
    defineProtocolLiteral,
    defineProtocolJsonValue,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1,
    TRIAGE_REVIEW_WORKSPACE_STALE_REASONS_V1,
    TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1,
} from './bounds.js';
import {
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
    TriageIdentifierV1ProtocolSchema,
    TriageLocationV1ProtocolSchema,
    TriageTextV1ProtocolSchema,
    type TriageEntryLocatorV1,
    type TriageEntryRefV1,
} from './identity.js';
import {
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
} from './instances.js';

/**
 * A closed transport projection of the incumbent user-selected saved-workspace
 * scope arm. It is not a new SCM repository-context identity, a workspace id,
 * or a second selector: the Triage Session flow projects only the exact user
 * choice for this one invocation (`CONTRACT.md` §5.3).
 */
export const TriageSelectedWorkspaceScopeV1Schema = defineProtocolObject({
    serverId: TriageIdentifierV1ProtocolSchema,
    machineId: TriageIdentifierV1ProtocolSchema,
    rootPath: TriageLocationV1ProtocolSchema,
}, { policy: 'closed' });
export type TriageSelectedWorkspaceScopeV1 = ReturnType<
    typeof TriageSelectedWorkspaceScopeV1Schema.parse
>;

/**
 * The source-owned PR revision facts that one authoritative provider read can
 * publish. The observation timestamp belongs to the target, so the scan/get
 * snapshot carries this exact three-field projection and preparation combines
 * it with the target stamp below.
 */
const triagePullRequestReviewRevisionFieldsV1 = {
    baseSha: TriageIdentifierV1ProtocolSchema,
    headSha: TriageIdentifierV1ProtocolSchema,
    nativeRevision: TriageIdentifierV1ProtocolSchema,
} as const;

export const TriagePullRequestReviewRevisionV1Schema = defineProtocolObject(
    triagePullRequestReviewRevisionFieldsV1,
    { policy: 'closed' },
);
export type TriagePullRequestReviewRevisionV1 = ReturnType<
    typeof TriagePullRequestReviewRevisionV1Schema.parse
>;

/**
 * The target-stamped provider revision this preparation was asked to match.
 * The source authoritatively rereads the pull request and requires base, head,
 * and native revision to still match before any local materialization
 * (`CONTRACT.md` §5.3, §5.4).
 */
export const TriageReviewWorkspaceObservedRevisionV1Schema = defineProtocolObject({
    ...triagePullRequestReviewRevisionFieldsV1,
    observedAtMs: defineProtocolNumber({ integer: true }),
}, { policy: 'closed' });
export type TriageReviewWorkspaceObservedRevisionV1 = ReturnType<
    typeof TriageReviewWorkspaceObservedRevisionV1Schema.parse
>;

/**
 * Emitted only after the source resolves the prepared local HEAD. Triage may
 * project these facts to the already selected Session target but never derives
 * currentness itself, and `preservedStale` never authorizes review start
 * (`CONTRACT.md` §5.3, §5.4).
 */
export const TriageReviewWorkspaceCurrentnessV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('currentAtObservedHead'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('movedToObservedHead'),
        fromSha: TriageIdentifierV1ProtocolSchema,
        observedHeadSha: TriageIdentifierV1ProtocolSchema,
        /** Where the superseded local work remains reachable. */
        recoveryRef: TriageIdentifierV1ProtocolSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('preservedStale'),
        resolvedHeadSha: TriageIdentifierV1ProtocolSchema,
        observedHeadSha: TriageIdentifierV1ProtocolSchema,
        reason: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_STALE_REASONS_V1[0]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_STALE_REASONS_V1[1]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_STALE_REASONS_V1[2]),
        ]),
    }, { policy: 'closed' }),
]);
export type TriageReviewWorkspaceCurrentnessV1 = ReturnType<
    typeof TriageReviewWorkspaceCurrentnessV1Schema.parse
>;

/**
 * The optional source-owned preparation request. An omitted `workspace` means no
 * user-selected workspace and returns `workspaceRequired` without a filesystem
 * probe; the `AbortSignal` is execution options, never serialized input
 * (`CONTRACT.md` §5.3).
 */
export const TriagePrepareReviewWorkspaceInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    entryRef: TriageEntryRefV1Schema,
    /**
     * The source's newest opaque route for this exact row. Account-scoped
     * instances cannot reconstruct a provider repository from public identity,
     * so this is carried under the same locator-only rule as `get`.
     */
    lastKnownLocator: TriageEntryLocatorV1Schema,
    observed: TriageReviewWorkspaceObservedRevisionV1Schema,
    workspace: TriageSelectedWorkspaceScopeV1Schema.optional(),
}, { policy: 'closed' });
export type TriagePrepareReviewWorkspaceInputV1 = ReturnType<
    typeof TriagePrepareReviewWorkspaceInputV1Schema.parse
>;

/**
 * The one projection into the source-owned workspace operation input.
 *
 * The UI selection draft, the daemon's selected-input correspondence check,
 * and the eventual source execution all cross this exact boundary. Keeping the
 * projection here prevents those three callers from independently deciding
 * whether `v`, workflow-only fields, or an empty workspace selection belong on
 * the source wire. A missing user selection is omission: it is not an explicit
 * JSON value the source can mistake for a selected workspace.
 */
export function projectTriagePrepareReviewWorkspaceInputV1(input: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    entryRef: TriageEntryRefV1;
    lastKnownLocator: TriageEntryLocatorV1;
    observed: TriageReviewWorkspaceObservedRevisionV1;
    workspace?: TriageSelectedWorkspaceScopeV1 | null;
}>): TriagePrepareReviewWorkspaceInputV1 {
    return TriagePrepareReviewWorkspaceInputV1Schema.parse({
        v: 1,
        instance: input.instance,
        entryRef: input.entryRef,
        lastKnownLocator: input.lastKnownLocator,
        observed: input.observed,
        ...(input.workspace == null ? {} : { workspace: input.workspace }),
    });
}

/**
 * Only `prepared` reaches Session composition. `created` is the sole rollback
 * authority; `repositoryPath` is the prepared local result and `branch` is
 * display/workspace data that Triage never normalizes (`CONTRACT.md` §5.3).
 */
export const TriagePrepareReviewWorkspaceResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('prepared'),
        repositoryPath: TriageLocationV1ProtocolSchema,
        branch: TriageTextV1ProtocolSchema,
        created: defineProtocolUnion([
            defineProtocolLiteral(true),
            defineProtocolLiteral(false),
        ]),
        currentness: TriageReviewWorkspaceCurrentnessV1Schema,
        /**
         * A bounded opaque transport of the canonical SCM pull-request
         * reference. Its parser stays at the SCM/Reviews producer: Triage and
         * sources must not grow a second `ScmPullRequestReference` grammar.
         */
        pullRequest: defineProtocolJsonValue({ maxSerializedUtf8Bytes: 512 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('workspaceRequired'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('workspaceMismatch'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unsupported'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        reason: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1[0]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1[1]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1[2]),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('refused'),
        reason: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1[0]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1[1]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1[2]),
        ]),
    }, { policy: 'closed' }),
]);
export type TriagePrepareReviewWorkspaceResultV1 = ReturnType<
    typeof TriagePrepareReviewWorkspaceResultV1Schema.parse
>;

/**
 * Final source-owned verification of an already prepared review workspace.
 * It repeats the exact selected source, provider revision and saved-workspace
 * scope, while `prepared` carries only the source's own prior materialization
 * result. Triage cannot substitute a path or provider reference from another
 * source.
 */
export const TriageVerifyReviewWorkspaceInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    entryRef: TriageEntryRefV1Schema,
    lastKnownLocator: TriageEntryLocatorV1Schema,
    observed: TriageReviewWorkspaceObservedRevisionV1Schema,
    workspace: TriageSelectedWorkspaceScopeV1Schema,
    prepared: defineProtocolObject({
        repositoryPath: TriageLocationV1ProtocolSchema,
        pullRequest: defineProtocolJsonValue({ maxSerializedUtf8Bytes: 512 }),
    }, { policy: 'closed' }),
}, { policy: 'closed' });
export type TriageVerifyReviewWorkspaceInputV1 = ReturnType<
    typeof TriageVerifyReviewWorkspaceInputV1Schema.parse
>;

/**
 * The provider and canonical SCM owner jointly verify the final start facts.
 * No failing arm returns a replacement path or silently refreshes the user's
 * selection.
 */
export const TriageVerifyReviewWorkspaceResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('verified'),
        pullRequest: defineProtocolJsonValue({ maxSerializedUtf8Bytes: 512 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('workspaceMismatch'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        reason: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1[0]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1[1]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_UNAVAILABLE_REASONS_V1[2]),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('refused'),
        reason: defineProtocolUnion([
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1[0]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1[1]),
            defineProtocolLiteral(TRIAGE_REVIEW_WORKSPACE_REFUSED_REASONS_V1[2]),
        ]),
    }, { policy: 'closed' }),
]);
export type TriageVerifyReviewWorkspaceResultV1 = ReturnType<
    typeof TriageVerifyReviewWorkspaceResultV1Schema.parse
>;
