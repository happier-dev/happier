import {
    resolveSessionContinuationUnavailablePresentationV1,
    type SessionContinuationMachinePresenceV1,
    type SessionContinuationUnavailablePresentationV1,
} from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import type { SessionContinuationInspectionQueryV1 } from '@/sync/ops/sessionContinuationInspection';

/**
 * A fact about this Session that no Agent row can change, decided before any
 * target is considered and without asking the machine anything.
 *
 * These are the reasons a surface states once for the whole Session rather than
 * once per Agent — repeating one Session fact down a rail of Agents reads as a
 * property of each Agent, which it is not.
 */
export type SessionAgentContinuationSessionReason =
    /** The reader cannot send in this Session at all. */
    | 'read_only'
    /**
     * The transcript is owned by the Agent's own store rather than by Happier, so
     * there is no Happier conversation for another Agent to continue.
     */
    | 'external_session';

/**
 * Why this Session, rather than the machine, or one exact target, cannot continue
 * with another Agent. Machine and daemon availability is not modelled here: that
 * branch belongs to the protocol's continuation-presentation owner.
 */
export type SessionAgentContinuationLocalReason =
    | SessionAgentContinuationSessionReason
    /** The target's create/resume/context contract is not proven for in-place continuation. */
    | 'target_not_proven';

/**
 * What the machine has said about one exact target so far.
 *
 * `checking` is not a failure and must never be presented as one: it means the
 * question is still in flight. `indeterminate` is the honest arm for a call that
 * failed without establishing anything — see
 * {@link SessionContinuationInspectionQueryV1}.
 */
export type SessionAgentContinuationInspectionState =
    | Readonly<{ status: 'checking' }>
    | SessionContinuationInspectionQueryV1;

export type SessionAgentContinuationEligibility =
    | Readonly<{ status: 'current' }>
    | Readonly<{ status: 'eligible' }>
    | Readonly<{ status: 'checking' }>
    | Readonly<{ status: 'unavailable'; kind: 'local'; reason: SessionAgentContinuationLocalReason }>
    | Readonly<{
        status: 'unavailable';
        kind: 'continuation';
        presentation: SessionContinuationUnavailablePresentationV1;
    }>;

export type SessionAgentContinuationSourceState = Readonly<{
    /** The catalog target key of the Agent currently running this Session. */
    currentBackendTargetKey: string | null;
    /**
     * Where this Session's transcript actually lives, read from the canonical
     * Session-scoped owner at `sync/domains/session/sessionStorageKind`.
     *
     * This is a fact about the Session, not about its Agent. The Agent-level
     * `sessionStorage.direct` capability answers a different question — whether an
     * Agent is *able* to own its own store — and Claude Code and Codex both declare
     * it, so reading that capability here would block every ordinary Session.
     */
    storageKind: SessionStorageKind;
    canEditSession: boolean;
    machinePresence: SessionContinuationMachinePresenceV1;
    /**
     * Whether this Session has a transcript for a switch to carry across.
     *
     * The switch is offered either way — a Session with nothing yet is exactly
     * where changing Agent is cheapest — but the disclosure that reassures a
     * reader mid-thread is a claim, and on an empty transcript it is a false one.
     */
    hasConversationToCarry: boolean;
}>;

/**
 * Where `session.continuation.inspect` has to be asked, and how long an answer
 * may be trusted.
 *
 * Inspection is only meaningful on the machine hosting the Session, and it grants
 * no authority, so an answer is only as good as the pair of runtimes it was read
 * across. Either generation moving discards every answer read before it.
 */
export type SessionAgentContinuationMachineTarget = Readonly<{
    machineId: string | null;
    serverId: string | null;
    /**
     * This client's realtime connection. It changes when the connection is
     * re-established.
     */
    connectionGeneration: number | null;
    /**
     * The machine's daemon, as the machine record already reports it.
     *
     * The two generations are independent, and only this one moves when the
     * daemon restarts under a live connection — the window in which the rail kept
     * advertising targets the send path then refused as `unsupported_operation`,
     * because the answers it was showing came from a daemon that no longer
     * existed. This is the same daemon-currentness fact CLI detection keys its own
     * cache on, not a second notion of it.
     */
    daemonGeneration: number | null;
}>;

/**
 * The one owner of "can this Session continue with another Agent at all", asked
 * without naming a target.
 *
 * Both callers consume this single decision: the row resolver below, so a blocked
 * Session never reaches target-specific reasoning, and the picker itself, so it can
 * state the fact once instead of offering a rail of identically dead Agents.
 */
export function resolveSessionAgentContinuationSessionReason(
    source: SessionAgentContinuationSourceState,
): SessionAgentContinuationSessionReason | null {
    if (!source.canEditSession) return 'read_only';
    if (source.storageKind === 'direct') return 'external_session';
    return null;
}

/** Called only once the target's question has actually been answered or given up on. */
function resolveContinuationAvailability(
    inspection: SessionContinuationInspectionQueryV1,
    machinePresence: SessionContinuationMachinePresenceV1,
): SessionContinuationUnavailablePresentationV1 | null {
    if (inspection.status === 'indeterminate') {
        // The call did not complete, which is evidence of nothing. Telling an
        // online machine's owner to update the CLI would be a false instruction,
        // so only the openly ambiguous presentation is truthful here.
        return 'update_or_reconnect';
    }
    const answer = inspection.inspection;
    if (answer.type === 'unavailable') {
        // The transport collapses "daemon predates the operation" and "machine
        // unreachable" into one outcome; the shared owner splits them using presence.
        return resolveSessionContinuationUnavailablePresentationV1({
            reason: answer.reason,
            machinePresence,
        });
    }
    if (!answer.sameSessionTransition) {
        return resolveSessionContinuationUnavailablePresentationV1({
            reason: 'unsupported_session',
            machinePresence,
        });
    }
    return null;
}

/**
 * Decides how one Agent catalog row behaves inside a live Session.
 *
 * The order matters: facts about this Session come before facts about the target,
 * so a reader without edit access is told that once instead of once per Agent —
 * and a locally blocked row never flickers through a pointless "checking" state.
 * The current Agent always stays selectable — its row is where model and
 * configuration are edited — but it never arms a continuation.
 */
export function resolveSessionAgentContinuationEligibility(params: Readonly<{
    entry: ResolvedBackendCatalogEntry;
    source: SessionAgentContinuationSourceState;
    /** This exact target's live inspection state on the Session's machine. */
    inspection: SessionAgentContinuationInspectionState;
}>): SessionAgentContinuationEligibility {
    const { entry, inspection, source } = params;

    if (source.currentBackendTargetKey !== null && entry.targetKey === source.currentBackendTargetKey) {
        return { status: 'current' };
    }

    const sessionReason = resolveSessionAgentContinuationSessionReason(source);
    if (sessionReason !== null) {
        return { status: 'unavailable', kind: 'local', reason: sessionReason };
    }
    // Configured ACP backends stay visible so the catalog reads the same everywhere,
    // but in-place continuation waits until their create/resume/context contract is
    // proven rather than failing at send time.
    if (entry.family !== 'builtInAgent') {
        return { status: 'unavailable', kind: 'local', reason: 'target_not_proven' };
    }

    if (inspection.status === 'checking') {
        return { status: 'checking' };
    }

    const continuationUnavailable = resolveContinuationAvailability(inspection, source.machinePresence);
    if (continuationUnavailable !== null) {
        return { status: 'unavailable', kind: 'continuation', presentation: continuationUnavailable };
    }

    return { status: 'eligible' };
}
