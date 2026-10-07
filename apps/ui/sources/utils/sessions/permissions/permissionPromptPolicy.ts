import { resolveAgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';

export type PermissionPromptSurfaceSetting = 'composer' | 'transcript' | 'both';

export type ResolvedPermissionPromptSurface = 'composer' | 'transcript';

/**
 * Resolve the permission prompt surface to a single location to avoid duplicated prompts.
 *
 * Note: legacy setting value `'both'` is treated as `'composer'` to keep the most actionable
 * prompt near the input on mobile and avoid rendering two full PermissionFooters.
 */
export function resolvePermissionPromptSurface(setting: unknown): ResolvedPermissionPromptSurface {
    return setting === 'transcript' ? 'transcript' : 'composer';
}

export function shouldShowGenericPermissionPromptForToolName(toolName: string): boolean {
    return resolveAgentRequestKind({ toolName }) !== 'user_action';
}

export function shouldShowGenericPermissionPromptForRequest(params: Readonly<{ toolName: string; requestKind?: unknown }>): boolean {
    return resolveAgentRequestKind(params) !== 'user_action';
}

export function isPendingUserActionRequest(params: Readonly<{
    toolName: string;
    requestKind?: unknown;
    permissionStatus?: unknown;
}>): boolean {
    return (
        resolveAgentRequestKind({ toolName: params.toolName, requestKind: params.requestKind }) === 'user_action' &&
        params.permissionStatus === 'pending'
    );
}
