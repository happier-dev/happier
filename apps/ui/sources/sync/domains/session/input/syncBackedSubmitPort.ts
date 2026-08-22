import { ensureSessionRuntimeForPendingInput, sessionSwitch } from '@/sync/ops';
import { sync as defaultSync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';

import type { SessionSubmitPort } from './types';

type SyncSubmitRuntime = Pick<
    typeof defaultSync,
    | 'abortSession'
    | 'updatePendingRequestedAction'
    | 'enqueuePendingMessage'
    | 'sendMessage'
    | 'refreshSessionForSubmit'
    | 'isSessionTargetRemoteToActiveServer'
    | 'encryption'
>;

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
        refreshSessionForSubmit: (sessionId, options) =>
            syncRuntime.refreshSessionForSubmit(sessionId, options),
        isSessionTargetRemoteToActiveServer: (sessionId) =>
            syncRuntime.isSessionTargetRemoteToActiveServer(sessionId),
        switchSessionControlToRemote: async (sessionId) => {
            await sessionSwitch(sessionId, 'remote');
        },
        canWakeMachineId: (machineId) => Boolean(
            syncRuntime.encryption?.getMachineEncryption(machineId)
            || storage.getState().machines[machineId]?.storageMode === 'plain',
        ),
    };
}
