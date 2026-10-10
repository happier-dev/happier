import * as React from 'react';

import { isAutomationSessionCandidate } from '@/sync/domains/automations/isAutomationSessionCandidate';
import { getStorage } from '@/sync/domains/state/storage';
import type { WorkflowExistingSessionOption } from '@/sync/domains/workflows/workflowAuthoring';
import { resolveDisplayMachineIdForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import type { StorageState } from '@/sync/store/types';
import { getSessionName } from '@/utils/sessions/sessionUtils';

type WorkflowSessionOptions = Readonly<{
    existingSessions: readonly WorkflowExistingSessionOption[];
    /** Every continuable Session on any Machine: what the Session drop target resolves against. */
    sessionDropCandidates: readonly WorkflowExistingSessionOption[];
}>;

function sameOptions(left: readonly WorkflowExistingSessionOption[], right: readonly WorkflowExistingSessionOption[]) {
    return left.length === right.length && left.every((option, index) => {
        const other = right[index];
        return option.sessionId === other.sessionId && option.machineId === other.machineId && option.label === other.label;
    });
}

function createOptionsSelector(serverId: string | null, machineId: string | null) {
    // This hook owns the displayed options, not the Session/settings containers.
    // Keep the selected projection stable without retaining a second data source.
    let previous: WorkflowSessionOptions = { existingSessions: [], sessionDropCandidates: [] };
    return (state: StorageState): WorkflowSessionOptions => {
        const options: WorkflowExistingSessionOption[] = [];
        if (state.isDataReady) for (const session of Object.values(state.sessions)) {
            if (serverId !== null && session.serverId !== serverId) continue;
            if (!isAutomationSessionCandidate(session, state.settings)) continue;
            const sessionMachineId = resolveDisplayMachineIdForSessionFromState({
                state, sessionId: session.id, metadata: session.metadata,
            });
            if (sessionMachineId.length === 0) continue;
            options.push({ sessionId: session.id, machineId: sessionMachineId, label: getSessionName(session) });
        }
        if (sameOptions(options, previous.sessionDropCandidates)) return previous;
        const existing = machineId === null ? options : options.filter(option => option.machineId === machineId);
        previous = { sessionDropCandidates: options,
            existingSessions: sameOptions(existing, previous.existingSessions) ? previous.existingSessions : existing };
        return previous;
    };
}

/**
 * The existing Sessions a workflow step or an Account trigger's prompt may continue (01 §5.5): the
 * canonical Automation Session candidacy, each with the exact Machine the canonical target owner
 * reads for it. Once a Machine is known only its Sessions are offered, because the coordinator
 * refuses a Session on another Machine.
 */
export function useWorkflowExistingSessionOptions(params: Readonly<{
    serverId: string | null;
    machineId: string | null;
}>): WorkflowSessionOptions {
    const { serverId, machineId } = params;
    // Every Session the canonical candidacy owner can continue, on any Machine
    // of this server: the drop target needs them to state *why* a Session on
    // another Machine is refused (07 J19), while the picker offers only the
    // Where Machine's.
    const selector = React.useMemo(() => createOptionsSelector(serverId, machineId), [serverId, machineId]);
    return getStorage()(selector);
}
