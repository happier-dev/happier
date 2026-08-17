import {
    SessionContinuationInspectionRequestV1Schema,
    SessionContinuationInspectionV1Schema,
    type SessionAgentTransitionSelectionV1,
    type SessionContinuationInspectionV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

/**
 * `session.continuation.inspect` as the UI can honestly report it.
 *
 * The daemon's own union already carries `operation_unavailable`, which the
 * transport produces both for a daemon that predates the operation and for a
 * machine it cannot reach. Presence splits those two at the protocol's
 * presentation owner. But a timeout, an aborted call, a broken socket or a
 * response this client cannot parse prove NEITHER: reporting them as
 * `operation_unavailable` would make an online machine read as "update the CLI",
 * which is a false instruction. They resolve to `indeterminate` instead, and the
 * picker says so.
 */
export type SessionContinuationInspectionQueryV1 =
    /** The machine answered — including its own typed `unavailable` reasons. */
    | Readonly<{ status: 'answered'; inspection: SessionContinuationInspectionV1 }>
    /** The call failed for a reason that establishes nothing about the daemon. */
    | Readonly<{ status: 'indeterminate' }>;

const OPERATION_UNAVAILABLE: SessionContinuationInspectionQueryV1 = {
    status: 'answered',
    inspection: { type: 'unavailable', reason: 'operation_unavailable' },
};

export type InspectSessionContinuationOnMachineInput = Readonly<{
    /** The machine hosting the Session. Inspection is only meaningful there. */
    machineId: string;
    serverId: string | null;
    sessionId: string;
    selection: SessionAgentTransitionSelectionV1;
}>;

/**
 * Reads live continuation eligibility for one exact target on the machine that
 * hosts the Session. It grants no authority and writes nothing: the transition
 * mutation re-proves every fact, so a stale answer can only mislead a label.
 */
export async function inspectSessionContinuationOnMachine(
    input: InspectSessionContinuationOnMachineInput,
): Promise<SessionContinuationInspectionQueryV1> {
    const payload = SessionContinuationInspectionRequestV1Schema.parse({
        v: 1,
        sourceSessionId: input.sessionId,
        selection: input.selection,
    });
    let raw: unknown;
    try {
        raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.SESSION_CONTINUATION_INSPECT,
            payload,
        });
    } catch (error) {
        return readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            ? OPERATION_UNAVAILABLE
            : { status: 'indeterminate' };
    }
    const parsed = SessionContinuationInspectionV1Schema.safeParse(raw);
    // A daemon that answered with a shape this client cannot read is not an old
    // daemon and is not offline. Say nothing rather than say the wrong thing.
    return parsed.success ? { status: 'answered', inspection: parsed.data } : { status: 'indeterminate' };
}
