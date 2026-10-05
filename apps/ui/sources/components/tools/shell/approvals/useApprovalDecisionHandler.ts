import * as React from 'react';

import type { ActionId, ApprovalRequest, ComputerAccessV1, ComputerTargetV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
    createDefaultActionExecutor,
    requiresExactDaemonApprovalReplay,
    resolveApprovalReplayRoute,
    type ApprovalReplayRoute,
} from '@/sync/ops/actions/defaultActionExecutor';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createApiTokenSettingsController } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { showApiTokenCreateModal } from '@/components/settings/apiTokens/showApiTokenCreateModal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';

export { resolveApprovalReplayRoute };

/** Shared recovery copy for the detail page and transcript approval card. */
export function getApprovalDecisionErrorMessage(error: unknown): string {
    return error instanceof HappyError && error.code === 'present_user_required'
        ? t('approvals.decisionAuthorityError')
        : t('approvals.decisionError');
}

type ApprovalDecisionArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;

function requiresResolvedReplayRoute(approval: ApprovalRequest): boolean {
    return approval.v === 2 && (
        requiresExactDaemonApprovalReplay(approval)
        || Boolean(approval.executionOriginV1.serverIdentityId?.trim())
    );
}

export function isApprovalReplayRouteUnavailable(approval: ApprovalRequest | null): boolean {
    return Boolean(approval && requiresResolvedReplayRoute(approval) && !resolveApprovalReplayRoute(approval));
}

function readServerId(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalRequest | null,
    replayRoute: ApprovalReplayRoute | null,
    sessionId: string,
    serverIdHint?: string | null,
): string | null {
    if (approval?.v === 2 && replayRoute) return replayRoute.serverId;
    if (approval && requiresExactDaemonApprovalReplay(approval)) return null;
    const normalizedServerIdHint = serverIdHint?.trim() ?? '';
    if (normalizedServerIdHint.length > 0) return normalizedServerIdHint;
    const headerServerId = typeof artifact.header?.serverId === 'string' ? artifact.header.serverId.trim() : '';
    if (headerServerId.length > 0) return headerServerId;
    if (approval?.v === 2) return approval.executionOriginV1.serverId.trim() || null;
    return resolvePreferredServerIdForSessionId(sessionId) ?? null;
}

export type ApprovalDecisionOptions = Readonly<{
    /** The window the person picked while approving an agent's `computer.target.select`. */
    computerTarget?: ComputerTargetV1;
    computerAccess?: ComputerAccessV1;
}>;

export function useApprovalDecisionHandler(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalRequest | null,
    sessionId: string,
    serverIdHint?: string | null,
): (decision: 'approve' | 'reject', options?: ApprovalDecisionOptions) => Promise<boolean> {
    const serverProfilesGeneration = useServerProfilesGeneration();
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: (targetSessionId) => resolvePreferredServerIdForSessionId(targetSessionId) ?? null,
        }),
        [],
    );
    const replayRoute = React.useMemo(
        () => resolveApprovalReplayRoute(approval),
        [approval, serverProfilesGeneration],
    );
    const serverId = React.useMemo(
        () => readServerId(artifact, approval, replayRoute, sessionId, serverIdHint),
        [approval, artifact, replayRoute, serverIdHint, sessionId],
    );

    return React.useCallback(async (decision: 'approve' | 'reject', options?: ApprovalDecisionOptions) => {
        if (!approval) return false;
        // Portable or daemon-owned origins must resolve their immutable Home identity. A
        // present-user UI approval intentionally has no cryptographic Home identity and stays
        // on its exact mounted route instead of being misclassified as cross-device replay.
        if (requiresResolvedReplayRoute(approval) && !replayRoute) return false;
        if (
            decision === 'approve'
            && requiresExactDaemonApprovalReplay(approval)
            && (approval.v !== 2 || !approval.executionOriginV1.machineId?.trim())
        ) return false;
        const revealsCreatedToken = decision === 'approve' && approval.actionId === 'account.apiTokens.create';
        let account: LazyActionAccountContext | null = null;
        let retainedForReveal = false;
        try {
            if (revealsCreatedToken) {
                if (!serverId) return false;
                account = await captureLazyActionAccountContext(serverId);
                if (account.credentialAuthorityKind !== 'account') return false;
                account.assertCurrent();
            }
            const result = await executor.execute(
                'approval.request.decide' as ActionId,
                {
                    artifactId: artifact.id,
                    decision,
                    ...(decision === 'approve' && options?.computerTarget ? { computerTarget: options.computerTarget } : {}),
                    ...(decision === 'approve' && options?.computerAccess ? { computerAccess: options.computerAccess } : {}),
                },
                { surface: 'ui',
                    // The window was chosen by the person's own press in the picker (W15 requires it).
                    ...(decision === 'approve' && (options?.computerTarget || options?.computerAccess) ? { authority: 'present_user' as const } : {}),
                    ...(serverId ? { serverId } : {}),
                    ...(account ? { expectedAccountId: account.accountId } : {}) },
            );
            if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
            if (!revealsCreatedToken || !account) return true;
            account.assertCurrent();
            const outcome = result.result;
            const live = typeof outcome === 'object' && outcome !== null && 'liveExecution' in outcome
                ? outcome.liveExecution : null;
            const tokenId = typeof approval.actionArgs === 'object' && approval.actionArgs !== null
                && 'tokenId' in approval.actionArgs && typeof approval.actionArgs.tokenId === 'string'
                ? approval.actionArgs.tokenId : null;
            if (!tokenId || typeof live !== 'object' || live === null || !('ok' in live) || live.ok !== true
                || !('result' in live)) return false;
            const captured = account;
            const controller = createApiTokenSettingsController({
                captureActiveAccountScopeLifetime: () => captured.accountLifetime,
                execute: async (actionId, input, context) => {
                    const capturedContext: NonNullable<Parameters<typeof executor.execute>[2]>
                        & Readonly<{ expectedAccountId: string }> = {
                            ...context, serverId: captured.serverId, expectedAccountId: captured.accountId,
                        };
                    return await executor.execute(actionId, input, capturedContext);
                },
                now: () => Date.now(),
            });
            if (!controller.adoptCreatedToken({ result: live.result, tokenId, target: captured.accountLifetime })) {
                controller.retire();
                return false;
            }
            showApiTokenCreateModal(controller, undefined, () => {
                controller.retire();
                captured.dispose();
            });
            retainedForReveal = true;
            return true;
        } catch (error) {
            if (revealsCreatedToken && account && !account.accountLifetime.isCurrent()) return false;
            throw error;
        } finally {
            if (!retainedForReveal) account?.dispose();
        }
    }, [approval, artifact.id, executor, replayRoute, serverId]);
}
