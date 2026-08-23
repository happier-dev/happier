import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceWorkflowSubjectV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * The strict contract of the two Session Actions the common header presses.
 *
 * `sessions/start-entry-v1` is the ONE transport between a reader pressing
 * **Ask** or **Fix** and `sessions/entrySessionOrchestrator.ts#startEntrySession`.
 * A mounted surface holds Actions, not Account storage and not the canonical
 * creator's typed result, so without this Action the whole orchestration — the
 * intent gate, the generic spawn, the idempotent link and the canonical open —
 * is unreachable from the product. It adds no second orchestration path: the
 * handler beneath it carries the caller's settled choice to the existing owner
 * and projects that owner's own verdict back.
 *
 * `sessions/unlink-entry-v1` is the inverse the user was missing: somebody who
 * linked the wrong entry could not undo it. It reaches the same canonical
 * `entrySessionLinks.ts` writer, which is why removing a link still happens in
 * exactly one place.
 *
 * Both are declared here rather than in `@happier-dev/triage-protocol` for the
 * reason the link and pin Actions are: the caller family is this plugin's own
 * mounted surfaces, and publishing a Session-start or link-removing shape
 * cross-plugin would invite a second authority over a relationship the corpus
 * contract gives exactly one owner.
 */

const triageText = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/** The host-stamped `SessionId`, bounded by the durable link row's own field. */
const triageSessionId = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const triageIdentifier = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/**
 * The entry as the caller's device-local projection rendered it.
 *
 * The locator travels whole rather than pre-resolved to a path, exactly as the
 * link Action carries it: which member the link freezes is the writer's
 * decision, and a caller that resolved it first would be a second place that
 * rule lives.
 */
const TriageEntrySessionLinkDisplayV1Schema = defineProtocolObject({
    locator: TriageEntryLocatorV1Schema,
    scopeLabel: triageText,
}, { policy: 'closed' });

/**
 * The generic Session target the user selected, restated at this Action's wire
 * boundary and nowhere else.
 *
 * These are the only two members `session.spawn_new` requires beyond the
 * directory this start owns, and they are carried as the exact canonical shapes
 * (`packages/protocol/src/sessions/creation/sessionSpawnNewResultV1.ts#SessionExecutionTargetV1Schema`
 * and `packages/protocol/src/agents/executionTargetV1.ts#AgentExecutionTargetV1Schema`)
 * rather than a Triage vocabulary for them. Triage validates none of it: the
 * canonical creator remains the sole authority over what a valid target is, and
 * rejects a bad one with its own typed error.
 *
 * Nothing else about the Session is chosen here. A model, a profile, a
 * permission mode or a title supplied at this boundary would be a second
 * Session-authoring surface competing with the generic one.
 *
 * The two member schemas are named because the settled-draft reader below
 * consumes exactly them. A start is therefore admitted by one grammar whether
 * it arrives as this Action's input or as the host's own new-Session
 * settlement.
 */
const TriageSessionExecutionTargetV1Schema = defineProtocolObject({
    serverId: triageIdentifier,
    machineId: triageIdentifier,
}, { policy: 'closed' });

const TriageAgentExecutionTargetV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('agent'),
    identity: defineProtocolObject({
        pluginId: triageIdentifier,
        localId: triageIdentifier,
    }, { policy: 'closed' }),
}, { policy: 'closed' });

const TriageNewSessionSpawnV1Schema = defineProtocolObject({
    executionTarget: TriageSessionExecutionTargetV1Schema,
    agentTarget: TriageAgentExecutionTargetV1Schema,
}, { policy: 'closed' });

/**
 * What Triage reads back out of the host's own settled new-Session draft.
 *
 * The default Ask/Fix path names no Agent: the reader opens the host's New
 * Session surface, picks the Agent and the working directory there exactly as
 * they do for any other Session, and the host settles
 * `PluginUiSelectActionInputServerStartDraftV1`
 * (`packages/protocol/src/plugins/ui/hostApiRequests.ts`) back with no
 * invocation. This schema is how that settlement becomes a start — and it
 * deliberately reuses the two member schemas immediately above rather than
 * restating them, so the draft this admits is by construction a start the wire
 * can already carry and Triage never acquires a second Agent-target grammar.
 *
 * The policy is additive-open/drop because the settled draft is the host's
 * WHOLE New Session projection. Every other member it carries — a title, a
 * permission mode, a model selection, startup instructions — is dropped here
 * rather than forwarded: a Triage start is routing, and forwarding them would
 * make this the second Session-authoring surface the spawn contract above
 * already refuses.
 */
export const TriageStartEntrySessionSettledDraftV1Schema = defineProtocolObject({
    executionTarget: TriageSessionExecutionTargetV1Schema,
    agentTarget: TriageAgentExecutionTargetV1Schema,
    directory: triageText,
}, { policy: 'additive-open/drop' });
export type TriageStartEntrySessionSettledDraftV1 =
    ReturnType<typeof TriageStartEntrySessionSettledDraftV1Schema.parse>;

/**
 * The materializations a mounted surface may request.
 *
 * `reviewWorkspace` — the pull-request Fix arm — is deliberately absent. It is
 * not a narrowing of the orchestrator's own union but the honest reach of this
 * wire: preparing one needs the selected source's admitted
 * `prepareReviewWorkspace` operation and an observed base/head pair, and no
 * shipped source binds that operation
 * (`packages/plugins/scm-github/src/manifest.ts` leaves it unbound;
 * `packages/plugins/scm-gitlab/src/triage/contribution.ts` states the same).
 * Accepting a request nothing can serve would put a control in the product that
 * always resolves the workspace refusal.
 */
const TriageStartEntrySessionMaterializationV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('referenceOnly'),
        directory: triageText,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('selectedProject'),
        directory: triageText,
    }, { policy: 'closed' }),
]);

/**
 * The destination the user settled on before pressing.
 *
 * `creationKey` is minted by the caller and re-sent unchanged on a retry: it is
 * `SessionCreationKeyV1`, the only identity for one logical new-Session request,
 * and this Action mints none of its own.
 */
const TriageStartEntrySessionDestinationV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('existing'),
        sessionId: triageSessionId,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('new'),
        creationKey: triageIdentifier,
        spawn: TriageNewSessionSpawnV1Schema,
        materialization: TriageStartEntrySessionMaterializationV1Schema,
    }, { policy: 'closed' }),
]);

export const TriageStartEntrySessionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    intent: defineProtocolUnion([
        defineProtocolLiteral('ask'),
        defineProtocolLiteral('fix'),
    ]),
    workflowSubject: TriageSourceWorkflowSubjectV1Schema,
    entryRef: TriageEntryRefV1Schema,
    display: TriageEntrySessionLinkDisplayV1Schema,
    destination: TriageStartEntrySessionDestinationV1Schema,
}, { policy: 'closed' });
export type TriageStartEntrySessionInputV1 =
    ReturnType<typeof TriageStartEntrySessionInputV1Schema.parse>;
export const TriageStartEntrySessionInputV1JsonSchema: PluginJsonSchema =
    TriageStartEntrySessionInputV1Schema.jsonSchema;

const triageDisposition = defineProtocolUnion([
    defineProtocolLiteral('created'),
    defineProtocolLiteral('rejoined'),
    defineProtocolLiteral('existing'),
]);

/**
 * The orchestrator's own phase-local verdict, carried out unchanged.
 *
 * It is not a second Session result protocol: every `sessionId` is the canonical
 * one, and each arm names the exact phase that settled so the surface can retry
 * only that phase. The prepared-workspace facts the orchestrator can also carry
 * are absent because this Action cannot request that materialization, and the
 * directory the other two arms would report is the one the caller just sent.
 */
export const TriageStartEntrySessionResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        type: defineProtocolLiteral('opened'),
        sessionId: triageSessionId,
        disposition: triageDisposition,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        /** The Session exists; the link did not commit. Retry links, then opens. */
        type: defineProtocolLiteral('linkPending'),
        sessionId: triageSessionId,
        disposition: triageDisposition,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        /** Linked, but navigation failed. Retry invokes only `session.open`. */
        type: defineProtocolLiteral('openPending'),
        sessionId: triageSessionId,
        disposition: triageDisposition,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        /** Retry the same request under the same creation key; nothing was linked. */
        type: defineProtocolLiteral('creationPending'),
        outcome: defineProtocolUnion([
            defineProtocolLiteral('accepted'),
            defineProtocolLiteral('unknown'),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        /**
         * Terminal for this attempt. No Session id is disclosed even by a
         * creation conflict, so none can be fabricated, linked or opened.
         */
        type: defineProtocolLiteral('creationFailed'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        type: defineProtocolLiteral('workspacePreparationFailed'),
        reason: defineProtocolUnion([
            defineProtocolLiteral('refused'),
            defineProtocolLiteral('failed'),
        ]),
        retryable: defineProtocolUnion([
            defineProtocolLiteral(true),
            defineProtocolLiteral(false),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        /** The intent-and-subject gate refused before any provider, creator, link or open call. */
        type: defineProtocolLiteral('rejected'),
        reason: defineProtocolUnion([
            defineProtocolLiteral('existingSessionNotOfferedForFix'),
            defineProtocolLiteral('askUsesReferenceOnly'),
            defineProtocolLiteral('pullRequestFixRequiresPreparedWorkspace'),
            defineProtocolLiteral('nonPullRequestFixRequiresSelectedProject'),
        ]),
    }, { policy: 'closed' }),
]);
export type TriageStartEntrySessionResultV1 =
    ReturnType<typeof TriageStartEntrySessionResultV1Schema.parse>;
export const TriageStartEntrySessionResultV1JsonSchema: PluginJsonSchema =
    TriageStartEntrySessionResultV1Schema.jsonSchema;

/**
 * The explicit undo.
 *
 * It names an entry **and** a Session because the link's address is derived from
 * exactly that pair, and it carries no display facts on purpose — the same
 * asymmetry Unpin has. A reader must be able to undo a link from a row no
 * current pass materialized, so requiring a projection here would make the
 * mistake permanent exactly when the source stops reporting the entry.
 */
export const TriageUnlinkEntryFromSessionActionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    sessionId: triageSessionId,
    entryRef: TriageEntryRefV1Schema,
}, { policy: 'closed' });
export type TriageUnlinkEntryFromSessionActionInputV1 =
    ReturnType<typeof TriageUnlinkEntryFromSessionActionInputV1Schema.parse>;
export const TriageUnlinkEntryFromSessionActionInputV1JsonSchema: PluginJsonSchema =
    TriageUnlinkEntryFromSessionActionInputV1Schema.jsonSchema;

export const TriageUnlinkEntryFromSessionActionResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /**
     * `unlinked` covers a removal and a repeat alike: the relationship is gone
     * either way, so a second press has nothing different to report. `conflict`
     * is a settled answer rather than a failure — another writer moved the row,
     * and the reader re-reads instead of forcing one. `failed` is the storage
     * boundary refusing or losing the delete, and only that is retried.
     */
    status: defineProtocolUnion([
        defineProtocolLiteral('unlinked'),
        defineProtocolLiteral('conflict'),
        defineProtocolLiteral('failed'),
    ]),
}, { policy: 'closed' });
export type TriageUnlinkEntryFromSessionActionResultV1 =
    ReturnType<typeof TriageUnlinkEntryFromSessionActionResultV1Schema.parse>;
export const TriageUnlinkEntryFromSessionActionResultV1JsonSchema: PluginJsonSchema =
    TriageUnlinkEntryFromSessionActionResultV1Schema.jsonSchema;

/** The composed Session start: gate, materialize, create, link, open. */
export const TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 = 'sessions/start-entry-v1';
/** The explicit user operation that ends one entry-to-Session relationship. */
export const TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1 = 'sessions/unlink-entry-v1';
