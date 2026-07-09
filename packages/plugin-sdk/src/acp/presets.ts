import { parsePermissionIntentAlias, type PermissionIntent } from '@happier-dev/agents';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

import type { AcpTimeoutsV1, AcpToolNameInferenceV1, AcpToolNamePatternV1 } from './types.js';

export type AcpPermissionIntentV1 = PermissionIntent;

export const ACP_AGENT_CLI_TRANSPORT_TIMEOUTS = Object.freeze({
    initMs: 90_000,
    toolCallMs: 120_000,
    investigationToolCallMs: 300_000,
    toolKindTimeouts: {
        think: 30_000,
    },
    idleMs: 500,
} satisfies AcpTimeoutsV1);

const ACP_COMMON_TOOL_NAME_PATTERNS = Object.freeze([
    { name: 'change_title', patterns: CHANGE_TITLE_TOOL_NAME_ALIASES, inputFields: ['title'] },
    { name: 'think', patterns: ['think'], inputFields: ['thought', 'thinking'] },
    { name: 'read', patterns: ['read', 'read_file', 'read-file'], inputFields: ['path', 'filePath', 'uri'] },
    { name: 'write', patterns: ['write', 'write_file', 'write_to_file', 'write-file'], inputFields: ['path', 'filePath', 'content', 'text'] },
    { name: 'edit', patterns: ['edit', 'apply_diff', 'apply_patch', 'apply-diff', 'apply-patch'], inputFields: ['changes', 'old_string', 'new_string', 'edits'] },
    { name: 'bash', patterns: ['bash', 'shell', 'exec', 'exec_command', 'execute_command'], inputFields: ['command', 'cmd'] },
    { name: 'glob', patterns: ['glob', 'glob_files'], inputFields: ['pattern', 'glob'] },
    { name: 'grep', patterns: ['grep', 'search_code', 'code_search'], inputFields: ['pattern', 'query', 'text'] },
    { name: 'ls', patterns: ['ls', 'list_files', 'ls_files'], inputFields: ['path', 'dir'] },
    { name: 'task', patterns: ['task', 'subtask'], inputFields: ['prompt'] },
    { name: 'mcp', patterns: ['use_mcp_tool', 'access_mcp_resource'], inputFields: ['server', 'tool', 'name', 'uri'] },
] satisfies readonly AcpToolNamePatternV1[]);

export function createAcpToolNameInferencePreset(options?: Readonly<{
    shellBridgeHint?: boolean;
}>): AcpToolNameInferenceV1 {
    return Object.freeze({
        preferLongestPattern: true,
        unknownToolNames: ['other', 'Unknown tool', 'unknown'],
        hintInputFields: ['tool_name', 'toolName', 'name'],
        ...(options?.shellBridgeHint === true ? { shellBridgeHint: true } : {}),
        investigationToolIdPatterns: ['task'],
        investigationToolKinds: ['task'],
        patterns: ACP_COMMON_TOOL_NAME_PATTERNS,
    } satisfies AcpToolNameInferenceV1);
}

export function normalizeAcpPermissionIntent(
    permissionMode: string | null | undefined,
    fallback: AcpPermissionIntentV1 = 'default',
): AcpPermissionIntentV1 {
    return parsePermissionIntentAlias(permissionMode ?? fallback) ?? fallback;
}

export type AcpToolPermissionValueV1 = 'allow' | 'ask' | 'deny';
export type AcpToolPermissionPolicyV1 = Readonly<Record<string, AcpToolPermissionValueV1>>;

const ACP_TOOL_READ_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'ls'] as const;
const ACP_TOOL_EDIT_PERMISSIONS = ['edit', 'write'] as const;
const ACP_TOOL_OTHER_COMMON_PERMISSIONS = ['bash', 'task'] as const;
const ACP_TOOL_SAFE_NAME_TOKENS = [
    'session_title_set',
    'save_memory',
    'think',
] as const;

export const ACP_WRITE_LIKE_PERMISSION_KINDS = Object.freeze([
    'external_directory',
    'doom_loop',
] as const);

const ACP_HAPPIER_ACTION_TOOL_NAME_ALIASES = [
    'action_execute',
    'happier_action_execute',
    'happier__action_execute',
    'mcp__happier__action_execute',
    'action_spec_search',
    'happier_action_spec_search',
    'happier__action_spec_search',
    'mcp__happier__action_spec_search',
    'action_spec_get',
    'happier_action_spec_get',
    'happier__action_spec_get',
    'mcp__happier__action_spec_get',
    'action_options_resolve',
    'happier_action_options_resolve',
    'happier__action_options_resolve',
    'mcp__happier__action_options_resolve',
] as const;

// Narrow first-party Happier MCP bridge operations that ACP backends may mark
// as static approvals in provider config. Direct `action_execute` remains
// governed by the normal runtime permission path because it may trigger
// side-effectful actions.
export const ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES = Object.freeze([
    'action_options_resolve',
    'action_spec_get',
    'action_spec_search',
    'change_title',
    'session_title_set',
] as const);

const ACP_TOOL_SAFE_ALLOW_PERMISSIONS = [
    ...CHANGE_TITLE_TOOL_NAME_ALIASES,
    ...ACP_HAPPIER_ACTION_TOOL_NAME_ALIASES,
    ...ACP_TOOL_SAFE_NAME_TOKENS,
] as const;

const ACP_TOOL_KNOWN_PERMISSION_KEYS = [
    ...ACP_TOOL_READ_PERMISSIONS,
    ...ACP_TOOL_EDIT_PERMISSIONS,
    ...ACP_TOOL_OTHER_COMMON_PERMISSIONS,
    ...ACP_TOOL_SAFE_ALLOW_PERMISSIONS,
    ...ACP_WRITE_LIKE_PERMISSION_KINDS,
] as const;

function setPermissions(
    permissions: ReadonlyArray<string>,
    value: AcpToolPermissionValueV1,
): Record<string, AcpToolPermissionValueV1> {
    const policy: Record<string, AcpToolPermissionValueV1> = {};
    for (const permission of permissions) {
        policy[permission] = value;
    }
    return policy;
}

function allowPermissions(permissions: ReadonlyArray<string>): Record<string, AcpToolPermissionValueV1> {
    return setPermissions(permissions, 'allow');
}

export function resolveAcpToolPermissionPolicy(
    permissionMode: string | null | undefined,
): AcpToolPermissionPolicyV1 {
    const intent = normalizeAcpPermissionIntent(permissionMode);

    if (intent === 'yolo') {
        return {
            '*': 'allow',
            ...setPermissions(ACP_TOOL_KNOWN_PERMISSION_KEYS, 'allow'),
            ...allowPermissions(ACP_TOOL_SAFE_ALLOW_PERMISSIONS),
        };
    }

    if (intent === 'safe-yolo') {
        return {
            '*': 'ask',
            ...setPermissions(ACP_TOOL_KNOWN_PERMISSION_KEYS, 'ask'),
            ...allowPermissions(ACP_TOOL_SAFE_ALLOW_PERMISSIONS),
            ...allowPermissions(ACP_TOOL_READ_PERMISSIONS),
            ...allowPermissions(ACP_TOOL_EDIT_PERMISSIONS),
        };
    }

    if (intent === 'read-only' || intent === 'plan') {
        return {
            '*': 'deny',
            ...setPermissions(ACP_TOOL_KNOWN_PERMISSION_KEYS, 'deny'),
            ...allowPermissions(ACP_TOOL_SAFE_ALLOW_PERMISSIONS),
            ...allowPermissions(ACP_TOOL_READ_PERMISSIONS),
        };
    }

    return {
        '*': 'ask',
        ...setPermissions(ACP_TOOL_KNOWN_PERMISSION_KEYS, 'ask'),
        ...allowPermissions(ACP_TOOL_SAFE_ALLOW_PERMISSIONS),
        ...allowPermissions(ACP_TOOL_READ_PERMISSIONS),
    };
}
