import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';

import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { listPendingPermissionRequests } from '@/utils/sessions/sessionUtils';
import { formatPermissionRequestDisplaySummary } from '@/components/tools/shell/permissions/presentation/permissionRequestDisplaySummary';
import type { SessionPendingRequest } from '@happier-dev/session-core/pending';
import type { NativePermissionChoicesV1, NativePermissionChoiceAvailabilityV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

import {
    resolveSessionPermissionAnswerPolicy,
    resolveSessionPermissionAnswers,
    resolveSessionPermissionBehavior,
    type SessionPermissionAnswer,
    type SessionPermissionAnswerPolicy,
} from './sessionPermissionAnswers';

/**
 * One pending Session permission request as every non-footer surface sees it:
 * what is asked, and which of the shared answers this viewer may give now.
 *
 * The plugin UI Host API and the Companion's needs-you block both read this one
 * projection and answer through `answerSessionPermission`, so "Allow" means the
 * same provider decision wherever it is pressed. The transcript footer keeps its
 * richer choices (shared with the notch) and is not replaced by this list.
 */
export type SessionPendingPermission = Readonly<{
    requestId: string;
    toolName: string;
    turnId?: string;
    source?: string;
    nativeChoices?: NativePermissionChoicesV1;
    nativeChoiceAvailability?: readonly NativePermissionChoiceAvailabilityV1[];
    permissionOwnerLabel?: string;
    canApprove: boolean;
    /** The canonical one-line summary of the ask ("Run yarn test:ui"). */
    summary: string;
    command?: string;
    createdAtMs?: number;
    policy: SessionPermissionAnswerPolicy;
    /** Empty when this viewer may not approve (read-only share, inactive Session). */
    answers: readonly SessionPermissionAnswer[];
}>;

export function listSessionPendingPermissions(
    session: Session,
    accountScope: ServerAccountScope | null | undefined,
    permissionRequests: readonly SessionPendingRequest[] = listPendingPermissionRequests(session),
): readonly SessionPendingPermission[] {
    const canApprove = deriveTranscriptInteractionFromSession({
        access: session.access,
        active: session.active,
    }).canApprovePermissions;
    const metadata = session.metadata as Readonly<{ flavor?: string | null }> | null | undefined;
    return permissionRequests.map((request): SessionPendingPermission => {
        const hasNativeChoices = request.nativeChoices !== undefined;
        const policy: SessionPermissionAnswerPolicy = hasNativeChoices ? { protocol: 'unavailable', usePermissionUpdates: false } : resolveSessionPermissionAnswerPolicy({
            permissionBehavior: resolveSessionPermissionBehavior({
                agentId: resolveAgentIdForPermissionUi({
                    metadata: session.metadata,
                    flavor: metadata?.flavor,
                    toolName: request.tool,
                }),
                metadata: session.metadata,
                accountScope,
            }),
            suggestions: request.permissionSuggestions,
        });
        const command = extractShellCommand(request.arguments);
        return Object.freeze({
            requestId: request.id,
            toolName: request.tool,
            ...(request.turnId ? { turnId: request.turnId } : {}),
            ...(request.source ? { source: request.source } : {}),
            ...(hasNativeChoices ? { nativeChoices: request.nativeChoices } : {}),
            ...(request.nativeChoiceAvailability ? { nativeChoiceAvailability: request.nativeChoiceAvailability } : {}),
            ...(request.permissionOwnerLabel ? { permissionOwnerLabel: request.permissionOwnerLabel } : {}),
            canApprove,
            summary: formatPermissionRequestDisplaySummary({ toolName: request.tool, toolInput: request.arguments, mcpTool: request.mcpTool }),
            ...(command ? { command } : {}),
            ...(typeof request.createdAt === 'number' && request.createdAt >= 0
                ? { createdAtMs: Math.trunc(request.createdAt) }
                : {}),
            policy,
            answers: canApprove && !hasNativeChoices
                ? resolveSessionPermissionAnswers({ toolName: request.tool, protocol: policy.protocol, source: request.source })
                : [],
        });
    });
}
