import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type {
    TriageEntryRefV1,
    TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    linkEntryToSession,
    type TriageCardPublicationIdMintV1,
    type TriageEntrySessionLinkDisplayV1,
} from './entrySessionLinks.js';
import { openLinkedSession, type TriageSessionActionInvokerV1 } from './entrySessionOpen.js';
import {
    materializationDirectory,
    materializationWorkspaceFacts,
    resolveEntrySessionWorkspace,
    TRIAGE_WORKSPACE_PREPARATION_REFUSED_V1,
    type TriageEntrySessionWorkspaceFactsV1,
    type TriageResolvedMaterializationV1,
    type TriageReviewWorkspacePreparationDepsV1,
    type TriageWorkspaceMaterializationV1,
    type TriageWorkspacePreparationFailureV1,
} from './entrySessionWorkspace.js';

export type {
    TriageEntrySessionWorkspaceFactsV1,
    TriageResolvedMaterializationV1,
    TriageReviewWorkspacePreparationRequestV1,
    TriageWorkspaceMaterializationV1,
    TriageWorkspacePreparationFailureV1,
} from './entrySessionWorkspace.js';
export type { TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';

type SessionSpawnInput = PluginActionInputById['session.spawn_new'];

/**
 * The generic spawn members a Triage start may choose, and no others.
 *
 * `creationKey` and `directory` are owned here so one start has exactly one
 * identity and one working directory. The rest are structurally absent because
 * a Triage start is routing, not model context: the selected entry's title,
 * body, facts and provider prose never reach a Session record, an initial
 * input or a prompt, and the workspace decision belongs to the source-owned
 * preparation rather than a second checkout draft on the creation call.
 */
const PROHIBITED_SPAWN_MEMBERS = [
    'initialMessage',
    'title',
    'agentSessionStartupInstructionsV1',
    'checkoutCreationDraft',
] as const;

export type TriageSessionSpawnRequestV1 = Omit<
    SessionSpawnInput,
    'creationKey' | 'directory' | (typeof PROHIBITED_SPAWN_MEMBERS)[number]
>;

/**
 * Strips the prohibited members even when a caller carried them in an
 * unnarrowed value. The type says a Triage start cannot seed prose or a second
 * workspace; this makes the running code say it too.
 */
function withoutProhibitedSpawnMembers(
    spawn: TriageSessionSpawnRequestV1,
): TriageSessionSpawnRequestV1 {
    const candidate: Record<string, unknown> = { ...spawn };
    for (const member of PROHIBITED_SPAWN_MEMBERS) delete candidate[member];
    return candidate as TriageSessionSpawnRequestV1;
}

export type TriageEntrySessionIntentV1 = 'ask' | 'fix';

export type TriageEntrySessionDestinationV1 =
    | Readonly<{ kind: 'existing'; sessionId: SessionId }>
    | Readonly<{
        kind: 'new';
        creationKey: string;
        spawn: TriageSessionSpawnRequestV1;
        materialization: TriageWorkspaceMaterializationV1;
    }>;

export type TriageEntrySessionStartRequestV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    /**
     * The entry as the caller's device-local projection rendered it. The link
     * freezes a display path from it; nothing durable holds one to read.
     */
    display: TriageEntrySessionLinkDisplayV1;
    workflowSubject: TriageSourceWorkflowSubjectV1;
    intent: TriageEntrySessionIntentV1;
    destination: TriageEntrySessionDestinationV1;
}>;

export type TriageEntrySessionRejectionReasonV1 =
    | 'existingSessionNotOfferedForFix'
    | 'askUsesReferenceOnly'
    | 'pullRequestFixRequiresPreparedWorkspace'
    | 'nonPullRequestFixRequiresSelectedProject';

export type TriageEntrySessionDispositionV1 = 'created' | 'rejoined' | 'existing';

export type TriageEntrySessionStartResultV1 =
    | Readonly<{
        type: 'opened';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'linkPending';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>
    | Readonly<{
        type: 'openPending';
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
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
    mintCardPublicationId?: TriageCardPublicationIdMintV1;
    signal?: AbortSignal;
}>;

async function linkThenOpen(
    deps: TriageEntrySessionDepsV1,
    input: Readonly<{
        entryRef: TriageEntryRefV1;
        display: TriageEntrySessionLinkDisplayV1;
        sessionId: SessionId;
        disposition: TriageEntrySessionDispositionV1;
        workspace: TriageEntrySessionWorkspaceFactsV1;
    }>,
): Promise<TriageEntrySessionStartResultV1> {
    const link = await linkEntryToSession({
        collections: deps.collections,
        entryRef: input.entryRef,
        display: input.display,
        sessionId: input.sessionId,
        nowMs: deps.nowMs,
        ...(deps.mintCardPublicationId ? { mintCardPublicationId: deps.mintCardPublicationId } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (link.status !== 'linked') {
        return {
            type: 'linkPending',
            sessionId: input.sessionId,
            disposition: input.disposition,
            workspace: input.workspace,
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
    };
}

export type TriageEntrySessionPendingPhaseV1 = Extract<
    TriageEntrySessionStartResultV1,
    Readonly<{ type: 'linkPending' | 'openPending' }>
>;

/**
 * Retries exactly the phase that failed, and nothing earlier.
 *
 * A pending link retries the idempotent link and then opens; a pending open
 * re-invokes only `session.open` with the same stable id. Neither respawns,
 * rematerializes, reseeds a draft or calls Composer.
 */
export async function resumeEntrySessionStart(
    deps: TriageEntrySessionDepsV1,
    input: Readonly<{
        entryRef: TriageEntryRefV1;
        display: TriageEntrySessionLinkDisplayV1;
        pending: TriageEntrySessionPendingPhaseV1;
    }>,
): Promise<TriageEntrySessionStartResultV1> {
    const pending = input.pending;
    if (pending.type === 'linkPending') {
        return await linkThenOpen(deps, {
            entryRef: input.entryRef,
            display: input.display,
            sessionId: pending.sessionId,
            disposition: pending.disposition,
            workspace: pending.workspace,
        });
    }
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
    };
}

/**
 * The one intent-and-subject gate, evaluated before any provider, creator, link
 * or navigation call.
 *
 * V1 deliberately makes every Fix a new-Session flow, so there is no
 * existing-workspace comparison, no path normalization and no
 * mutate-before-agreement path. Ask is the only intent that may reuse an
 * existing Session, and it never materializes a workspace: an error entry
 * therefore cannot turn a stack frame, URL or source identity into a checkout,
 * and a pull-request Fix cannot start from a guessed directory.
 */
function rejectionFor(
    request: TriageEntrySessionStartRequestV1,
): TriageEntrySessionRejectionReasonV1 | null {
    const destination = request.destination;
    if (destination.kind === 'existing') {
        return request.intent === 'fix' ? 'existingSessionNotOfferedForFix' : null;
    }
    const materialization = destination.materialization.kind;
    if (request.intent === 'ask') {
        return materialization === 'referenceOnly' ? null : 'askUsesReferenceOnly';
    }
    if (request.workflowSubject === 'pullRequest') {
        return materialization === 'reviewWorkspace'
            ? null
            : 'pullRequestFixRequiresPreparedWorkspace';
    }
    return materialization === 'selectedProject'
        ? null
        : 'nonPullRequestFixRequiresSelectedProject';
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
        return await linkThenOpen(deps, {
            entryRef: request.entryRef,
            display: request.display,
            sessionId: destination.sessionId,
            disposition: 'existing',
            workspace: { kind: 'referenceOnly' },
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
        ...withoutProhibitedSpawnMembers(destination.spawn),
        directory: materializationDirectory(resolved.materialization),
        creationKey: destination.creationKey,
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
    return await linkThenOpen(deps, {
        entryRef: request.entryRef,
        display: request.display,
        sessionId: result.sessionId,
        disposition: result.disposition,
        workspace,
    });
}
