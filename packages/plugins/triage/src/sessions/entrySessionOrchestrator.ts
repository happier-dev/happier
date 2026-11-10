import type {
    PluginActionInputById,
    PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { SessionServerStartSpawnDraftV1Schema, projectSessionSpawnNewActionInputV2, type SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageStartEntrySessionInputV1 } from '../actions/entrySessionProtocol.js';
import type { TriageSessionDeliveryFailureDetailV1 } from '../actions/configuredActionRunProtocol.js';

import { sameTriageEntryReference } from '../corpus/identity/components.js';
import type { TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';
import {
    deliverEntrySessionInput,
    type TriageEntrySessionDeliveryOutcomeV1,
    type TriageEntrySessionDeliveryRequestV1,
} from './entrySessionDelivery.js';
import { openLinkedSession, type TriageSessionActionInvokerV1 } from './entrySessionOpen.js';
import {
    materializationDirectory,
    materializationWorkspaceFacts,
    resolveEntrySessionWorkspace,
    TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1,
    TRIAGE_WORKSPACE_PREPARATION_REFUSED_V1,
    type TriageEntrySessionWorkspaceFactsV1,
    type TriageResolvedMaterializationV1,
    type TriageReviewWorkspacePreparationDepsV1,
    type TriageWorkspaceMaterializationV1,
    type TriageWorkspaceModeV1,
    type TriageWorkspacePreparationFailureV1,
} from './entrySessionWorkspace.js';

export type {
    TriageEntrySessionWorkspaceFactsV1,
    TriageResolvedMaterializationV1,
    TriageReviewWorkspacePreparationRequestV1,
    TriageWorkspaceMaterializationV1,
    TriageWorkspaceModeV1,
    TriageWorkspacePreparationFailureV1,
} from './entrySessionWorkspace.js';
export type { TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';
export type {
    TriageEntrySessionDeliveryOutcomeV1,
    TriageEntrySessionDeliveryRequestV1,
} from './entrySessionDelivery.js';

type SessionSpawnInput = PluginActionInputById['session.spawn_new'];

/**
 * The generic spawn members a Triage start may choose, and no others.
 *
 * `creationKey` and `directory` are owned here so one start has exactly one
 * identity and one working directory. The three below are structurally absent
 * because a Triage start is routing, not Session authoring: a title the reader
 * never typed, startup instructions this plugin does not own, and a second
 * checkout draft competing with the source-owned preparation.
 *
 * Neither legacy `initialMessage` nor caller-supplied `initialInput` is
 * admitted. Once the Session exists and its durable Triage link has committed,
 * the start owner sends the pressed action's resolved Prompt Library body and
 * declared entry attachments through the one canonical Session-input Action
 * (`PLAN.md` §0a A4/A4a). Orchestrate this may include a labelled entry brief in
 * the user's editable prompt (owner amendment r0.5-X). The declared `entry`
 * attachment still supplies authoritative facts at dispatch time.
 */
const PROHIBITED_SPAWN_MEMBERS = [
    'title',
    'initialMessage',
    'initialInput',
    'agentSessionStartupInstructionsV1',
    'checkoutCreationDraft',
] as const;

export type TriageSessionSpawnRequestV1 = Extract<
    TriageStartEntrySessionInputV1['destination'], { kind: 'new' }
>['spawn'];

/**
 * Strips the prohibited members even when a caller carried them in an
 * unnarrowed value. The type says a caller cannot bypass the canonical initial
 * input planner or seed a second workspace; this makes the running code say it
 * too.
 */
function withoutProhibitedSpawnMembers(
    spawn: TriageSessionSpawnRequestV1,
): Record<string, unknown> {
    const candidate: Record<string, unknown> = { ...spawn };
    for (const member of PROHIBITED_SPAWN_MEMBERS) delete candidate[member];
    return candidate;
}

export type TriageEntrySessionDestinationV1 =
    | Readonly<{ kind: 'existing'; sessionId: SessionId; serverId?: string;
        /** Internal accepted-Session projection; never a caller-supplied path choice. */
        workspace?: TriageEntrySessionWorkspaceFactsV1;
        /** Set only after the selected source's native read-only checkout verification. */
        verifiedReviewWorkspace?: true }>
    | Readonly<{
        kind: 'new';
        creationKey: string;
        spawn: TriageSessionSpawnRequestV1;
        materialization: TriageWorkspaceMaterializationV1;
    }>;

/**
 * A bulk owner may retain the final navigation while it finishes the rest of a
 * unit or batch. Omitting this keeps the ordinary single-entry contract:
 * link, deliver, then immediately open.
 */
export type TriageEntrySessionFinalOpenV1 = 'deferred' | 'suppressed';

export type TriageSessionStartRequestV1 = Readonly<{
    entryRef?: TriageEntryRefV1;
    /**
     * The entry as the caller's device-local projection rendered it. The link
     * freezes a display path from it; nothing durable holds one to read.
     */
    display?: TriageEntrySessionLinkDisplayV1;
    /**
     * What the pressed action declared it needs on disk. It is the gate's ONE
     * input: the entry's workflow subject decided which actions were offered at
     * all, and re-deciding here from the subject a second time is what let the
     * surface and the gate disagree about one press.
     */
    workspaceMode: TriageWorkspaceModeV1;
    destination: TriageEntrySessionDestinationV1;
    /** ORC r0.5-X: birth planning uses the final prompt delivered after linking. */
    orchestrate?: true;
    /**
     * What the pressed action configured to deliver once the Session exists.
     *
     * Absent means the press delivers nothing through this start — a `compose`
     * action, whose whole point is that the reader looks first, places its text
     * and attachment in that Session's own composer and sends nothing.
     */
    delivery?: TriageEntrySessionDeliveryRequestV1;
    /**
     * Retains the generic final-open phase for the caller that owns a real
     * batch. `deferred` means that caller opens this exact linked Session after
     * its remaining unit work settles; `suppressed` means the batch has no
     * honest single Session to open. Ordinary starts omit it and still open.
     */
    finalOpen?: TriageEntrySessionFinalOpenV1;
}>;

/** Legacy entry callers keep their required identity; repository handoffs have none. */
export type TriageEntrySessionStartRequestV1 = TriageSessionStartRequestV1 & Readonly<{
    entryRef: TriageEntryRefV1;
    display: TriageEntrySessionLinkDisplayV1;
}>;

export type TriageEntrySessionRejectionReasonV1 = Extract<
    import('../actions/entrySessionProtocol.js').TriageStartEntrySessionResultV1, { type: 'rejected' }
>['reason'];

export type TriageEntrySessionDispositionV1 = ReturnType<
    typeof import('../actions/entrySessionProtocol.js').TriageEntrySessionDispositionV1Schema.parse
>;

export type TriageEntrySessionStartResultV1 = (
    | Readonly<{
        type: 'opened';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        /** The Message-send owner's own verdict on the structured delivery. */
        delivery: TriageEntrySessionDeliveryOutcomeV1;
    }>
    | Readonly<{
        /** Linked and delivered; this caller explicitly retained final navigation. */
        type: 'linked';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        delivery: TriageEntrySessionDeliveryOutcomeV1;
        finalOpen: TriageEntrySessionFinalOpenV1;
    }>
    | Readonly<{
        type: 'linkPending';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        delivery?: TriageEntrySessionDeliveryOutcomeV1;
    }>
    | Readonly<{
        type: 'openPending';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        delivery: TriageEntrySessionDeliveryOutcomeV1;
    }>
    | Readonly<{
        type: 'creationPending';
        creationKey: string;
        outcome: 'accepted' | 'unknown';
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'creationFailed';
        failureCode: Extract<PluginActionResultById['session.spawn_new'], { type: 'error' }>['code'];
        failureCause?: string;
        creationKey: string;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'workspacePreparationFailed';
        reason: TriageWorkspacePreparationFailureV1['reason'];
        retryable: boolean;
    }>
    | Readonly<{ type: 'rejected'; reason: TriageEntrySessionRejectionReasonV1 }>
) & Readonly<{ deliveryResult?: PluginActionResultById['session.message.send'] }>;

export type TriageEntrySessionDepsV1 = Readonly<{
    /** The composed source/corpus relationship owner supplied by the invocation. */
    linkSession: (input: Readonly<{
        entryRef: TriageEntryRefV1; display: TriageEntrySessionLinkDisplayV1;
        sessionId: string; sourceInstanceId?: string;
    }>) => Promise<Readonly<{ status: 'linked' | 'failed' }>>;
    execute: TriageSessionActionInvokerV1;
    onDeliveryFailure?: (detail: TriageSessionDeliveryFailureDetailV1) => void;
    /**
     * The selected source contribution's admitted preparation operation and the
     * host execution for it. Absent when nothing about the current selection can
     * prepare a worktree; a pull-request Fix then fails closed rather than
     * reaching for another route.
     */
    prepareReviewWorkspace?: TriageReviewWorkspacePreparationDepsV1;
    signal?: AbortSignal;
}>;

/** SDK admission refusals reject; Session creation settlements are returned. */
async function spawnEntrySession(
    deps: TriageEntrySessionDepsV1,
    input: SessionSpawnInput,
): Promise<PluginActionResultById['session.spawn_new']> {
    try {
        return await deps.execute('session.spawn_new', input, deps.signal ? { signal: deps.signal } : undefined);
    } catch (error) {
        // This documented SDK refusal precedes creation. Preserve other
        // exceptions so a lost response retains same-key recovery.
        if (isPluginError(error) && error.code === 'target_unavailable') {
            return { type: 'error', code: 'target_unavailable', retryable: error.retryable };
        }
        throw error;
    }
}

/**
 * Link, then deliver, then open — unless the batch owner retained final open.
 *
 * The delivery sits between the link and the open on purpose (`PLAN.md` §0a
 * A4a). Opening a Session navigates the client away from Triage and retires the
 * surface that used to be responsible for delivering; a send that runs first
 * cannot be lost to that navigation, and the open is the last thing that
 * happens rather than the thing that pre-empts the work.
 *
 * A delivery outcome never changes the start's own verdict. The Session exists,
 * is linked and opens whatever admission said; the two facts are reported side
 * by side so a reader is never told the start failed because their prompt was
 * refused, nor told everything worked when it was.
 */
type LinkedSessionDeliveryInput = Readonly<{
    sessionId: SessionId;
    serverId?: string;
    disposition: TriageEntrySessionDispositionV1;
    workspace: TriageEntrySessionWorkspaceFactsV1;
    delivery?: TriageEntrySessionDeliveryRequestV1;
    settledDelivery?: TriageEntrySessionDeliveryOutcomeV1;
    finalOpen?: TriageEntrySessionFinalOpenV1;
}>;

async function linkDeliverThenOpen(
    deps: TriageEntrySessionDepsV1,
    input: LinkedSessionDeliveryInput & Readonly<{
        entryRef?: TriageEntryRefV1;
        display?: TriageEntrySessionLinkDisplayV1;
    }>,
): Promise<TriageEntrySessionStartResultV1> {
    const requiredLinks: Readonly<{
        entryRef: TriageEntryRefV1;
        display: TriageEntrySessionLinkDisplayV1;
    }>[] = input.entryRef === undefined || input.display === undefined ? [] : [{
        entryRef: input.entryRef,
        display: input.display,
    }];
    for (const candidate of input.delivery?.attachments ?? []) {
        if (requiredLinks.some((link) => sameTriageEntryReference(link.entryRef, candidate.entryRef))) {
            continue;
        }
        requiredLinks.push(candidate);
    }
    for (const requiredLink of requiredLinks) {
        const sourceInstanceId = input.delivery?.attachments.find((attachment) =>
            sameTriageEntryReference(attachment.entryRef, requiredLink.entryRef))?.sourceInstanceId;
        const linkInput = {
            ...requiredLink,
            sessionId: input.sessionId,
            ...(sourceInstanceId === undefined ? {} : { sourceInstanceId }),
        };
        const link = deps.linkSession === undefined ? { status: 'failed' } : await deps.linkSession(linkInput);
        if (link.status !== 'linked') {
            // No structured input is admitted until every relationship its
            // attachments require is durable. Retrying starts this idempotent
            // set again; already committed links keep their original row.
            return {
                type: 'linkPending',
                sessionId: input.sessionId,
                disposition: input.disposition,
                workspace: input.workspace,
                ...(input.settledDelivery === undefined ? {} : { delivery: input.settledDelivery }),
            };
        }
    }
    return await deliverThenOpen(deps, input);
}

/** Every linked start/retry shares the same delivery and final-navigation decision. */
async function deliverThenOpen(
    deps: TriageEntrySessionDepsV1,
    input: LinkedSessionDeliveryInput,
): Promise<TriageEntrySessionStartResultV1> {
    let deliveryResult: PluginActionResultById['session.message.send'] | undefined;
    const delivery: TriageEntrySessionDeliveryOutcomeV1 = input.settledDelivery
        ?? (input.delivery === undefined
            ? 'notRequested'
            : await deliverEntrySessionInput({
                execute: deps.execute,
                sessionId: input.sessionId,
                serverId: input.serverId,
                delivery: input.delivery,
                onResult: (result) => { if (input.delivery?.returnResult === true) deliveryResult = result; },
                ...(deps.onDeliveryFailure === undefined ? {} : { onFailure: deps.onDeliveryFailure }),
                ...(deps.signal ? { signal: deps.signal } : {}),
            }));
    if (input.finalOpen !== undefined) {
        // This is not an `openPending`: the canonical open phase has not been
        // attempted or failed. The start owner has linked and delivered all it
        // owns, and hands the exact linked Session back to the batch sequence
        // that deliberately retained final navigation.
        return {
            type: 'linked',
            sessionId: input.sessionId,
            disposition: input.disposition,
            workspace: input.workspace,
            delivery,
            ...(deliveryResult === undefined ? {} : { deliveryResult }),
            finalOpen: input.finalOpen,
        };
    }
    const opened = await openLinkedSession({
        execute: deps.execute,
        sessionId: input.sessionId,
        ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        type: opened.status === 'opened' ? 'opened' : 'openPending',
        sessionId: input.sessionId,
        disposition: input.disposition,
        workspace: input.workspace,
        delivery,
        ...(deliveryResult === undefined ? {} : { deliveryResult }),
    };
}

/**
 * The phase a settled start stopped at, and everything a retry of it needs.
 *
 * It is stated rather than extracted from the result union because a resume
 * needs strictly less than a verdict carries. A link/open retry retains a
 * delivery verdict only when Message send already settled; an absent verdict is
 * the explicit instruction to ask the canonical Message-send owner again.
 */
export type TriageEntrySessionPendingPhaseV1 =
    | Readonly<{
        type: 'creationPending';
        creationKey: string;
        spawn: TriageSessionSpawnRequestV1;
        directory: string | Readonly<{ kind: 'managed' }>;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'linkPending' | 'openPending';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        settledDelivery?: Exclude<TriageEntrySessionDeliveryOutcomeV1, 'outcomeUnknown'>;
    }>;

/**
 * Retries exactly the phase that failed, and nothing earlier.
 *
 * A pending link retries the idempotent link, delivers if Message send has not
 * settled and then opens; a pending open likewise asks admission only when no
 * settled verdict was retained, then re-invokes `session.open` with the same
 * stable id. Neither respawns, rematerializes, reseeds a draft or mints a second
 * identity for one press. Creation never carries Triage input: after a
 * same-key rejoin settles, the durable link still commits before the one
 * idempotent Session-input admission call.
 *
 * The re-delivery is safe by construction rather than by a remembered verdict:
 * the same key rejoins the same durable input, so an accepted send answers
 * `alreadyAccepted` and an unknown one settles. Keeping a per-phase memory of
 * what Message send last said, only to decide whether to ask again, would be state
 * this path does not need.
 */
export async function resumeEntrySessionStart(
    deps: TriageEntrySessionDepsV1,
    input: Readonly<{
        entryRef?: TriageEntryRefV1;
        display?: TriageEntrySessionLinkDisplayV1;
        pending: TriageEntrySessionPendingPhaseV1;
        serverId?: string;
        delivery?: TriageEntrySessionDeliveryRequestV1;
        orchestrate?: true;
        finalOpen?: TriageEntrySessionFinalOpenV1;
    }>,
): Promise<TriageEntrySessionStartResultV1> {
    const pending = input.pending;
    const delivery = input.delivery;
    if (pending.type === 'creationPending') {
        if (input.orchestrate === true && !hasOrchestrationEntryInput(input.entryRef, delivery)) {
            return { type: 'rejected', reason: 'orchestrationRequiresNewSessionWithEntryInput' };
        }
        const result = await spawnEntrySession(
            deps,
            {
                ...entrySpawnSelection(pending.spawn, pending.directory, input.orchestrate, delivery),
                creationKey: pending.creationKey,
            },
        );
        if (result.type === 'pending') {
            return {
                type: 'creationPending',
                creationKey: pending.creationKey,
                outcome: result.outcome,
                workspace: pending.workspace,
            };
        }
        if (result.type !== 'success') {
            return {
                type: 'creationFailed',
                failureCode: result.code,
                ...('launchError' in result && result.launchError ? { failureCause: result.launchError.code } : {}),
                creationKey: pending.creationKey,
                workspace: pending.workspace,
            };
        }
        return await linkDeliverThenOpen(deps, {
            entryRef: input.entryRef,
            display: input.display,
            sessionId: result.sessionId,
            serverId: pending.spawn.executionTarget.serverId,
            disposition: result.disposition,
            workspace: pending.workspace,
            ...(delivery === undefined ? {} : { delivery }),
            ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
        });
    }
    if (pending.type === 'linkPending') {
        return await linkDeliverThenOpen(deps, {
            entryRef: input.entryRef,
            display: input.display,
            sessionId: pending.sessionId,
            serverId: input.serverId,
            disposition: pending.disposition,
            workspace: pending.workspace,
            ...(pending.settledDelivery === undefined
                ? delivery === undefined ? {} : { delivery }
                : { settledDelivery: pending.settledDelivery }),
            ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
        });
    }
    return await deliverThenOpen(deps, {
        sessionId: pending.sessionId,
        serverId: input.serverId,
        disposition: pending.disposition,
        workspace: pending.workspace,
        ...(delivery === undefined ? {} : { delivery }),
        ...(pending.settledDelivery === undefined ? {} : { settledDelivery: pending.settledDelivery }),
        ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
    });
}

/** The one refusal each mode produces when it was sent another mode's workspace. */
const MODE_MISMATCH_REJECTION_V1 = Object.freeze({
    reference_only: 'referenceOnlyModeRequiresReferenceOnlyWorkspace',
    repository: 'repositoryModeRequiresSelectedProject',
    pull_request: 'pullRequestModeRequiresPreparedWorkspace',
}) satisfies Readonly<Record<TriageWorkspaceModeV1, TriageEntrySessionRejectionReasonV1>>;

/**
 * The one workspace-mode gate, evaluated before any provider, creator, link or
 * navigation call.
 *
 * It validates one thing: that the materialization the caller sent is the one
 * its declared mode names, read from the single pairing table both ends share
 * (`entrySessionWorkspace.ts#TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1`). The
 * three approved pairings are unchanged — a reference-only action never
 * materializes a workspace, a pull-request action demands the source-prepared
 * review workspace, and every repository action runs in the project the reader
 * selected — but they are now stated once instead of derived here from an
 * intent label and the entry's workflow subject.
 *
 * An existing Session may satisfy the requirement through its canonical
 * accepted workspace projection. This never chooses or changes its directory.
 */
function rejectionFor(
    request: TriageSessionStartRequestV1,
): TriageEntrySessionRejectionReasonV1 | null {
    const destination = request.destination;
    if (request.orchestrate === true && (destination.kind !== 'new'
        || !hasOrchestrationEntryInput(request.entryRef, request.delivery))) {
        return 'orchestrationRequiresNewSessionWithEntryInput';
    }
    if (destination.kind === 'existing') {
        if (request.workspaceMode === 'reference_only') return null;
        return (destination.workspace?.kind === 'selectedProject'
            && (request.workspaceMode === 'repository' || destination.verifiedReviewWorkspace === true))
            || destination.workspace?.kind === 'preparedReviewWorkspace'
            ? null : 'existingSessionRequiresReferenceOnlyMode';
    }
    const required = TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1[request.workspaceMode];
    if (destination.materialization.kind !== required) {
        return MODE_MISMATCH_REJECTION_V1[request.workspaceMode];
    }
    if (destination.materialization.kind === 'reviewWorkspace'
        && (request.entryRef === undefined || !sameTriageEntryReference(
            request.entryRef,
            destination.materialization.request.entryRef,
        ))) {
        return 'pullRequestWorkspaceEntryMismatch';
    }
    return null;
}

function hasOrchestrationEntryInput(
    entryRef: TriageEntryRefV1 | undefined,
    delivery: TriageEntrySessionDeliveryRequestV1 | undefined,
): boolean {
    return entryRef !== undefined && delivery !== undefined && Boolean(delivery.text?.trim())
        && delivery.attachments.some((attachment) => sameTriageEntryReference(entryRef, attachment.entryRef));
}

/** The single spawn selection for initial creation and same-key creation retries. */
function entrySpawnSelection(
    spawn: TriageSessionSpawnRequestV1,
    directory: string | Readonly<{ kind: 'managed' }>,
    orchestrate: true | undefined,
    delivery: TriageEntrySessionDeliveryRequestV1 | undefined,
): SessionSpawnInput {
    // The retained carrier is a New Session recipe, not an Action operand.
    // Materialization supplies the real path before canonical admission and
    // the Session owner's Section projection run for both create and rejoin.
    const selection = projectSessionSpawnNewActionInputV2(SessionServerStartSpawnDraftV1Schema.parse({
        ...withoutProhibitedSpawnMembers(spawn), directory: typeof directory === 'string' ? { kind: 'path', path: directory } : directory,
    }));
    if (orchestrate !== true) return selection;
    return {
        ...selection,
        roleId: 'orchestrator',
        initialTriggers: [{
            target: { kind: 'workflow', ref: 'builtin:plan-with-a-panel' },
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } },
            // Both creation paths reject missing text/entry attachment before selecting a spawn.
            inputs: { request: delivery!.text! },
            onComplete: { kind: 'originating_session' },
        }],
    };
}

type ResolvedMaterialization =
    | Readonly<{ status: 'resolved'; materialization: TriageResolvedMaterializationV1 }>
    | Readonly<{ status: 'failed'; failure: TriageWorkspacePreparationFailureV1 }>;

/**
 * Turns the user's settled choice into the one directory a Session may be
 * created in. Only the pull-request arm reaches SCM, and it reaches it through
 * the selected source's admitted operation — never a provider registry, a forge
 * adapter, a clone, or a directory this module picked.
 */
async function resolveMaterialization(
    deps: TriageEntrySessionDepsV1,
    materialization: TriageWorkspaceMaterializationV1,
): Promise<ResolvedMaterialization> {
    if (materialization.kind !== 'reviewWorkspace') {
        return { status: 'resolved', materialization };
    }
    const preparation = deps.prepareReviewWorkspace;
    if (preparation === undefined) {
        return { status: 'failed', failure: TRIAGE_WORKSPACE_PREPARATION_REFUSED_V1 };
    }
    const prepared = await resolveEntrySessionWorkspace(
        deps.signal ? { ...preparation, signal: deps.signal } : preparation,
        materialization.request,
    );
    return prepared.status === 'prepared'
        ? {
            status: 'resolved',
            materialization: { kind: 'preparedReviewWorkspace', facts: prepared.facts },
        }
        : prepared;
}

export async function startEntrySession(
    deps: TriageEntrySessionDepsV1,
    request: TriageSessionStartRequestV1,
): Promise<TriageEntrySessionStartResultV1> {
    const rejection = rejectionFor(request);
    if (rejection) return { type: 'rejected', reason: rejection };

    const destination = request.destination;
    if (destination.kind === 'existing') {
        return await linkDeliverThenOpen(deps, {
            entryRef: request.entryRef,
            display: request.display,
            sessionId: destination.sessionId,
            serverId: destination.serverId,
            disposition: 'existing',
            workspace: destination.workspace ?? { kind: 'referenceOnly' },
            ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
            ...(request.finalOpen === undefined ? {} : { finalOpen: request.finalOpen }),
        });
    }

    // Preparation runs before anything durable exists. A refusal or failure here
    // creates no Session, derives no Session id, writes no link and opens
    // nothing — the user is told what stopped, not handed half a start.
    const resolved = await resolveMaterialization(deps, destination.materialization);
    if (resolved.status === 'failed') {
        return {
            type: 'workspacePreparationFailed',
            reason: resolved.failure.reason,
            retryable: resolved.failure.retryable,
        };
    }

    const workspace = materializationWorkspaceFacts(resolved.materialization);
    const spawnInput: SessionSpawnInput = {
        ...entrySpawnSelection(destination.spawn, materializationDirectory(resolved.materialization), request.orchestrate, request.delivery),
        creationKey: destination.creationKey,
    };
    const result = await spawnEntrySession(deps, spawnInput);
    // The generic action executor is the sole owner of the creation tag,
    // correspondence lookup and create-versus-rejoin decision. Triage consumes
    // its result unchanged.
    if (result.type === 'pending') {
        // Retry only the same request under the same key. No new key, attempt
        // ordinal, correspondence tag or second durable pending record exists,
        // and an exact correspondence on that retry returns `rejoined`.
        return {
            type: 'creationPending',
            creationKey: destination.creationKey,
            outcome: result.outcome,
            workspace,
        };
    }
    if (result.type !== 'success') {
        // Every canonical error is terminal for this attempt. `creation_conflict`
        // is opaque: no Session id is disclosed, so none is fabricated,
        // relabelled `rejoined`, linked or opened. A new visible user action
        // receives a new key.
        return { type: 'creationFailed', failureCode: result.code,
            ...('launchError' in result && result.launchError ? { failureCause: result.launchError.code } : {}),
            creationKey: destination.creationKey, workspace };
    }
    return await linkDeliverThenOpen(deps, {
        entryRef: request.entryRef,
        display: request.display,
        sessionId: result.sessionId,
        serverId: destination.spawn.executionTarget.serverId,
        disposition: result.disposition,
        workspace,
        ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
        ...(request.finalOpen === undefined ? {} : { finalOpen: request.finalOpen }),
    });
}
