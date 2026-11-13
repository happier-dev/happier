import { isExecutionRunActive, readExecutionRunLinkV1 } from '@happier-dev/protocol';

import { sessionExecutionRunGet, sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';

import type { SessionActionTarget } from './sessionActionTypes';

function errorMessage(result: Readonly<{ error?: unknown }>, fallback: string): string {
    return typeof result.error === 'string' && result.error.trim() ? result.error : fallback;
}

/** Stops only the active visible run linked by the child being archived. */
export async function stopLinkedExecutionRunBeforeArchive(target: SessionActionTarget): Promise<void> {
    const link = readExecutionRunLinkV1(target.session.metadata);
    if (!link) return;

    const options = { serverId: target.serverId };
    const current = await sessionExecutionRunGet(link.parentSessionId, { runId: link.runId }, options);
    if (!('run' in current)) throw new Error(errorMessage(current, 'Unable to verify linked execution run'));
    if (!isExecutionRunActive(current.run)) return;

    const stopped = await sessionExecutionRunStop(
        link.parentSessionId,
        { runId: link.runId, reason: 'child_archived' },
        options,
    );
    if (stopped.ok !== true) throw new Error(errorMessage(stopped, 'Unable to stop linked execution run'));
}
