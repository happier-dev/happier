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

export const TOOLS_WITH_CUSTOM_PERMISSION_UI = new Set<string>([
    'AskUserQuestion',
    'ask_user_question',
    'ExitPlanMode',
    'exit_plan_mode',
    'AcpHistoryImport',
]);

export type AgentRequestKind = 'permission' | 'user_action';

function normalizeAgentRequestKind(rawKind: unknown): AgentRequestKind | null {
    if (rawKind === 'permission') return 'permission';
    if (rawKind === 'user_action') return 'user_action';
    return null;
}

export function resolveAgentRequestKind(params: Readonly<{ toolName: string; requestKind?: unknown }>): AgentRequestKind {
    const normalized = normalizeAgentRequestKind(params.requestKind);
    if (normalized) return normalized;

    // Back-compat / defensive fallback: older agents may not publish requestKind, so we infer using
    // the existing "custom UI tool" list (these should never render a generic permission prompt).
    if (TOOLS_WITH_CUSTOM_PERMISSION_UI.has(params.toolName)) {
        return 'user_action';
    }

    return 'permission';
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
