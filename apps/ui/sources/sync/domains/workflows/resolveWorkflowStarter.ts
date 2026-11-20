import type { WorkflowStarterExampleKeyV1, WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import { WorkflowStartersResolveResultV1Schema } from '@happier-dev/protocol/workflows/builtins/starterActionsV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { callWorkflowAction } from './callWorkflowAction';

export function resolveWorkflowStarter(params: Readonly<{
    key: WorkflowStarterExampleKeyV1;
    timezone: string | null;
    session?: WorkflowStarterSessionTarget;
    accountLifetime?: ServerAccountScopeLifetime | null;
    signal?: AbortSignal;
}>) {
    const { key, timezone, session, accountLifetime, signal } = params;
    return callWorkflowAction({
        actionId: 'workflow.starters.resolve',
        input: {
            key, timezone,
            ...(session === undefined ? {} : { session: {
                sessionId: session.sessionId, machineId: session.machineId,
                ...(session.serverId === undefined ? {} : { serverId: session.serverId }),
            } }),
        },
        parseResult: WorkflowStartersResolveResultV1Schema.parse,
        accountLifetime,
        signal,
    });
}
