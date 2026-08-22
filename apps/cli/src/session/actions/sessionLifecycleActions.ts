import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { createSessionLifecycleRpcActionExecutor } from '@/rpc/handlers/sessionLifecycle';

import { createContinueWithReplayLifecycleActionHandler } from './lifecycle/createContinueWithReplayLifecycleActionHandler';
import { createForkSessionLifecycleActionHandler } from './lifecycle/createForkSessionLifecycleActionHandler';
import { createSpawnNewSessionLifecycleActionHandler } from './lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionStopLifecycleActionExecutor } from './lifecycle/createStopSessionLifecycleActionExecutor';
import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineDeps,
    SessionLifecycleMachineHandlers,
} from './lifecycle/sessionLifecycleTypes';

export { createMachineSessionStopLifecycleActionExecutor };

/** The private machine spawn transport uses the existing lifecycle owner directly. */
export function createMachineSessionSpawnRpcHandler(params: Readonly<{
    handlers: Pick<SessionLifecycleMachineHandlers, 'spawnSession'>;
}>): SessionLifecycleActionHandler {
    return createSpawnNewSessionLifecycleActionHandler({
        spawnSession: params.handlers.spawnSession,
    });
}

export function createMachineSessionLifecycleActionExecutor(params: Readonly<{
    handlers: SessionLifecycleMachineHandlers;
    deps?: SessionLifecycleMachineDeps;
}>): RpcActionExecutor {
    const sessionHostBridge = getSessionHostBridge();
    const resolveExecutionSurfaces = params.deps?.resolveExecutionSurfaces
        ?? sessionHostBridge.resolveExecutionSurfaces.bind(sessionHostBridge);

    return createSessionLifecycleRpcActionExecutor({
        'session.continue_with_replay': createContinueWithReplayLifecycleActionHandler({
            sessionHostBridge,
            spawnSession: params.handlers.spawnSession,
            deps: params.deps,
        }),
        'session.fork': createForkSessionLifecycleActionHandler({
            sessionHostBridge,
            resolveExecutionSurfaces,
            handlers: params.handlers,
            deps: params.deps,
        }),
    });
}
