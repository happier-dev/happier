import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { createSessionLifecycleRpcActionExecutor } from '@/rpc/handlers/sessionLifecycle';
import { logger } from '@/ui/logger';

import type { SessionLifecycleMachineHandlers } from './sessionLifecycleTypes';

export function createMachineSessionStopLifecycleActionExecutor(params: Readonly<{
    stopSession: SessionLifecycleMachineHandlers['stopSession'];
}>): RpcActionExecutor {
    return createSessionLifecycleRpcActionExecutor({
        'session.stop': async (rawParams: unknown) => {
            const { sessionId } = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as { sessionId?: unknown };

            if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
                throw new Error('Session ID is required');
            }

            const normalizedSessionId = sessionId.trim();
            const success = await params.stopSession(normalizedSessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${normalizedSessionId}`);
            return { message: 'Session stopped' };
        },
    });
}
