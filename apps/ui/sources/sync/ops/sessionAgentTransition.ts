import {
    SessionAgentTransitionRequestV1Schema,
    SessionAgentTransitionResultV1Schema,
    beginSessionAgentTransitionEffects,
    rejectUndispatchedSessionAgentTransition,
    type SessionAgentTransitionRequestV1,
    type SessionAgentTransitionResultV1,
} from '@happier-dev/protocol';
import {
    RPC_ERROR_CODES,
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

/**
 * `session.agentTransition` as the UI can honestly report it.
 *
 * The daemon's result union already partitions every outcome by how far the
 * transition got, and each arm authorizes a different recovery. A transport
 * failure has to land inside that same union rather than beside it, because a
 * client that invents a second failure vocabulary immediately loses the one
 * property the union exists to preserve: whether the source runtime was
 * touched.
 *
 * Only two transport outcomes are distinguishable here:
 *
 * - `METHOD_NOT_AVAILABLE` proves the daemon has no such handler, so nothing
 *   ran. That is exactly `rejected` / `unsupported_operation`, the arm whose
 *   `sourceEffect: 'none'` promise is truthful.
 * - Everything else — timeout, aborted call, broken socket, a response this
 *   client cannot parse — proves nothing at all. The request may have been
 *   delivered and applied. That is `outcome_unknown`, and it must never be
 *   reported as a rejection that claims an untouched source.
 */

export type RunSessionAgentTransitionInput = Readonly<{
    /** The machine hosting the Session. The transition only runs there. */
    machineId: string;
    serverId: string | null;
    request: SessionAgentTransitionRequestV1;
}>;

export async function runSessionAgentTransitionOnMachine(
    input: RunSessionAgentTransitionInput,
): Promise<SessionAgentTransitionResultV1> {
    const payload = SessionAgentTransitionRequestV1Schema.parse(input.request);
    const localId = payload.input.localId;
    // Nothing here can advance the transition's effect depth — this side only
    // ever observes the daemon's answer, or fails to get one — so the client
    // holds the untouched stage for its whole life and builds every arm from
    // it. Reaching for a literal would be the one way this file could invent an
    // arm the daemon's own stages forbid.
    const effects = beginSessionAgentTransitionEffects({ localId });
    let raw: unknown;
    try {
        raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.SESSION_AGENT_TRANSITION,
            payload,
            // `session.agentTransition` is a canonical Session-write, so it
            // carries the same edit proof every sibling Session-write machine
            // RPC carries. The server rejects a classified call with no
            // envelope before it resolves a target, and the daemon rejects one
            // whose envelope names a Session other than the decrypted payload's
            // — so the envelope has to be built from the PARSED payload, not
            // the caller's unnormalized request.
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: payload.sessionId,
            },
        });
    } catch (error) {
        return readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            ? rejectUndispatchedSessionAgentTransition('unsupported_operation')
            : effects.outcomeUnknown();
    }
    const parsed = SessionAgentTransitionResultV1Schema.safeParse(raw);
    // A daemon that answered with a shape this client cannot read may well have
    // switched the Session. Claiming a no-effect rejection here would hand the
    // reader Keep editing in front of a Session that already moved.
    return parsed.success ? parsed.data : effects.outcomeUnknown();
}
