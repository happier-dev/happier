import * as React from 'react';
import { InternalTaskCreateOutputSchema, type InternalTaskPlanCreateInputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import type { PlanOutputTaskV1 } from '@happier-dev/protocol/messages/structured/planOutputV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { selectSessionViewShellSessionForRouteState } from '@/components/sessions/shell/sessionViewStableSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

type PlanTaskSource = ReturnType<typeof InternalTaskPlanCreateInputSchema.parse>['plan']['source'];

/** Both person approval surfaces submit the same graph to the bound Account's Task owner. */
export function useAdoptStructuredPlanTasks(sessionId: string, serverId?: string | null) {
    const home = serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
    const { binding, executeValue } = useMountedActionExecution(home);
    return React.useCallback(async (source: PlanTaskSource, tasks: PlanOutputTaskV1[]) => {
        if (!binding) throw new Error('task_scope_mismatch');
        const lead = selectSessionViewShellSessionForRouteState(storage.getState(), sessionId, binding.scope.serverId);
        const metadata = lead && readSessionOwnerMetadataView(lead);
        const approvalProfileId = metadata && resolveSessionApprovalProfileReferenceV1(metadata);
        const result = InternalTaskCreateOutputSchema.parse(await executeValue('tasks.internal.create', {
            plan: { source, sessionId, tasks, ...(approvalProfileId ? { approvalProfileId } : {}) },
        }, { confirmed: true }));
        if (result.status !== 'plan_applied') throw new Error('reason' in result ? result.reason : 'task_plan_unavailable');
        return result.tasks;
    }, [binding, executeValue, sessionId]);
}
