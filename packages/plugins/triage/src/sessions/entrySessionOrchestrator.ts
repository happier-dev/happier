import type {
    PluginActionInputById,
    PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { sameTriageEntryReference } from '../corpus/identity/components.js';
import {
    linkEntryToSession,
    type TriageEntrySessionLinkDisplayV1,
} from './entrySessionLinks.js';
import {
    deliverEntrySessionInput,
    planEntrySessionInput,
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
 * admitted. The start owner below is the sole producer of canonical
 * `initialInput`, from the pressed action's resolved Prompt Library body and
 * declared entry attachments (`PLAN.md` §0a A4/A4a). The invariant is stated
 * positively: **Triage never stringifies provider prose into a prompt**. The
 * selected entry's title, body, facts and provider words still never reach the
 * text arm, because entry context reaches the agent through the declared
 * `entry` attachment, whose `resolveForDispatch`
 * (`composer/attachmentRuntime.ts`) supplies authoritative facts at dispatch
 * time — fresher than any snapshot a start could have embedded.
 */
const PROHIBITED_SPAWN_MEMBERS = [
    'title',
    'initialMessage',
    'initialInput',
    'agentSessionStartupInstructionsV1',
    'checkoutCreationDraft',
] as const;

export type TriageSessionSpawnRequestV1 = Omit<
    SessionSpawnInput,
    'creationKey' | 'directory' | (typeof PROHIBITED_SPAWN_MEMBERS)[number]
>;

/**
 * Strips the prohibited members even when a caller carried them in an
 * unnarrowed value. The type says a caller cannot bypass the canonical initial
 * input planner or seed a second workspace; this makes the running code say it
 * too.
 */
function withoutProhibitedSpawnMembers(
    spawn: TriageSessionSpawnRequestV1,
): TriageSessionSpawnRequestV1 {
    const candidate: Record<string, unknown> = { ...spawn };
    for (const member of PROHIBITED_SPAWN_MEMBERS) delete candidate[member];
    return candidate as TriageSessionSpawnRequestV1;
}

export type TriageEntrySessionDestinationV1 =
    | Readonly<{ kind: 'existing'; sessionId: SessionId }>
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

export type TriageEntrySessionStartRequestV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    /**
     * The entry as the caller's device-local projection rendered it. The link
     * freezes a display path from it; nothing durable holds one to read.
     */
    display: TriageEntrySessionLinkDisplayV1;
    /**
     * What the pressed action declared it needs on disk. It is the gate's ONE
     * input: the entry's workflow subject decided which actions were offered at
     * all, and re-deciding here from the subject a second time is what let the
     * surface and the gate disagree about one press.
     */
    workspaceMode: TriageWorkspaceModeV1;
    destination: TriageEntrySessionDestinationV1;
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

export type TriageEntrySessionRejectionReasonV1 =
    | 'existingSessionRequiresReferenceOnlyMode'
    | 'referenceOnlyModeRequiresReferenceOnlyWorkspace'
    | 'pullRequestModeRequiresPreparedWorkspace'
    | 'pullRequestWorkspaceEntryMismatch'
    | 'repositoryModeRequiresSelectedProject';

export type TriageEntrySessionDispositionV1 = 'created' | 'rejoined' | 'existing';

export type TriageEntrySessionStartResultV1 =
    | Readonly<{
        type: 'opened';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        /** The admission owner's own verdict on the structured delivery. */
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
        creationKey: string;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'workspacePreparationFailed';
        reason: TriageWorkspacePreparationFailureV1['reason'];
        retryable: boolean;
    }>
    | Readonly<{ type: 'rejected'; reason: TriageEntrySessionRejectionReasonV1 }>;

export type TriageEntrySessionDepsV1 = Readonly<{
    collections: Pick<CorpusCollectionsV1, 'sessionLinks'>;
    execute: TriageSessionActionInvokerV1;
    /**
     * The selected source contribution's admitted preparation operation and the
     * host execution for it. Absent when nothing about the current selection can
     * prepare a worktree; a pull-request Fix then fails closed rather than
     * reaching for another route.
     */
    prepareReviewWorkspace?: TriageReviewWorkspacePreparationDepsV1;
    nowMs: number;
    signal?: AbortSignal;
}>;

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
async function linkDeliverThenOpen(
    deps: TriageEntrySessionDepsV1,
    input: Readonly<{
        entryRef: TriageEntryRefV1;
        display: TriageEntrySessionLinkDisplayV1;
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        delivery?: TriageEntrySessionDeliveryRequestV1;
        settledDelivery?: TriageEntrySessionDeliveryOutcomeV1;
        finalOpen?: TriageEntrySessionFinalOpenV1;
    }>,
): Promise<TriageEntrySessionStartResultV1> {
    const link = await linkEntryToSession({
        collections: deps.collections,
        entryRef: input.entryRef,
        display: input.display,
        sessionId: input.sessionId,
        nowMs: deps.nowMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (link.status !== 'linked') {
        // Nothing is delivered into a Session this entry is not linked to: the
        // link is the relationship the delivery is context for, and the caller
        // retries this phase from the top.
        return {
            type: 'linkPending',
            sessionId: input.sessionId,
            disposition: input.disposition,
            workspace: input.workspace,
            ...(input.settledDelivery === undefined ? {} : { delivery: input.settledDelivery }),
        };
    }
    const delivery: TriageEntrySessionDeliveryOutcomeV1 = input.settledDelivery
        ?? (input.delivery === undefined
            ? 'notRequested'
            : await deliverEntrySessionInput({
                execute: deps.execute,
                sessionId: input.sessionId,
                delivery: input.delivery,
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
            finalOpen: input.finalOpen,
        };
    }
    const opened = await openLinkedSession({
        execute: deps.execute,
        sessionId: input.sessionId,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        type: opened.status === 'opened' ? 'opened' : 'openPending',
        sessionId: input.sessionId,
        disposition: input.disposition,
        workspace: input.workspace,
        delivery,
    };
}

/**
 * The phase a settled start stopped at, and everything a retry of it needs.
 *
 * It is stated rather than extracted from the result union because a resume
 * needs strictly less than a verdict carries. A link/open retry retains a
 * delivery verdict only when admission already settled; an absent verdict is
 * the explicit instruction to ask the canonical admission owner again.
 */
export type TriageEntrySessionPendingPhaseV1 =
    | Readonly<{
        type: 'creationPending';
        creationKey: string;
        spawn: TriageSessionSpawnRequestV1;
        directory: string;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'linkPending' | 'openPending';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
        settledDelivery?: Exclude<TriageEntrySessionDeliveryOutcomeV1, 'outcomeUnknown'>;
    }>;

type TriageSpawnDeliveryPlanV1 =
    | Readonly<{ kind: 'withoutInput'; outcome: 'notRequested' | 'none' }>
    | Readonly<{
        kind: 'withInput';
        initialInput: NonNullable<SessionSpawnInput['initialInput']>;
    }>;

function planSpawnDelivery(
    delivery: TriageEntrySessionDeliveryRequestV1 | undefined,
): TriageSpawnDeliveryPlanV1 {
    if (delivery === undefined) return { kind: 'withoutInput', outcome: 'notRequested' };
    const plan = planEntrySessionInput(delivery);
    if (plan.kind === 'none') return { kind: 'withoutInput', outcome: 'none' };
    return {
        kind: 'withInput',
        initialInput: {
            text: plan.text,
            ...(plan.attachments.length === 0 ? {} : { attachments: plan.attachments }),
        },
    };
}

function settledSpawnDelivery(
    plan: TriageSpawnDeliveryPlanV1,
    result: Extract<PluginActionResultById['session.spawn_new'], Readonly<{ type: 'success' }>>,
): TriageEntrySessionDeliveryOutcomeV1 {
    return plan.kind === 'withoutInput' ? plan.outcome : result.initialInput.status;
}

/**
 * Retries exactly the phase that failed, and nothing earlier.
 *
 * A pending link retries the idempotent link, delivers if admission has not
 * settled and then opens; a pending open likewise asks admission only when no
 * settled verdict was retained, then re-invokes `session.open` with the same
 * stable id. Neither respawns, rematerializes, reseeds a draft or mints a second
 * identity for one press. An ambiguous atomic first input is represented as a
 * creation retry by the caller, because its identity belongs to spawn rather
 * than `session.message.send`.
 *
 * The re-delivery is safe by construction rather than by a remembered verdict:
 * the same key rejoins the same durable input, so an accepted send answers
 * `alreadyAccepted` and an unknown one settles. Keeping a per-phase memory of
 * what admission last said, only to decide whether to ask again, would be state
 * this path does not need.
 */
export async function resumeEntrySessionStart(
    deps: TriageEntrySessionDepsV1,
    input: Readonly<{
        entryRef: TriageEntryRefV1;
        display: TriageEntrySessionLinkDisplayV1;
        pending: TriageEntrySessionPendingPhaseV1;
        delivery?: TriageEntrySessionDeliveryRequestV1;
        finalOpen?: TriageEntrySessionFinalOpenV1;
    }>,
): Promise<TriageEntrySessionStartResultV1> {
    const pending = input.pending;
    const delivery = input.delivery;
    if (pending.type === 'creationPending') {
        const spawnDelivery = planSpawnDelivery(delivery);
        const result = await deps.execute(
            'session.spawn_new',
            {
                ...withoutProhibitedSpawnMembers(pending.spawn),
                directory: pending.directory,
                creationKey: pending.creationKey,
                ...(spawnDelivery.kind === 'withInput'
                    ? { initialInput: spawnDelivery.initialInput }
                    : {}),
            },
            deps.signal ? { signal: deps.signal } : undefined,
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
                creationKey: pending.creationKey,
                workspace: pending.workspace,
            };
        }
        return await linkDeliverThenOpen(deps, {
            entryRef: input.entryRef,
            display: input.display,
            sessionId: result.sessionId,
            disposition: result.disposition,
            workspace: pending.workspace,
            ...(delivery === undefined
                ? {}
                : { settledDelivery: settledSpawnDelivery(spawnDelivery, result) }),
            ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
        });
    }
    if (pending.type === 'linkPending') {
        return await linkDeliverThenOpen(deps, {
            entryRef: input.entryRef,
            display: input.display,
            sessionId: pending.sessionId,
            disposition: pending.disposition,
            workspace: pending.workspace,
            ...(pending.settledDelivery === undefined
                ? delivery === undefined ? {} : { delivery }
                : { settledDelivery: pending.settledDelivery }),
            ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
        });
    }
    const delivered: TriageEntrySessionDeliveryOutcomeV1 = pending.settledDelivery
        ?? (delivery === undefined
            ? 'notRequested'
            : await deliverEntrySessionInput({
                execute: deps.execute,
                sessionId: pending.sessionId,
                delivery,
                ...(deps.signal ? { signal: deps.signal } : {}),
            }));
    const opened = await openLinkedSession({
        execute: deps.execute,
        sessionId: pending.sessionId,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        type: opened.status === 'opened' ? 'opened' : 'openPending',
        sessionId: pending.sessionId,
        disposition: pending.disposition,
        workspace: pending.workspace,
        delivery: delivered,
    };
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
 * Reusing an EXISTING Session stays a reference-only affair: a start that
 * carries a workspace has a directory to create, and an existing Session
 * already has one. So there is still no existing-workspace comparison, no path
 * normalization and no mutate-before-agreement path, and an error entry still
 * cannot turn a stack frame, URL or source identity into a checkout.
 */
function rejectionFor(
    request: TriageEntrySessionStartRequestV1,
): TriageEntrySessionRejectionReasonV1 | null {
    const destination = request.destination;
    if (destination.kind === 'existing') {
        return request.workspaceMode === 'reference_only'
            ? null
            : 'existingSessionRequiresReferenceOnlyMode';
    }
    const required = TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1[request.workspaceMode];
    if (destination.materialization.kind !== required) {
        return MODE_MISMATCH_REJECTION_V1[request.workspaceMode];
    }
    if (destination.materialization.kind === 'reviewWorkspace'
        && !sameTriageEntryReference(
            request.entryRef,
            destination.materialization.request.entryRef,
        )) {
        return 'pullRequestWorkspaceEntryMismatch';
    }
    return null;
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
    request: TriageEntrySessionStartRequestV1,
): Promise<TriageEntrySessionStartResultV1> {
    const rejection = rejectionFor(request);
    if (rejection) return { type: 'rejected', reason: rejection };

    const destination = request.destination;
    if (destination.kind === 'existing') {
        return await linkDeliverThenOpen(deps, {
            entryRef: request.entryRef,
            display: request.display,
            sessionId: destination.sessionId,
            disposition: 'existing',
            workspace: { kind: 'referenceOnly' },
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
    const spawnDelivery = planSpawnDelivery(request.delivery);
    const spawnInput: SessionSpawnInput = {
        ...withoutProhibitedSpawnMembers(destination.spawn),
        directory: materializationDirectory(resolved.materialization),
        creationKey: destination.creationKey,
        ...(spawnDelivery.kind === 'withInput'
            ? { initialInput: spawnDelivery.initialInput }
            : {}),
    };
    const result = await deps.execute(
        'session.spawn_new',
        spawnInput,
        deps.signal ? { signal: deps.signal } : undefined,
    );
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
        return { type: 'creationFailed', creationKey: destination.creationKey, workspace };
    }
    return await linkDeliverThenOpen(deps, {
        entryRef: request.entryRef,
        display: request.display,
        sessionId: result.sessionId,
        disposition: result.disposition,
        workspace,
        ...(request.delivery === undefined
            ? {}
            : { settledDelivery: settledSpawnDelivery(spawnDelivery, result) }),
        ...(request.finalOpen === undefined ? {} : { finalOpen: request.finalOpen }),
    });
}
