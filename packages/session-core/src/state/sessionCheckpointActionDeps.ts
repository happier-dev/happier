import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

type CheckpointActionDeps = Required<Pick<ActionExecutorDeps, 'sessionCheckpoint' | 'sessionRestore'>>;
type CheckpointRequest = Parameters<CheckpointActionDeps['sessionCheckpoint']>[0]['request'];
type RestoreRequest = Parameters<CheckpointActionDeps['sessionRestore']>[0]['request'];

export function createSessionCheckpointActionDeps(callSessionRpc: (args: Readonly<{
    sessionId: string;
    method: string;
    payload: CheckpointRequest | RestoreRequest;
    serverId?: string | null;
    signal?: AbortSignal;
}>) => Promise<unknown>): CheckpointActionDeps {
    return {
        sessionCheckpoint: ({ request, serverId, signal }) => callSessionRpc({
            sessionId: request.sessionId, method: SESSION_RPC_METHODS.SESSION_CHECKPOINT,
            payload: request, serverId, signal,
        }),
        sessionRestore: ({ request, serverId, signal }) => callSessionRpc({
            sessionId: request.sessionId, method: SESSION_RPC_METHODS.SESSION_RESTORE,
            payload: request, serverId, signal,
        }),
    };
}
