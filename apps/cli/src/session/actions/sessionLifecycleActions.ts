import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { createSessionLifecycleRpcActionExecutor } from '@/rpc/handlers/sessionLifecycle';

import { createContinueWithReplayLifecycleActionHandler } from './lifecycle/createContinueWithReplayLifecycleActionHandler';
import { createForkSessionLifecycleActionHandler } from './lifecycle/createForkSessionLifecycleActionHandler';
import { createSpawnNewSessionLifecycleActionHandler } from './lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionStopLifecycleActionExecutor } from './lifecycle/createStopSessionLifecycleActionExecutor';
import type {
    SessionLifecycleMachineDeps,
    SessionLifecycleMachineHandlers,
} from './lifecycle/sessionLifecycleTypes';

export { createMachineSessionStopLifecycleActionExecutor };

export function createMachineSessionLifecycleActionExecutor(params: Readonly<{
    handlers: SessionLifecycleMachineHandlers;
    deps?: SessionLifecycleMachineDeps;
}>): RpcActionExecutor {
    const sessionHostBridge = getSessionHostBridge();

    return createSessionLifecycleRpcActionExecutor({
        'session.spawn_new': createSpawnNewSessionLifecycleActionHandler({
            spawnSession: params.handlers.spawnSession,
        }),
        'session.continue_with_replay': createContinueWithReplayLifecycleActionHandler({
            sessionHostBridge,
            spawnSession: params.handlers.spawnSession,
            deps: params.deps,
        }),
        'session.fork': createForkSessionLifecycleActionHandler({
            sessionHostBridge,
            handlers: params.handlers,
            deps: params.deps,
        }),
    });
}
