import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveHappierActionForMcpToolName } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import { resolveAgentRequestKind } from './requestKind';
import { isSharedPermissionSafeToolName, isSharedPermissionWriteLikeToolName } from './permissionTaxonomy';
import { isShellCommandAllowed } from './shellCommandAllowlist';

// Role ceilings never inherit approval grants. Diff/log prefixes can invoke writers.
const READ_ONLY_SHELL_PATTERNS: Array<{ kind: 'exact' | 'prefix'; value: string }> = [
    { kind: 'exact', value: 'pwd' },
    { kind: 'prefix', value: 'ls' },
    { kind: 'prefix', value: 'cat' },
    { kind: 'prefix', value: 'git status' },
    { kind: 'exact', value: 'git --no-pager diff --no-ext-diff --no-textconv --stat' },
    { kind: 'exact', value: 'git --no-pager diff --no-ext-diff --no-textconv --name-only' },
];

export function isWorkspaceWriteDeniedByRole(input: Readonly<{
    workspaceWrites?: 'allow' | 'deny';
    toolName: string;
    toolInput?: unknown;
}>): boolean {
    if (input.workspaceWrites !== 'deny' || resolveAgentRequestKind(input.toolName) === 'user_action') return false;
    const actionId = resolveHappierActionForMcpToolName({ toolName: input.toolName, input: input.toolInput });
    if (actionId) return getActionSpec(actionId).workspaceWrite === true;
    if (isSharedPermissionSafeToolName(input.toolName)) return false;
    const normalized = input.toolName.trim().toLowerCase();
    if (normalized === 'bash' || normalized === 'execute' || normalized === 'shell') {
        const command = extractShellCommand(input.toolInput);
        return !command || !isShellCommandAllowed(command, READ_ONLY_SHELL_PATTERNS);
    }
    return isSharedPermissionWriteLikeToolName(input.toolName);
}
