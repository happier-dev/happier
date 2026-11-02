import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type {
    SessionAgentTransitionSelectionV1,
    SessionContinuationMachinePresenceV1,
} from '@happier-dev/protocol';

import { inspectSessionContinuationsOnMachine } from '@/sync/ops/sessionContinuationInspection';

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
    targetSelections: readonly SessionAgentTransitionSelectionV1[];
    /**
     * Whether the picker is open and can offer a switch. Hidden layout/host
     * presentation further suspends reads without discarding settled answers.
     */
    demanded: boolean;
}>;

export type SessionContinuationInspections = Readonly<{
    /** This exact target's state; `checking` until this connection has an answer for it. */
    read: (selection: SessionAgentTransitionSelectionV1) => SessionAgentContinuationInspectionState;
}>;

function selectionKey(selection: SessionAgentTransitionSelectionV1): string {
    return JSON.stringify(selection);
}

/**
 * Live `session.continuation.inspect` answers for the targets one picker can offer.
 *
 * Three properties are deliberate.
 *
 * **Asked only by an open, visible picker.** The caller supplies exactly its
 * eligible targets; hidden layouts/hosts suspend its reads.
 *
 * **One runtime pair, one answer.** Answers are cached against the realtime
 * connection, the daemon generation, and the machine state they were read over,
 * and discarded when any of them changes, because inspection reserves nothing and
 * re-reading is the only way it stays true. Caching also matters for a negative:
 * the machine RPC already retries once on `METHOD_NOT_AVAILABLE`, so an old daemon
 * costs two round trips per ask.
 *
 * **Never asks a machine known to be offline.** That answer is already held, and
 * waiting out a transport timeout to rediscover it would leave the row reading
 * "checking" for no reason.
 */
export function useSessionContinuationInspections(
    params: UseSessionContinuationInspectionsParams,
): SessionContinuationInspections {
    const { machine, machinePresence, sessionId, targetSelections } = params;
    const presented = useLayoutPresentationActive();
    const hostViewed = useHostActivelyViewed();
    const demanded = params.demanded && presented && hostViewed;
    const [answers, setAnswers] = React.useState<
        ReadonlyMap<string, SessionAgentContinuationInspectionState>
    >(() => new Map());

    const machineId = machine.machineId;
    const serverId = machine.serverId;
    const offline = machinePresence === 'offline';
    // Everything an answer is only valid within. Session and machine are obvious;
    // the connection generation makes a reconnect re-ask, the daemon generation
    // makes a daemon that restarted under a live connection re-ask, and presence
    // makes a machine that bounced re-ask rather than trust what its previous
    // daemon said. Both generations are load-bearing: a restarting daemon never
    // disturbs this client's socket, so the connection generation alone leaves
    // the rail advertising an answer nothing on the machine still stands behind.
    const scopeKey = [
        sessionId,
        machineId ?? '',
        serverId ?? '',
        machine.connectionGeneration ?? '',
        machine.daemonGeneration ?? '',
        machinePresence,
    ].join('\u0000');
    const scopeRef = React.useRef<Readonly<{ key: string; asked: Set<string> }>>(
        { key: scopeKey, asked: new Set() },
    );
    if (scopeRef.current.key !== scopeKey) {
        scopeRef.current = { key: scopeKey, asked: new Set() };
        if (answers.size > 0) setAnswers(new Map());
    }

    const targetSelectionsRef = React.useRef(targetSelections);
    targetSelectionsRef.current = targetSelections;
    const targetsKey = targetSelections.map(selectionKey).join('\u0000');

    React.useEffect(() => {
        if (!demanded || offline || !machineId) return;
        const scope = scopeRef.current;
        const pending = targetSelectionsRef.current.filter((selection) => !scope.asked.has(selectionKey(selection)));
        if (pending.length === 0) return;
        // Claim before awaiting so a re-render mid-flight cannot ask twice.
        for (const selection of pending) scope.asked.add(selectionKey(selection));
        const controller = new AbortController();
        let completed = false;

        // The daemon reads and decrypts the source Session once, then evaluates
        // every target against that canonical source. Publishing the ordered
        // result once also prevents one picker recomputation per Agent row. The
        // adapter falls back to the single-target RPC only for an older daemon.
        //
        void inspectSessionContinuationsOnMachine({
                machineId,
                serverId,
                sessionId,
                selections: pending,
                signal: controller.signal,
            })
                .catch(() => pending.map(() => INDETERMINATE))
                .then((results) => {
                    if (controller.signal.aborted || scopeRef.current !== scope) return;
                    completed = true;
                    setAnswers((current) => {
                        const next = new Map(current);
                        pending.forEach((selection, index) => {
                            next.set(selectionKey(selection), results[index] ?? INDETERMINATE);
                        });
                        return next;
                    });
                });
        return () => {
            controller.abort();
            // A cancelled read supplied no answer. Release its claims so opening
            // the same picker can inspect those targets again.
            if (!completed) for (const selection of pending) scope.asked.delete(selectionKey(selection));
        };
    }, [demanded, machineId, offline, scopeKey, serverId, sessionId, targetsKey]);

    const read = React.useCallback((selection: SessionAgentTransitionSelectionV1): SessionAgentContinuationInspectionState => {
        if (offline) return MACHINE_UNREACHABLE;
        // No machine to address is not proof the daemon is old, and the Session's
        // machine may still be resolving.
        if (!machineId) return CHECKING;
        return answers.get(selectionKey(selection)) ?? CHECKING;
    }, [answers, machineId, offline]);

    return { read };
}
