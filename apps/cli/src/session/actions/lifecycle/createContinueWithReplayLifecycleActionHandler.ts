import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
    SPAWN_SESSION_ERROR_CODES,
} from '@/session/shared/spawnSessionContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { parseSessionContinueWithReplayRpcParamsCompatIngress } from '@/session/replay/continueWithReplayCompatIngress';
import { normalizeSpawnNonce } from '@/session/shared/spawnNonce';

import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineDeps,
    SessionLifecycleMachineHandlers,
} from './sessionLifecycleTypes';
import { runRequesterSessionLifecycle } from './requesterSessionLifecycle';

export function createContinueWithReplayLifecycleActionHandler(params: Readonly<{
    sessionHostBridge: ReturnType<typeof getSessionHostBridge>;
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
    deps?: SessionLifecycleMachineDeps;
}>): SessionLifecycleActionHandler {
    return async (raw: unknown, context) => {
        const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress(raw);
        if (!parsed.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid params',
            };
        }

        return await runRequesterSessionLifecycle<unknown>({ sessionId: parsed.data.replay.previousSessionId, context,
            spawnSession: params.spawnSession,
            refused: () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Session authority is unavailable' }),
            run: async ({ requester, spawnSession, isCurrent }) => {
        const parsedData = parsed.data as typeof parsed.data & { spawnNonce?: unknown };
        const resolvedBackend = params.sessionHostBridge.resolveContinueWithReplayBackendTarget({
            backendTarget: parsedData.backendTarget,
        });
        if (!resolvedBackend.ok) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: resolvedBackend.errorMessage,
            };
        }

        return await continueSessionWithReplay(
            {
                directory: parsed.data.directory,
                backendTarget: resolvedBackend.backendTargetV2,
                approvedNewDirectoryCreation: parsed.data.approvedNewDirectoryCreation,
                permissionMode: parsed.data.permissionMode,
                permissionModeUpdatedAt: parsed.data.permissionModeUpdatedAt,
                modelSelection: parsed.data.modelSelection,
                spawnNonce: normalizeSpawnNonce(parsedData.spawnNonce),
                replay: parsed.data.replay,
            },
            {
                spawnSession,
                ...(requester ? { credentials: requester.credentials, isCurrent } : {}),
                ...(params.deps?.runReplaySummaryForDialog
                    ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
                    : {}),
            },
        );
            },
        });
    };
}
