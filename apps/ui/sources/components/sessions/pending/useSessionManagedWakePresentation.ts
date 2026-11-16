import * as React from 'react';
import { deriveManagedWakeProjection, readManagedWakeAuthorization } from '@/sync/domains/pending/managedWakeProjection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage, useMachineListStatusForServer } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { useManagedPendingWakeObservation } from './useManagedPendingWakeObservation';
import { resolveSessionDeliveryFailure } from './pendingMessageVisualState';

/** Acquired once by the presented Session; header and composer consume the same observed wake. */
export function useSessionManagedWakePresentation(input: Readonly<{
    session: (Pick<Session, 'id' | 'activeAt' | 'pendingActivationAuthorization' | 'pendingActivationFailureDetails'>
        & Partial<Pick<Session, 'active' | 'lastRuntimeIssue'>>) | null;
    accountLifetime: ServerAccountScopeLifetime | null;
    machineReachable: boolean | null;
    pendingMessages: readonly PendingMessage[];
    pendingLoaded: boolean;
    pendingReadState?: 'loading' | 'error';
    /** The presenting surface's presentation by subscription; a hidden surface keeps its last observed wake. */
    active?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
}>) {
    const authorization = input.session ? readManagedWakeAuthorization(input.session) : null;
    const reconnectSignal = storage(state => authorization ? state.socketLastConnectedAt : null);
    const observation = useManagedPendingWakeObservation({
        sessionId: input.session?.id ?? '', authorization, accountLifetime: input.accountLifetime,
        reconnectSignal,
        ...(input.active ? { active: input.active } : {}),
    });
    const inventoryStatus = useMachineListStatusForServer(authorization ? input.accountLifetime?.scope.serverId ?? '' : '');
    const resumingAt = storage(state => authorization && input.session ? state.sessions[input.session.id]?.resumingAt ?? null : null);
    const machineInventoryState = inventoryStatus === 'loading' ? 'loading' as const : 'read' as const;
    const deliveryFailure = React.useMemo(() => resolveSessionDeliveryFailure(input.pendingMessages, input.session, false),
        [input.pendingMessages, input.session?.active, input.session?.activeAt, input.session?.pendingActivationAuthorization,
            input.session?.pendingActivationFailureDetails, input.session?.lastRuntimeIssue]);
    const projection = React.useMemo(() => authorization && deliveryFailure?.recovery !== 'new_session' ? deriveManagedWakeProjection({
        managed: observation.machine, activation: authorization, machineReachable: input.machineReachable,
        pending: input.pendingMessages.find(message => message.localId === authorization.requestId) ?? null,
        runtimeResuming: resumingAt != null, pendingLoaded: input.pendingLoaded,
        pendingReadState: input.pendingReadState, managedReadState: observation.kind, machineInventoryState,
    }) : null, [authorization, deliveryFailure?.recovery, input.machineReachable, input.pendingLoaded, input.pendingMessages,
        input.pendingReadState, observation.machine, observation.kind, machineInventoryState, resumingAt]);
    const stableObservation = React.useMemo(() => observation, [observation.kind, observation.machine]);
    return React.useMemo(() => ({ authorization, observation: stableObservation, projection }),
        [authorization, stableObservation, projection]);
}

export type SessionManagedWakePresentation = ReturnType<typeof useSessionManagedWakePresentation>;
