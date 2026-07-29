import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { createSessionLifecycleRpcActionExecutor } from '@/rpc/handlers/sessionLifecycle';
import { logger } from '@/ui/logger';
import { StopSessionResultSchema, type StopSessionResult } from '@/daemon/sessions/stopSessionContract';

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
            const rawResult = await params.stopSession(normalizedSessionId);
            const result: StopSessionResult = typeof rawResult === 'boolean'
                ? (rawResult ? { status: 'requested' } : { status: 'not_found' })
                : StopSessionResultSchema.parse(rawResult);

            logger.debug(`[API MACHINE] Stop session ${normalizedSessionId}: ${result.status}`);
            return result;
        },
    });
}
