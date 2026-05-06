import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
    SPAWN_SESSION_ERROR_CODES,
} from '@/rpc/handlers/registerSessionHandlers';
import { parseSessionContinueWithReplayRpcParamsCompatIngress } from '@happier-dev/protocol';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';

import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineDeps,
    SessionLifecycleMachineHandlers,
} from './sessionLifecycleTypes';

export function createContinueWithReplayLifecycleActionHandler(params: Readonly<{
    sessionHostBridge: ReturnType<typeof getSessionHostBridge>;
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
    deps?: SessionLifecycleMachineDeps;
}>): SessionLifecycleActionHandler {
    return async (raw: unknown) => {
        const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress(raw);
        if (!parsed.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid params',
            };
        }

        const resolvedBackend = params.sessionHostBridge.resolveContinueWithReplayBackendTarget({
            backendTarget: parsed.data.backendTarget,
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
                modelId: parsed.data.modelId,
                modelUpdatedAt: parsed.data.modelUpdatedAt,
                replay: parsed.data.replay,
            },
            {
                spawnSession: params.spawnSession,
                ...(params.deps?.runReplaySummaryForDialog
                    ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
                    : {}),
            },
        );
    };
}
