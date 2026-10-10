import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

type AcpAuthoringActionId = 'agents.acp.backends.upsert' | 'agents.acp.backends.delete';

/** The two mounted ACP authoring surfaces share the existing public Action result custody. */
export function useAcpCatalogActionExecution(scope: ServerAccountScope | null | undefined) {
    const router = useRouter();
    const onApprovalPending = React.useCallback((registration: ActionApprovalContinuation) => {
        if (registration.scope) router.push(`/inbox/approvals/${encodeURIComponent(registration.artifactId)}?serverId=${encodeURIComponent(registration.scope.serverId)}`);
    }, [router]);
    const execution = useMountedActionExecution(scope, { onApprovalPending });
    const execute: (actionId: AcpAuthoringActionId, input: unknown) => Promise<ActionExecuteResult> = execution.execute;
    return { execute, ready: execution.ready, isCurrent: execution.isCurrent };
}
