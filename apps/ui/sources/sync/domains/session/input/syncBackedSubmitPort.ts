import { ensureSessionRuntimeForPendingInput, sessionSwitch } from '@/sync/ops';
import { sync as defaultSync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

import type { SessionSubmitPort } from './types';
import { shouldDelegatePendingActivationToDaemon } from './pendingActivationWakeDecision';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

type SyncSubmitRuntime = Pick<
    typeof defaultSync,
    | 'abortSession'
    | 'updatePendingRequestedAction'
    | 'enqueuePendingMessage'
    | 'sendMessage'
    | 'refreshSessionForSubmit'
> & Readonly<{
    encryption: Pick<typeof defaultSync.encryption, 'getMachineEncryption'>;
}>;

export function createSyncBackedSubmitPort(syncRuntime: SyncSubmitRuntime = defaultSync): SessionSubmitPort {
    return {
        enqueuePendingMessage: (sessionId, text, displayText, metaOverrides, options) =>
            syncRuntime.enqueuePendingMessage(sessionId, text, displayText, metaOverrides, options),
        sendMessage: (sessionId, text, displayText, metaOverrides, options) =>
            syncRuntime.sendMessage(sessionId, text, displayText, metaOverrides, options),
        abortSession: (sessionId) => syncRuntime.abortSession(sessionId),
        updatePendingRequestedAction: (sessionId, localId, requestedAction) =>
            syncRuntime.updatePendingRequestedAction(sessionId, localId, requestedAction),
        ensureSessionRuntimeForPendingInput: (options) => ensureSessionRuntimeForPendingInput(options),
        shouldDelegatePendingActivationToDaemon: (session, serverId, machineId) =>
            shouldDelegatePendingActivationToDaemon({
                session,
                serverId,
                machineId,
                getServerFeaturesSnapshot,
                getMachine: (machineId) => storage.getState().machines[machineId],
            }),
        isMachineReachable: (machineId) => {
            const machine = storage.getState().machines[machineId];
            return Boolean(machine && isMachineOnline(machine));
        },
        refreshSessionForSubmit: (sessionId, options) => syncRuntime.refreshSessionForSubmit(sessionId, options),
        switchSessionControlToRemote: async (sessionId) => {
            await sessionSwitch(sessionId, 'remote');
        },
        canWakeMachineId: (machineId) => Boolean(syncRuntime.encryption.getMachineEncryption(machineId)),
    };
}
