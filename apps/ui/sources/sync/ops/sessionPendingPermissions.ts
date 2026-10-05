import { extractShellCommand, formatPermissionRequestSummary } from '@happier-dev/protocol';

import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { listPendingPermissionRequests } from '@/utils/sessions/sessionUtils';
import type { SessionPendingRequest } from '@happier-dev/session-core/pending';

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
 * richer, footer-only grants and is not replaced by this list.
 */
export type SessionPendingPermission = Readonly<{
    requestId: string;
    toolName: string;
    turnId?: string;
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
        const policy = resolveSessionPermissionAnswerPolicy({
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
            summary: formatPermissionRequestSummary({ toolName: request.tool, toolInput: request.arguments }),
            ...(command ? { command } : {}),
            ...(typeof request.createdAt === 'number' && request.createdAt >= 0
                ? { createdAtMs: Math.trunc(request.createdAt) }
                : {}),
            policy,
            answers: canApprove
                ? resolveSessionPermissionAnswers({ toolName: request.tool, protocol: policy.protocol })
                : [],
        });
    });
}
