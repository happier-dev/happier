import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';

/** Supply only the host ports exercised by a fixture; every other required boundary fails loudly. */
export function createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps {
    const unexpected = async (): Promise<never> => {
        throw new Error('Unexpected Action executor host boundary outside this fixture');
    };
    return {
        executionRunStart: unexpected,
        executionRunList: unexpected,
        executionRunGet: unexpected,
        detachedExecutionRunSend: unexpected,
        executionRunStop: unexpected,
        executionRunAction: unexpected,
        executionRunWait: unexpected,
        sessionOpen: unexpected,
        sessionFork: unexpected,
        sessionRollback: unexpected,
        sessionSpawnNew: unexpected,
        pathsListRecent: unexpected,
        machinesList: unexpected,
        serversList: unexpected,
        reviewEnginesList: unexpected,
        agentsBackendsList: unexpected,
        agentsModelsList: unexpected,
        sessionSendMessage: unexpected,
        sessionModeSet: unexpected,
        sessionModesList: unexpected,
        sessionList: unexpected,
        sessionActivityGet: unexpected,
        sessionRecentMessagesGet: unexpected,
        resetGlobalVoiceAgent: unexpected,
        daemonMemorySearch: unexpected,
        daemonMemoryGetWindow: unexpected,
        daemonMemoryEnsureUpToDate: unexpected,
        ...overrides,
    };
}
