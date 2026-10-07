import { resolveAgentRequestKind, type AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

/**
 * One request recorded in an invocation's private interaction state.
 *
 * `kind` is the Protocol's answer, never inferred here: a structured agent
 * question (`user_action`) and a tool permission are different contracts with
 * different answer owners, and presenting a question as Allow/Deny would send
 * the agent a decision it cannot use. The canonical prompt cards read the
 * question contract from `arguments` themselves.
 */
export type WorkflowInvocationRequest = Readonly<{
    requestId: string;
    kind: AgentRequestKind;
    tool: string;
    arguments: unknown;
}>;

export type WorkflowPermissionRequest = Readonly<{
    requestId: string;
    tool: string;
    arguments: unknown;
}>;

/**
 * The one UI projection of requests recorded in invocation content.
 *
 * Both presentation and response reconciliation consume this projection. That
 * keeps malformed/private content from being considered actionable by one path
 * while another path silently waits for it or treats it as withdrawn.
 */
export function projectWorkflowInvocationRequests(
    progress: WorkflowProgressEnvelopeV1 | null | undefined,
): readonly WorkflowInvocationRequest[] {
    const interaction = progress?.interaction;
    const interactionRecord = interaction && typeof interaction === 'object' && !Array.isArray(interaction)
        ? interaction as Record<string, unknown>
        : null;
    const requestsRecord = interactionRecord?.requests && typeof interactionRecord.requests === 'object'
        && !Array.isArray(interactionRecord.requests)
        ? interactionRecord.requests as Record<string, unknown>
        : {};

    return Object.entries(requestsRecord).flatMap(([requestId, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const request = value as Record<string, unknown>;
        const tool = typeof request.tool === 'string' && request.tool.trim() ? request.tool.trim() : null;
        if (tool === null) return [];
        const kind = resolveAgentRequestKind({ toolName: tool, requestKind: request.kind });
        return [{ requestId, kind, tool, arguments: request.arguments }];
    });
}

/** Only the tool permissions: the requests a Boolean decision can settle. */
export function projectWorkflowPermissionRequests(
    progress: WorkflowProgressEnvelopeV1 | null | undefined,
): readonly WorkflowPermissionRequest[] {
    return projectWorkflowInvocationRequests(progress)
        .filter((request) => request.kind === 'permission')
        .map(({ requestId, tool, arguments: toolArguments }) => ({ requestId, tool, arguments: toolArguments }));
}

export function hasWorkflowPermissionRequest(
    progress: WorkflowProgressEnvelopeV1 | null | undefined,
    requestId: string,
): boolean {
    return projectWorkflowPermissionRequests(progress).some((request) => request.requestId === requestId);
}

export function hasWorkflowInvocationRequest(
    progress: WorkflowProgressEnvelopeV1 | null | undefined,
    requestId: string,
): boolean {
    return projectWorkflowInvocationRequests(progress).some((request) => request.requestId === requestId);
}
