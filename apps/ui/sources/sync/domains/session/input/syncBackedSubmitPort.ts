import { ensureSessionRuntimeForPendingInput, sessionSwitch } from '@/sync/ops';
import { sync as defaultSync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

import type { SessionSubmitPort } from './types';
import { shouldDelegatePendingActivationToDaemon } from './pendingActivationWakeDecision';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type SyncSubmitRuntime = Pick<
    typeof defaultSync,
    | 'abortSession'
    | 'blockPendingDelivery'
    | 'updatePendingRequestedAction'
    | 'enqueuePendingMessage'
    | 'sendMessage'
    | 'refreshSessionForSubmit'
    | 'isSessionTargetRemoteToActiveServer'
    | 'encryption'
>;

/** Admission shared by standalone and Sync-owned submit ports. */
export const isSessionSubmitMachineReachable: NonNullable<SessionSubmitPort['isMachineReachable']> = (machineId, options) => {
    const lifetime = options?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()
        || (options?.serverId && !areServerProfileIdentifiersEquivalent(options.serverId, lifetime.scope.serverId))) return false;
    const machine = resolveServerScopedMachine(storage.getState(), lifetime.scope.serverId, machineId);
    return machine !== null && isMachineReachable(lifetime.scope, machine);
};

export function createSyncBackedSubmitPort(syncRuntime: SyncSubmitRuntime = defaultSync): SessionSubmitPort {
    return {
        blockPendingDelivery: (sessionId, localId, reason, options) =>
            syncRuntime.blockPendingDelivery(sessionId, localId, reason, options),
        enqueuePendingMessage: (sessionId, text, displayText, metaOverrides, options) =>
            syncRuntime.enqueuePendingMessage(sessionId, text, displayText, metaOverrides, options),
        sendMessage: (sessionId, text, displayText, metaOverrides, options) =>
            syncRuntime.sendMessage(sessionId, text, displayText, metaOverrides, options),
        abortSession: (sessionId) => syncRuntime.abortSession(sessionId),
        updatePendingRequestedAction: async (sessionId, localId, requestedAction, options) => {
            await syncRuntime.updatePendingRequestedAction(sessionId, localId, requestedAction, options);
        },
        ensureSessionRuntimeForPendingInput: (options) => ensureSessionRuntimeForPendingInput(options),
        shouldDelegatePendingActivationToDaemon: (session, serverId, machineId) =>
            shouldDelegatePendingActivationToDaemon({
                session,
                serverId,
                machineId,
                getServerFeaturesSnapshot,
                getMachine: (targetMachineId) => storage.getState().machines[targetMachineId],
            }),
        isMachineReachable: isSessionSubmitMachineReachable,
        refreshSessionForSubmit: (sessionId, options) =>
            syncRuntime.refreshSessionForSubmit(sessionId, options),
        isSessionTargetRemoteToActiveServer: (sessionId) =>
            syncRuntime.isSessionTargetRemoteToActiveServer(sessionId),
        switchSessionControlToRemote: async (sessionId, options) => {
            await sessionSwitch(sessionId, 'remote', options);
        },
        canWakeMachineId: (machineId) => Boolean(
            syncRuntime.encryption?.getMachineEncryption(machineId)
            || storage.getState().machines[machineId]?.storageMode === 'plain',
        ),
    };
}
