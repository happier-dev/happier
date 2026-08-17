import * as React from 'react';

import type { SessionContinuationMachinePresenceV1 } from '@happier-dev/protocol';

import { inspectSessionContinuationOnMachine } from '@/sync/ops/sessionContinuationInspection';

import type {
    SessionAgentContinuationInspectionState,
    SessionAgentContinuationMachineTarget,
} from './resolveSessionAgentContinuationEligibility';

const CHECKING: SessionAgentContinuationInspectionState = { status: 'checking' };
const INDETERMINATE: SessionAgentContinuationInspectionState = { status: 'indeterminate' };
const MACHINE_UNREACHABLE: SessionAgentContinuationInspectionState = {
    status: 'answered',
    inspection: { type: 'unavailable', reason: 'operation_unavailable' },
};

type UseSessionContinuationInspectionsParams = Readonly<{
    sessionId: string;
    machine: SessionAgentContinuationMachineTarget;
    machinePresence: SessionContinuationMachinePresenceV1;
    /** The exact targets the picker can offer, so nothing else is ever asked about. */
    targetAgentIds: readonly string[];
    /**
     * Whether this Session wants live answers at all. The caller decides; a
     * Session whose picker could never offer a switch passes `false` and its
     * machine is asked nothing.
     */
    demanded: boolean;
}>;

export type SessionContinuationInspections = Readonly<{
    /** This target's state; `checking` until this connection has an answer for it. */
    read: (agentId: string) => SessionAgentContinuationInspectionState;
}>;

/**
 * Live `session.continuation.inspect` answers for the targets one picker can offer.
 *
 * Three properties are deliberate.
 *
 * **Asked only where a switch is possible.** Every answer is per target, so the
 * caller narrows the question to the Sessions whose picker could actually offer
 * one: a closed gate, a read-only or external Session, an offline machine or a
 * Session with no other Agent asks nothing at all.
 *
 * **One connection, one answer.** Answers are cached against the realtime
 * connection and machine state they were read over, and discarded when either
 * changes, because inspection reserves nothing and re-reading is the only way it
 * stays true. Caching also matters for a negative: the machine RPC already retries
 * once on `METHOD_NOT_AVAILABLE`, so an old daemon costs two round trips per ask.
 *
 * **Never asks a machine known to be offline.** That answer is already held, and
 * waiting out a transport timeout to rediscover it would leave the row reading
 * "checking" for no reason.
 */
export function useSessionContinuationInspections(
    params: UseSessionContinuationInspectionsParams,
): SessionContinuationInspections {
    const { demanded, machine, machinePresence, sessionId, targetAgentIds } = params;
    const [answers, setAnswers] = React.useState<
        ReadonlyMap<string, SessionAgentContinuationInspectionState>
    >(() => new Map());

    const machineId = machine.machineId;
    const serverId = machine.serverId;
    const offline = machinePresence === 'offline';
    // Everything an answer is only valid within. Session and machine are obvious;
    // the generation makes a reconnect re-ask, and presence makes a machine that
    // bounced re-ask rather than trust what its previous daemon said.
    const scopeKey = [
        sessionId,
        machineId ?? '',
        serverId ?? '',
        machine.connectionGeneration ?? '',
        machinePresence,
    ].join('\u0000');
    const scopeRef = React.useRef<Readonly<{ key: string; asked: Set<string> }>>(
        { key: scopeKey, asked: new Set() },
    );
    if (scopeRef.current.key !== scopeKey) {
        scopeRef.current = { key: scopeKey, asked: new Set() };
        if (answers.size > 0) setAnswers(new Map());
    }

    const targetAgentIdsRef = React.useRef(targetAgentIds);
    targetAgentIdsRef.current = targetAgentIds;
    const targetsKey = targetAgentIds.join('\u0000');

    React.useEffect(() => {
        if (!demanded || offline || !machineId) return;
        const scope = scopeRef.current;
        const pending = targetAgentIdsRef.current.filter((agentId) => !scope.asked.has(agentId));
        if (pending.length === 0) return;
        // Claim before awaiting so a re-render mid-flight cannot ask twice.
        for (const agentId of pending) scope.asked.add(agentId);

        // Each answer is recorded on arrival rather than gathered into one batch.
        // A batch is only as fast as its slowest target, and the rail decision now
        // waits on these answers, so one target running out its transport timeout
        // would hold every other target's answer — and the rail — behind it for the
        // whole of that timeout.
        //
        // No cancellation on cleanup: closing the picker mid-flight must still
        // record the answer, or the claim above would strand the row on
        // "checking" for the rest of the connection.
        for (const agentId of pending) {
            void inspectSessionContinuationOnMachine({
                machineId,
                serverId,
                sessionId,
                selection: { v: 1, agentId },
            })
                .catch((): SessionAgentContinuationInspectionState => INDETERMINATE)
                .then((result) => {
                    // An answer read over a connection or machine state that no
                    // longer applies is discarded rather than shown.
                    if (scopeRef.current !== scope) return;
                    setAnswers((current) => {
                        const next = new Map(current);
                        next.set(agentId, result);
                        return next;
                    });
                });
        }
    }, [demanded, machineId, offline, scopeKey, serverId, sessionId, targetsKey]);

    const read = React.useCallback((agentId: string): SessionAgentContinuationInspectionState => {
        if (offline) return MACHINE_UNREACHABLE;
        // No machine to address is not proof the daemon is old, and the Session's
        // machine may still be resolving.
        if (!machineId) return CHECKING;
        return answers.get(agentId) ?? CHECKING;
    }, [answers, machineId, offline]);

    return { read };
}
