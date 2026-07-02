import { resumeSession, sessionSwitch } from '@/sync/ops';
import { sync as defaultSync } from '@/sync/sync';

import type { SessionSubmitPort } from './types';

type SyncSubmitRuntime = Pick<
    typeof defaultSync,
    'abortSession' | 'enqueuePendingMessage' | 'sendMessage' | 'refreshSessionForSubmit' | 'encryption'
>;

export function createSyncBackedSubmitPort(syncRuntime: SyncSubmitRuntime = defaultSync): SessionSubmitPort {
    return {
        enqueuePendingMessage: (sessionId, text, displayText, metaOverrides) =>
            syncRuntime.enqueuePendingMessage(sessionId, text, displayText, metaOverrides),
        sendMessage: (sessionId, text, displayText, metaOverrides, options) =>
            syncRuntime.sendMessage(sessionId, text, displayText, metaOverrides, options),
        abortSession: (sessionId) => syncRuntime.abortSession(sessionId),
        resumeSession: (options) => resumeSession(options),
        refreshSessionForSubmit: (sessionId, options) =>
            syncRuntime.refreshSessionForSubmit(sessionId, options),
        switchSessionControlToRemote: async (sessionId) => {
            await sessionSwitch(sessionId, 'remote');
        },
        canWakeMachineId: (machineId) => Boolean(syncRuntime.encryption.getMachineEncryption(machineId)),
    };
}
