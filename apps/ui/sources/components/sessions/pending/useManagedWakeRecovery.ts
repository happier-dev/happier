import * as React from 'react';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { PendingActivationBannerPresentation } from './resolvePendingActivationBanner';

/** Composer and Inbox consume the same wake presentation and recovery decisions. */
export function useManagedWakeRecovery(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    authorization: PendingActivationAuthorizationV1 | null | undefined;
    presentation: PendingActivationBannerPresentation | null;
    actionExecutor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;
    busy: boolean;
    setBusy: React.Dispatch<React.SetStateAction<boolean>>;
    requestApproval: (registration: ActionApprovalRegistration) => void;
    onResume: () => Promise<unknown>;
    onWithdraw: (row: PendingMessage) => Promise<unknown>;
}>) {
    const { accountLifetime, authorization, presentation, actionExecutor, busy, setBusy, requestApproval, onResume, onWithdraw } = input;
    return React.useCallback(async (action: 'inspect' | 'retry' | 'resume' | 'withdraw') => {
        const lifetime = accountLifetime;
        const projection = presentation?.managedWakeProjection;
        const target = authorization?.managedWakeTargetV1;
        if (!lifetime?.isCurrent() || !presentation || !projection || !target || busy) return;
        const cancellation = new AbortController();
        const retirement = lifetime.onRetire(() => cancellation.abort());
        setBusy(true);
        try {
            if (action === 'retry') {
                if (presentation.primaryAction === 'retry' && presentation.row) await onResume();
            } else if (action === 'resume') {
                if (projection.canResumeRuntime && presentation.row) await onResume();
            } else if (action === 'withdraw') {
                const row = presentation.row;
                if (projection.canWithdraw && row) await onWithdraw(row);
            } else {
                const inspectInput = { homeId: target.homeId, managedId: target.managedId };
                const result = await actionExecutor.execute('machines.managed.inspect', inspectInput,
                    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                    signal: cancellation.signal });
                if (!lifetime.isCurrent() || cancellation.signal.aborted) return;
                const refresh = () => {
                    if (lifetime.isCurrent() && !cancellation.signal.aborted) publishHomeAccountChange(lifetime.scope.serverId, [target.managedId]);
                };
                const fail = () => {
                    if (lifetime.isCurrent() && !cancellation.signal.aborted) Modal.alert(t('common.error'), t('managedMachines.detail.loadFailed'));
                };
                const outcome = classifyHomeActionOutcome(result);
                if (outcome.kind === 'completed') refresh();
                else if (outcome.kind === 'failed') fail();
                else requestApproval(createActionApprovalContinuation<unknown, 'machines.managed.inspect'>({
                    artifactId: outcome.artifactId, actionId: 'machines.managed.inspect', scope: lifetime.scope,
                    expectedInput: inspectInput, signal: cancellation.signal, onSucceeded: refresh, onFailed: fail,
                }));
            }
        } catch (error) {
            if (lifetime.isCurrent() && !cancellation.signal.aborted) Modal.alert(t('common.error'),
                error instanceof Error ? error.message : t('managedMachines.detail.loadFailed'));
        } finally {
            retirement.dispose();
            if (lifetime.isCurrent()) setBusy(false);
        }
    }, [accountLifetime, actionExecutor, authorization, busy, onResume, onWithdraw, presentation, requestApproval, setBusy]);
}
