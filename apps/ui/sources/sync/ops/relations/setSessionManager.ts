import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * Puts a Session under a lead, or back at the top (`managerSessionId: null`) — the canonical
 * `session.manager.set` Action on the one front door (ORC §3.5). The server owns the fence, the
 * compare-and-set on the current lead and the typed refusals; this module only asks.
 */
let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

export function setSessionManager(input: Readonly<{
    sessionId: string;
    managerSessionId: string | null;
    expectedManagerSessionId: string | null;
    serverId: string | null;
    signal?: AbortSignal;
    expectedAccountId?: string;
}>): Promise<ActionExecuteResult> {
    execute ??= createFrontDoorActionExecute();
    return execute('session.manager.set', {
        sessionId: input.sessionId,
        managerSessionId: input.managerSessionId,
        expectedManagerSessionId: input.expectedManagerSessionId,
    }, { surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}) });
}
