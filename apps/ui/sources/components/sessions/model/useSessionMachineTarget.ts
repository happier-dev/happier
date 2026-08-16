import { useShallow } from 'zustand/react/shallow';

import { getStorage } from '@/sync/domains/state/storage';
import {
    resolveMachineControlTargetForSessionFromState,
    resolveMachineTargetForSessionFromState,
    type SessionMachineControlTarget,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';

export function useSessionMachineTarget(sessionId: string): { machineId: string; basePath: string } | null {
    return getStorage()(
        useShallow((state) =>
            resolveMachineTargetForSessionFromState(state as SessionMachineTargetState, sessionId)
        )
    );
}

export function useSessionMachineControlTarget(sessionId: string): SessionMachineControlTarget | null {
    return getStorage()(
        useShallow((state) =>
            resolveMachineControlTargetForSessionFromState(state as SessionMachineTargetState, sessionId)
        )
    );
}
