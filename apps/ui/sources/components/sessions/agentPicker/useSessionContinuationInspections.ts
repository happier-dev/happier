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
}>;

export type SessionContinuationInspections = Readonly<{
    /** This target's state; `checking` until this connection has an answer for it. */
    read: (agentId: string) => SessionAgentContinuationInspectionState;
    /**
     * The composer's Agent picker opened or closed. Inspection is demand-driven:
     * a Session the user never asks to switch costs its machine nothing.
     */
    setDemand: (demanded: boolean) => void;
}>;

/**
 * Live `session.continuation.inspect` answers for the targets one picker can offer.
 *
 * Three properties are deliberate.
 *
 * **Demand-driven.** Every answer is per target, so a Session with several enabled
 * Agents would otherwise cost one machine round trip per Agent on every open. The
 * picker asks; merely viewing a Session does not.
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
    const { machine, machinePresence, sessionId, targetAgentIds } = params;
    const [demanded, setDemanded] = React.useState(false);
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
    ].join(' ');
    const scopeRef = React.useRef<Readonly<{ key: string; asked: Set<string> }>>(
        { key: scopeKey, asked: new Set() },
    );
    if (scopeRef.current.key !== scopeKey) {
        scopeRef.current = { key: scopeKey, asked: new Set() };
        if (answers.size > 0) setAnswers(new Map());
    }

    const targetAgentIdsRef = React.useRef(targetAgentIds);
    targetAgentIdsRef.current = targetAgentIds;
    const targetsKey = targetAgentIds.join(' ');

    React.useEffect(() => {
        if (!demanded || offline || !machineId) return;
        const scope = scopeRef.current;
        const pending = targetAgentIdsRef.current.filter((agentId) => !scope.asked.has(agentId));
        if (pending.length === 0) return;
        // Claim before awaiting so a re-render mid-flight cannot ask twice.
        for (const agentId of pending) scope.asked.add(agentId);

        // No cancellation on cleanup: closing the picker mid-flight must still
        // record the answer, or the claim above would strand the row on
        // "checking" for the rest of the connection.
        void Promise.all(pending.map(async (agentId) => ({
            agentId,
            result: await inspectSessionContinuationOnMachine({
                machineId,
                serverId,
                sessionId,
                selection: { v: 1, agentId },
            }).catch((): SessionAgentContinuationInspectionState => INDETERMINATE),
        }))).then((settled) => {
            // An answer read over a connection or machine state that no longer
            // applies is discarded rather than shown.
            if (scopeRef.current !== scope) return;
            setAnswers((current) => {
                const next = new Map(current);
                for (const { agentId, result } of settled) next.set(agentId, result);
                return next;
            });
        });
    }, [demanded, machineId, offline, scopeKey, serverId, sessionId, targetsKey]);

    const read = React.useCallback((agentId: string): SessionAgentContinuationInspectionState => {
        if (offline) return MACHINE_UNREACHABLE;
        // No machine to address is not proof the daemon is old, and the Session's
        // machine may still be resolving.
        if (!machineId) return CHECKING;
        return answers.get(agentId) ?? CHECKING;
    }, [answers, machineId, offline]);

    return { read, setDemand: setDemanded };
}
