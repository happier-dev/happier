import type { TriageAdmittedOperationExecutorV1, TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import type { TriageDataActionContext } from '../../actions/dataContext.js';
import { TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_V1, scanInternalTasks } from '../../internalTasks/source.js';

/** Host admission and Account task transport boundaries for an empty built-in
 * inventory. The real built-in scanner and descriptor remain under test. */
export function createTestkitEmptyInternalTaskSource() {
    const handle = { role: 'scan', of: 'internal' };
    // Admitted operation handles are host-issued, deliberately not constructible.
    const contribution = {
        contributor: { pluginId: INTERNAL_TASK_SOURCE_V1.pluginId, contributionId: INTERNAL_TASK_SOURCE_V1.localId,
            immutableGenerationId: 'generation-1' },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
        descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
        operations: { listInstances: {}, scan: handle, get: {} }, surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1;
    const scan: TriageAdmittedOperationExecutorV1 = async (_operation, input, options) => {
        // Only the host's authenticated Account transport is replaced here.
        const context = { signal: options?.signal ?? new AbortController().signal, services: { actions: {
            execute: async () => ({ status: 'ok', scope: { serverId: 'home', accountId: 'account' },
                todos: [], undoneOrder: [], completedOrder: [] }),
        } } } as unknown as TriageDataActionContext;
        return await scanInternalTasks(input, context);
    };
    return { contribution, scan };
}
