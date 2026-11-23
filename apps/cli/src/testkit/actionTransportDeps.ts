import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';

/** Unused OS/network transport ports fail loudly; real Action admission still runs. */
export function createUnavailableActionTransportDeps() {
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Action transport in this fixture'); };
    return {
        executionRunStart: unavailable, executionRunList: unavailable, executionRunGet: unavailable,
        detachedExecutionRunSend: unavailable, executionRunStop: unavailable, executionRunAction: unavailable,
        executionRunWait: unavailable, sessionOpen: unavailable, sessionFork: unavailable,
        sessionRollback: unavailable, sessionSpawnNew: unavailable, pathsListRecent: unavailable,
        machinesList: unavailable, serversList: unavailable, reviewEnginesList: unavailable,
        agentsBackendsList: unavailable, agentsModelsList: unavailable, sessionSendMessage: unavailable,
        sessionPermissionRespond: unavailable, sessionUserActionAnswer: unavailable,
        sessionModeSet: unavailable, sessionModesList: unavailable, sessionList: unavailable,
        sessionActivityGet: unavailable, sessionRecentMessagesGet: unavailable, resetGlobalVoiceAgent: unavailable,
        daemonMemorySearch: unavailable, daemonMemoryGetWindow: unavailable, daemonMemoryEnsureUpToDate: unavailable,
    } satisfies ActionExecutorDeps;
}

/** External admission requires the canonical Automation port; this Account has no checks to select. */
export function createEmptyActionAutomationPort(accountId = 'owner') {
    return createActionAutomationPortV1({ accountId, seed: async () => ({ v: 1, rows: [] }), settle: async () => {} });
}
