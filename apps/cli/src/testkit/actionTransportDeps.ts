import type { ActionExecutorDeps } from '@happier-dev/protocol';

/** Unused OS/network transport ports fail loudly; real Action admission still runs. */
export function createUnavailableActionTransportDeps(): ActionExecutorDeps {
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
    };
}
