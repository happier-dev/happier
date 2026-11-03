import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';

/** Present the executor's Artifact without changing the invocation's result custody. */
export function usePluginSurfaceActionApproval(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    scopeKey: string;
    serverId?: string | null;
    hasCustomExecutor: boolean;
}>) {
    const { accountLifetime, serverId, hasCustomExecutor } = input;
    const approval = useActionApprovalContinuation({
        scopeKey: input.scopeKey,
        serverId: accountLifetime?.scope.serverId ?? serverId ?? '',
        onExecuted: () => {},
    });
    const requestApproval = approval.requestApproval;
    const pendingApproval = React.useMemo(() => approval.approvalPending && approval.approvalId
        ? { artifactId: approval.approvalId,
            href: buildApprovalHref(approval.approvalId, accountLifetime?.scope.serverId ?? serverId ?? '') }
        : null, [approval.approvalPending, approval.approvalId, accountLifetime, serverId]);
    // Presentation-only binding changes retain the controller's executor.
    const execute = React.useMemo(() => {
        if (hasCustomExecutor || !accountLifetime
            || (serverId && !areServerProfileIdentifiersEquivalent(serverId, accountLifetime.scope.serverId))) return undefined;
        const present = ({ artifactId, signal }: Readonly<{ artifactId: string; signal?: AbortSignal }>) => {
            if (!accountLifetime.isCurrent() || signal?.aborted) return;
            requestApproval({ artifactId, scope: accountLifetime.scope,
                refreshAfterExecution: false, ...(signal ? { signal } : {}),
                onExecuted: async () => 'ignored',
            });
        };
        const executor = scopedHomeActionExecutor(accountLifetime.scope, { onBlockingApprovalPending: present });
        const observe = async (operation: ReturnType<typeof executor>, signal?: AbortSignal) => {
            const result = await operation;
            const receipt = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
            if (receipt?.success) present({ artifactId: receipt.data.artifactId, ...(signal ? { signal } : {}) });
            return result;
        };
        return Object.assign((...args: Parameters<typeof executor>) => observe(executor(...args), args[2]?.signal), {
            confirmed: (...args: Parameters<typeof executor>) => observe(executor.confirmed(...args), args[2]?.signal),
            prepare: executor.prepare,
        });
    }, [accountLifetime, hasCustomExecutor, requestApproval, serverId]);
    return { approval, pendingApproval, execute };
}
