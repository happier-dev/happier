import * as React from 'react';
import { followSignal, useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type {
    SessionAgentTransitionSelectionV1,
    SessionContinuationMachinePresenceV1,
} from '@happier-dev/protocol/sessions/agentTransition';

import { inspectSessionContinuationsOnMachine } from '@/sync/ops/sessionContinuationInspection';

import {
    isSessionAgentContinuationInspectionIndeterminate,
    type SessionAgentContinuationInspectionState,
    type SessionAgentContinuationMachineTarget,
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
     * Whether the picker is open and can offer a switch. Explicit Actions may
     * demand one selection through request; hidden layouts/hosts suspend reads.
     */
    demanded: boolean;
}>;

export type SessionContinuationInspections = Readonly<{
    /** This exact target's state; `checking` until this connection has an answer for it. */
    read: (selection: SessionAgentTransitionSelectionV1) => SessionAgentContinuationInspectionState;
    /** Explicit Action demand uses the same inspection owner without opening the picker. */
    request: (selection: SessionAgentTransitionSelectionV1) => Promise<SessionAgentContinuationInspectionState>;
}>;

function selectionKey(selection: SessionAgentTransitionSelectionV1): string {
    return JSON.stringify(selection);
}

/**
 * Live `session.continuation.inspect` answers for the targets one picker can offer.
 *
 * Three properties are deliberate.
 *
 * **Asked only on demand.** An open picker supplies its eligible targets; an
 * explicit Action requests its exact selection. Hidden layouts/hosts suspend reads.
 *
 * **One runtime pair, one answer.** Answers are cached against the realtime
 * connection, the daemon generation, and the machine state they were read over,
 * and discarded when any of them changes, because inspection reserves nothing and
 * re-reading is the only way it stays true. Inconclusive reads stay settled while
 * open, then release on close so the person can reopen to retry. Positive target
 * refusals remain answers; failed discovery never becomes one.
 *
 * **Never asks a machine known to be offline.** That answer is already held, and
 * waiting out a transport timeout to rediscover it would leave the row reading
 * "checking" for no reason.
 */
export function useSessionContinuationInspections(
    params: UseSessionContinuationInspectionsParams,
): SessionContinuationInspections {
    const { machine, machinePresence, sessionId, targetSelections } = params;
    // Presentation suspends reads by subscription: a retained host hidden and shown again does not render.
    const presentation = useLayoutPresentationSignal();
    const hostViewed = useHostActivelyViewed();
    const demandedWhilePresented = params.demanded && hostViewed;
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
    const scopeRef = React.useRef<Readonly<{ key: string; asked: Map<string, Promise<SessionAgentContinuationInspectionState>> }>>(
        { key: scopeKey, asked: new Map() },
    );
    if (scopeRef.current.key !== scopeKey) {
        scopeRef.current = { key: scopeKey, asked: new Map() };
        if (answers.size > 0) setAnswers(new Map());
    }

    const targetSelectionsRef = React.useRef(targetSelections);
    targetSelectionsRef.current = targetSelections;
    const targetsKey = targetSelections.map(selectionKey).join('\u0000');

    React.useEffect(() => followSignal(presentation, (presented) => {
        if (demandedWhilePresented && presented) return;
        const retryableKeys = [...answers].filter(([, answer]) => (
            isSessionAgentContinuationInspectionIndeterminate(answer)
        )).map(([key]) => key);
        if (retryableKeys.length === 0) return;
        // Only closing/hiding ends this inspection attempt. Changing another
        // target while open must not silently retry unrelated failed reads.
        for (const key of retryableKeys) scopeRef.current.asked.delete(key);
        setAnswers((current) => {
            const next = new Map(current);
            for (const key of retryableKeys) next.delete(key);
            return next;
        });
    }), [answers, demandedWhilePresented, presentation]);

    const inspect = React.useCallback(async (
        selections: readonly SessionAgentTransitionSelectionV1[], signal?: AbortSignal,
    ): Promise<readonly SessionAgentContinuationInspectionState[]> => {
        if (offline) return selections.map(() => MACHINE_UNREACHABLE);
        if (!machineId || !presentation.get() || !hostViewed) return selections.map(() => INDETERMINATE);
        const scope = scopeRef.current;
        if (scope.key !== scopeKey) return selections.map(() => INDETERMINATE);
        const pending = selections.filter((selection) => !scope.asked.has(selectionKey(selection)));
        if (pending.length > 0) {
            const batch = inspectSessionContinuationsOnMachine({
                machineId,
                serverId,
                sessionId,
                selections: pending,
                signal,
            })
                .catch(() => pending.map(() => INDETERMINATE))
                .then((results) => {
                    if (signal?.aborted || scopeRef.current !== scope) return pending.map(() => INDETERMINATE);
                    setAnswers((current) => {
                        const next = new Map(current);
                        pending.forEach((selection, index) => {
                            next.set(selectionKey(selection), results[index] ?? INDETERMINATE);
                        });
                        return next;
                    });
                    return results;
                });
            // Both the visible picker and an explicit Action join this exact
            // selection's pending read rather than issuing competing RPCs.
            pending.forEach((selection, index) => scope.asked.set(selectionKey(selection),
                batch.then(results => results[index] ?? INDETERMINATE)));
        }
        return Promise.all(selections.map(selection => scope.asked.get(selectionKey(selection)) ?? INDETERMINATE));
    }, [hostViewed, machineId, offline, presentation, scopeKey, serverId, sessionId]);

    React.useEffect(() => {
        if (!demandedWhilePresented || offline || !machineId) return;
        return followSignal(presentation, (presented) => {
            if (!presented) return;
            const scope = scopeRef.current;
            const pending = targetSelectionsRef.current.filter((selection) => !scope.asked.has(selectionKey(selection)));
            if (pending.length === 0) return;
            const controller = new AbortController();
            let completed = false;
            void inspect(pending, controller.signal).then(() => { completed = !controller.signal.aborted; });
            return () => {
                controller.abort();
                // A cancelled read supplied no answer. Release its claims so opening
                // the same picker can inspect those targets again.
                if (!completed) for (const selection of pending) scope.asked.delete(selectionKey(selection));
            };
        });
    }, [demandedWhilePresented, inspect, machineId, offline, presentation, scopeKey, targetsKey]);

    const read = React.useCallback((selection: SessionAgentTransitionSelectionV1): SessionAgentContinuationInspectionState => {
        if (offline) return MACHINE_UNREACHABLE;
        // No machine to address is not proof the daemon is old, and the Session's
        // machine may still be resolving.
        if (!machineId) return CHECKING;
        return answers.get(selectionKey(selection)) ?? CHECKING;
    }, [answers, machineId, offline]);

    const request = React.useCallback(async (selection: SessionAgentTransitionSelectionV1) => (
        await inspect([selection])
    )[0] ?? INDETERMINATE, [inspect]);

    return { read, request };
}
