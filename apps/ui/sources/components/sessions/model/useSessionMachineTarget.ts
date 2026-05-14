import { useShallow } from 'zustand/react/shallow';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    resolveMachineTargetForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { getStorage } from '@/sync/domains/state/storage';

export function useSessionMachineTarget(sessionId: string): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);

    return getStorage()(
        useShallow((state) =>
            resolveMachineTargetForSessionFromState(
                state as SessionMachineTargetState,
                resolvedSessionId,
            ),
        ),
    );
}
