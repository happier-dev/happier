import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isAdmittedRequesterSessionBootstrapCurrent, prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { SessionLifecycleActionHandler, SessionLifecycleMachineDeps, SessionLifecycleMachineHandlers } from './sessionLifecycleTypes';
import { createSessionStartupProjectSpawn } from './sessionStartupProjectOperation';

export async function isRequesterSessionLifecycleCurrent(sessionId: string,
    context: Parameters<SessionLifecycleActionHandler>[1]): Promise<boolean> {
    if (context?.signal?.aborted) return false;
    if (context?.requesterSessionBootstrap) return context.requesterSessionBootstrap.getBoundSessionId() === sessionId
        && await isAdmittedRequesterSessionBootstrapCurrent(context);
    return !context?.machineAdmission || context.machineAdmission.actorAccountId === context.machineAdmission.custodianAccountId;
}

/** The existing custody owner admits a fresh child; parent custody is never rebound. */
export async function runRequesterSessionLifecycle<T>(params: Readonly<{
    sessionId: string;
    context: Parameters<SessionLifecycleActionHandler>[1];
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
    stopSession?: SessionLifecycleMachineHandlers['stopSession'];
    awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
    refused(): T;
    run(input: Readonly<{
        requester: NonNullable<Parameters<SessionLifecycleActionHandler>[1]>['requesterSessionBootstrap'];
        spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
        isCurrent(): Promise<boolean>;
    }>): Promise<T>;
}>): Promise<T> {
    const requester = params.context?.requesterSessionBootstrap;
    const startupSpawnSession = createSessionStartupProjectSpawn({ context: params.context, spawnSession: params.spawnSession,
        ...(params.stopSession ? { stopSession: params.stopSession } : {}),
        ...(params.awaitAgentSessionOpen ? { awaitAgentSessionOpen: params.awaitAgentSessionOpen } : {}) });
    const foreign = params.context?.machineAdmission
        && params.context.machineAdmission.actorAccountId !== params.context.machineAdmission.custodianAccountId;
    if (!requester) return foreign ? params.refused() : await params.run({ requester: undefined,
        spawnSession: startupSpawnSession, isCurrent: async () => !params.context?.signal?.aborted });
    const isCurrent = () => isRequesterSessionLifecycleCurrent(params.sessionId, params.context);
    if (!await isCurrent()) return params.refused();
    const spawnSession: SessionLifecycleMachineHandlers['spawnSession'] = async options => {
        if (!await isCurrent()) return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
            errorMessage: 'Requester Session authority is unavailable' };
        const prepared = await readRequesterHomeWithinActionLifetime(() => prepareRequesterSessionBootstrap({ credentials: requester.credentials,
            machineAdmission: params.context?.machineAdmission ?? requester.savedSecretOperationContext.machineAdmission,
            homeServerIdentityId: requester.homeServerIdentityId,
            attribution: requester.attribution, boundary: { serverId: requester.attribution.serverId,
                serverHttpBaseUrl: requester.serverHttpBaseUrl, happyHomeDir: configuration.happyHomeDir },
            verifyMachineAdmissionCurrent: isCurrent, ...(params.context?.signal ? { signal: params.context.signal } : {}) }), params.context?.signal);
        if (!prepared) return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
            errorMessage: 'Requester Session authority is unavailable' };
        try {
            const result = await startupSpawnSession({ ...options, requesterSessionBootstrap: prepared.admitted,
                requesterWorkAttributionV1: prepared.admitted.attribution });
            if (result.type !== 'success') await prepared.cleanupOnFailure();
            return result;
        } catch (error) { await prepared.cleanupOnFailure(); throw error; }
    };
    return await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl,
        () => params.run({ requester, spawnSession, isCurrent }));
}
