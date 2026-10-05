import type { ActionExecuteResult } from '@happier-dev/protocol';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * Puts a Session under a lead, or back at the top (`leadSessionId: null`) — the canonical
 * `session.reports_to.set` Action on the one front door (ORC §3.5). The server owns the fence, the
 * compare-and-set on the current lead and the typed refusals; this module only asks.
 */
let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

export function setSessionReportsTo(input: Readonly<{
    sessionId: string;
    leadSessionId: string | null;
    expectedLeadSessionId: string | null;
    serverId: string | null;
    signal?: AbortSignal;
    expectedAccountId?: string;
}>): Promise<ActionExecuteResult> {
    execute ??= createFrontDoorActionExecute();
    return execute('session.reports_to.set', {
        sessionId: input.sessionId,
        leadSessionId: input.leadSessionId,
        expectedLeadSessionId: input.expectedLeadSessionId,
    }, { surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}) });
}
