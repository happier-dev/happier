import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createOpenBrowserTargetInWorkspace, type CreateOpenBrowserTargetInWorkspaceDeps } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { registerBrowserRuntimeWorkspaceOpeningAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createActionExecutorBoundaryFixture } from './actionExecutorBoundary';

/** Real Action admission, runtime dispatch, registry and workspace owner; only host ports vary. */
export function createBrowserWorkspaceOpeningFixture(
    deps: Omit<CreateOpenBrowserTargetInWorkspaceDeps, 'scopeId' | 'accountLifetime'>
        & Partial<Pick<CreateOpenBrowserTargetInWorkspaceDeps, 'scopeId' | 'accountLifetime'>>,
    ports: Partial<ActionExecutorDeps> = {},
) {
    let current = true;
    const retirement = new Set<() => void>();
    const accountLifetime: ServerAccountScopeLifetime = deps.accountLifetime ?? {
        scope: { serverId: 'home_1', accountId: 'account_1' },
        isCurrent: () => current,
        onRetire: cancel => { retirement.add(cancel); return { dispose: () => { retirement.delete(cancel); } }; },
    };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        runtimeActionExecute: createBrowserRuntimeActionExecutor({}),
        approvalsUpdate: async () => ({ ok: true }),
        isApprovalExecutionOriginCurrent: async () => accountLifetime.isCurrent(),
        ...ports,
    }));
    const context = { serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId,
        actionCaller: { kind: 'host' as const }, actionRequestId: 'workspace_open_request' };
    const open = createOpenBrowserTargetInWorkspace({ ...deps, scopeId: deps.scopeId ?? 'workspace_1', accountLifetime,
        actionExecute: (id, input, callerContext) => executor.execute(id, input, { ...callerContext, ...context }),
    });
    const dispose = registerBrowserRuntimeWorkspaceOpeningAdapter(open.runtimeAdapter);
    return { open, executor, context, dispose, retire: () => {
        current = false;
        for (const cancel of retirement) cancel();
    } };
}
