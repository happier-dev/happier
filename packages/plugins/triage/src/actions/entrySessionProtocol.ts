import { MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolArray,
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
    TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';
import {
    TRIAGE_ACTION_VALUE_GATE_UTF8_BYTES_V1,
    TRIAGE_ACTION_VALUE_MARGIN_UTF8_BYTES_V1,
} from './actionValueBudget.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';

/**
 * The strict contract of the two Session Actions the common header presses.
 *
 * `sessions/start-entry-v1` is the ONE transport between a reader pressing a
 * configured Triage action and
 * `sessions/entrySessionOrchestrator.ts#startEntrySession`.
 * A mounted surface holds Actions, not Account storage and not the canonical
 * creator's typed result, so without this Action the whole orchestration — the
 * workspace-mode gate, the generic spawn, the idempotent link and the canonical
 * open — is unreachable from the product. It adds no second orchestration path: the
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

/** How the canonical creator settled one start: created, rejoined, or already there. */
const triageDisposition = defineProtocolUnion([
    defineProtocolLiteral('created'),
    defineProtocolLiteral('rejoined'),
    defineProtocolLiteral('existing'),
]);

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

/**
 * `profileId` is the ONE Session-authoring member a Triage start may carry, and
 * it is not authoring: it is the reference the pressed action already stores.
 * The canonical creator is the sole applier of what a profile means — its
 * agent, model, permission and persistence defaults, its environment and its
 * coding-prompt overrides — and Triage neither reads those nor restates them.
 * Passing the id is what makes a configured action's profile decide the Session
 * it starts; omitting it is exactly today's behaviour, where the profile a
 * person configured did nothing at all.
 *
 * It is bounded by `LaunchProfileV2.id`'s own ceiling, so a value this wire
 * would carry but the profile owner would refuse cannot be sent.
 */
const TriageNewSessionSpawnV1Schema = defineProtocolObject({
    executionTarget: TriageSessionExecutionTargetV1Schema,
    agentTarget: TriageAgentExecutionTargetV1Schema,
    profileId: triageIdentifier.optional(),
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

/**
 * What the pressed action declared it needs on disk (`PLAN.md` §0a A3).
 *
 * It carries the whole mode vocabulary, including `pull_request`, even though
 * the materialization union above deliberately cannot carry a prepared review
 * workspace: the mode says what the caller asked for, and the gate answers with
 * the exact refusal rather than the wire silently narrowing the question. The
 * retired `intent` member said `ask` or `fix` and left the gate to re-derive the
 * same three pairings from it plus the entry's workflow subject — which is why
 * `workflowSubject` is gone from this input too. Nothing else read it: the only
 * surviving reader is the source-owned preparation request, which carries its
 * own.
 */
const TriageStartEntrySessionWorkspaceModeV1Schema = defineProtocolUnion([
    defineProtocolLiteral('reference_only'),
    defineProtocolLiteral('repository'),
    defineProtocolLiteral('pull_request'),
]);

/**
 * The canonical per-string ceiling inside one runtime JSON value.
 *
 * The whole-value gate above is not the boundary a single member answers to:
 * Encoded bytes consumed by every member of a maximal start input except the
 * prompt body. The aggregate maximum test re-measures this frame from the real
 * schema, so widening any sibling member invalidates the derivation here.
 */
const TRIAGE_START_ENTRY_SESSION_FIXED_FRAME_UTF8_BYTES_V1 = 457_269;

/**
 * JSON's worst encoded cost for one string character.
 *
 * The Action gate counts the bytes of `JSON.stringify(value)`, not the raw
 * UTF-8 bytes of the string alone. A character requiring a `\uXXXX` escape
 * therefore costs six bytes. The maximal-value derivation exercises that case.
 */
const WORST_CASE_ENCODED_JSON_BYTES_PER_CHARACTER_V1 = 6;

/**
 * The resolved prompt body's ceiling, derived from the Action's real whole-
 * value transport rather than from an unrelated per-string runtime limit.
 *
 * Nothing smaller stands behind it: the canonical Session-input seam this text
 * is delivered through sets no length of its own
 * (`packages/protocol/src/sessions/messages/sessionInputAdmission.ts`), and the
 * Prompt Library invocation it comes from sets none either. So the boundary is
 * the one the Action transport enforces on this complete input. The fixed
 * frame and retained Action margin are paid first; every remaining worst-case
 * UTF-8 byte belongs to the user's prompt.
 */
export const MAX_TRIAGE_START_ENTRY_SESSION_PROMPT_CHARACTERS_V1 =
    Math.floor(
        (TRIAGE_ACTION_VALUE_GATE_UTF8_BYTES_V1
            - TRIAGE_ACTION_VALUE_MARGIN_UTF8_BYTES_V1
            - TRIAGE_START_ENTRY_SESSION_FIXED_FRAME_UTF8_BYTES_V1)
        / WORST_CASE_ENCODED_JSON_BYTES_PER_CHARACTER_V1,
    );

const triagePromptBody = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_START_ENTRY_SESSION_PROMPT_CHARACTERS_V1,
});

/**
 * What the pressed action configured to deliver once the Session exists
 * (`PLAN.md` §0a A4a).
 *
 * It travels on the START rather than being sent afterwards by the surface,
 * because opening the Session retires that surface: a delivery that ran after
 * the open was skipped outright whenever navigation got there first, and the
 * reader arrived at a Session with nothing in it.
 *
 * Only the two attachment halves this input does not already carry are here.
 * `entryRef` supplies the source and `display` supplies the scope label and the
 * observed routing hint, so the whole attachment is rebuilt by its one owner on
 * the far side rather than shipped as a second spelling of it. No provider
 * prose rides along: the attachment resolves authoritative facts at dispatch.
 *
 * `compose` actions carry no delivery at all. Their text and attachment go into
 * that Session's own composer, which only a mounted surface can write.
 */
const triageAttachmentFallbackTitle = defineProtocolString({
    minLength: 1,
    maxLength: MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 * 2,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const TriageStartEntrySessionDeliveryAttachmentV1Schema = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    display: TriageEntrySessionLinkDisplayV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    title: triageAttachmentFallbackTitle,
}, { policy: 'closed' });

const TriageStartEntrySessionDeliveryV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('send'),
    /** Absent when the action names no prompt; the entry attachment still goes. */
    text: triagePromptBody.optional(),
    /**
     * Every selected entry carried by this one structured input, in reader
     * order. The primary entry is included: treating it as an implicit special
     * case and appending `additionalEntries` was the split shape that let the
     * bulk caller accidentally send only the first attachment.
     */
    attachments: defineProtocolArray(
        TriageStartEntrySessionDeliveryAttachmentV1Schema,
        { maxItems: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 },
    ),
    /**
     * This press's one delivery identity, minted by the caller and re-sent
     * unchanged on a retry — the same discipline `creationKey` follows, and for
     * the same reason. It is never the Session id: a Session-scoped key would
     * make a second, different action's prompt a duplicate of the first and
     * dedupe it away.
     */
    idempotencyKey: triageIdentifier,
}, { policy: 'closed' });

/**
 * Resume the phase that did not settle, instead of starting again.
 *
 * A press that answered `linkPending` or `openPending` left a real Session
 * behind. Pressing again re-sends this input with the SAME creation and
 * delivery keys plus the phase it stopped at, so the incumbent resume owner
 * (`sessions/entrySessionOrchestrator.ts#resumeEntrySessionStart`) retries only
 * that phase. Without it every press minted a new creation key and the copy
 * promising that pressing again resumes the same Session was simply untrue.
 *
 * There is no durable retry record anywhere behind this: the identity is the
 * caller's retained keys, and the canonical creator and the idempotent link
 * already make repeating a phase safe.
 */
const TriageStartEntrySessionResumeV1Schema = defineProtocolObject({
    phase: defineProtocolUnion([
        defineProtocolLiteral('linkPending'),
        defineProtocolLiteral('openPending'),
    ]),
    sessionId: triageSessionId,
    disposition: triageDisposition,
}, { policy: 'closed' });

export const TriageStartEntrySessionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    workspaceMode: TriageStartEntrySessionWorkspaceModeV1Schema,
    entryRef: TriageEntryRefV1Schema,
    display: TriageEntrySessionLinkDisplayV1Schema,
    destination: TriageStartEntrySessionDestinationV1Schema,
    delivery: TriageStartEntrySessionDeliveryV1Schema.optional(),
    resume: TriageStartEntrySessionResumeV1Schema.optional(),
}, { policy: 'closed' });
export type TriageStartEntrySessionInputV1 =
    ReturnType<typeof TriageStartEntrySessionInputV1Schema.parse>;
export const TriageStartEntrySessionInputV1JsonSchema: PluginJsonSchema =
    TriageStartEntrySessionInputV1Schema.jsonSchema;

/**
 * The orchestrator's own phase-local verdict, carried out unchanged.
 *
 * It is not a second Session result protocol: every `sessionId` is the canonical
 * one, and each arm names the exact phase that settled so the surface can retry
 * only that phase. The prepared-workspace facts the orchestrator can also carry
 * are absent because this Action cannot request that materialization, and the
 * directory the other two arms would report is the one the caller just sent.
 */
/**
 * The canonical Session-input admission verdict, plus the two arms that mean the
 * send never reached admission.
 *
 * It exists on the wire because the surface cannot ask again: the delivery
 * happened inside the start, before the open. Every arm is reported as itself —
 * a refusal and an unknown outcome are the two the previous surface reported as
 * success, having awaited the send and discarded its value.
 */
const triageDeliveryOutcome = defineProtocolUnion([
    /** The start carried no delivery: a `compose` action places its own. */
    defineProtocolLiteral('notRequested'),
    /** Requested, with neither a prompt nor a placeable attachment to send. */
    defineProtocolLiteral('none'),
    defineProtocolLiteral('accepted'),
    defineProtocolLiteral('alreadyAccepted'),
    defineProtocolLiteral('rejected'),
    defineProtocolLiteral('outcomeUnknown'),
]);

export const TriageStartEntrySessionResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        type: defineProtocolLiteral('opened'),
        sessionId: triageSessionId,
        disposition: triageDisposition,
        delivery: triageDeliveryOutcome,
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
        /** Linked and delivered, but navigation failed. Retry re-opens. */
        type: defineProtocolLiteral('openPending'),
        sessionId: triageSessionId,
        disposition: triageDisposition,
        delivery: triageDeliveryOutcome,
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
        /** The workspace-mode gate refused before any provider, creator, link or open call. */
        type: defineProtocolLiteral('rejected'),
        reason: defineProtocolUnion([
            defineProtocolLiteral('existingSessionRequiresReferenceOnlyMode'),
            defineProtocolLiteral('referenceOnlyModeRequiresReferenceOnlyWorkspace'),
            defineProtocolLiteral('pullRequestModeRequiresPreparedWorkspace'),
            defineProtocolLiteral('repositoryModeRequiresSelectedProject'),
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
