import type { Session } from '../session';
import { resolveClaudeUnifiedTerminalResponseLocations } from '@happier-dev/agents';
import { isAskUserQuestionToolName } from '@happier-dev/protocol';
import { isSidechainSessionHook } from '../utils/sessionHookAttribution';
import type { PermissionHookData, PermissionHookResponse, SessionHookData } from '../utils/startHookServer';
import { DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE, type ClaudeLocalPermissionBridge } from './localPermissionBridge';

export function isClaudeLocalPermissionBridgeNeeded(
    settings: Readonly<Record<string, unknown>>,
    unifiedTerminalActive: boolean,
): boolean {
    if (!unifiedTerminalActive) return settings.claudeLocalPermissionBridgeEnabled !== false;
    const locations = resolveClaudeUnifiedTerminalResponseLocations(settings);
    // The hook bridge also serves subagents, whose prompt is not the primary terminal form.
    return locations.question !== 'terminal_only' || locations.permission !== 'terminal_only';
}

/** One ingress for ordinary and fast-start runners; the selected delivery owns the request. */
export async function routeClaudePermissionHook(params: Readonly<{
    data: PermissionHookData;
    options?: Readonly<{ signal?: AbortSignal }>;
    session: Pick<Session, 'onClaudeSessionHook'> | null;
    settings: Readonly<Record<string, unknown>>;
    unifiedTerminalActive: boolean;
    bridge: ClaudeLocalPermissionBridge | null;
}>): Promise<PermissionHookResponse> {
    const hookEventName = params.data.hook_event_name ?? params.data.hookEventName;
    const toolName = params.data.tool_name ?? params.data.toolName;
    const question = typeof toolName === 'string' && isAskUserQuestionToolName(toolName);
    const locations = resolveClaudeUnifiedTerminalResponseLocations(params.settings);
    const location = question ? locations.question : locations.permission;
    const native = params.unifiedTerminalActive && location !== 'app_only';
    const fallback: PermissionHookResponse = {
        ...DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
        hookSpecificOutput: { hookEventName: hookEventName === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest' },
    };
    if (native && (!isSidechainSessionHook(params.data) || location === 'terminal_only')) {
        // AskUserQuestion emits BOTH hooks. Its PreToolUse is the one producer with the exact
        // tool-use identity; forwarding PermissionRequest too would create a second occurrence.
        if (!question || hookEventName === 'PreToolUse') {
            params.session?.onClaudeSessionHook({
                ...params.data,
                hook_event_name: 'ClaudeNativePrompt', hookEventName: 'ClaudeNativePrompt',
                happierResponseLocation: location,
            });
        }
        return fallback;
    }
    const publish = (hookEventName: string): void => {
        const data: SessionHookData = { ...params.data, hook_event_name: hookEventName, hookEventName };
        params.session?.onClaudeSessionHook(data);
    };
    publish('PermissionRequest');
    try {
        if ((!params.unifiedTerminalActive && params.settings.claudeLocalPermissionBridgeEnabled === false) || !params.bridge) {
            return fallback;
        }
        return await params.bridge.handlePermissionHook(params.data, params.options);
    } finally {
        publish('PermissionRequestCompleted');
    }
}
