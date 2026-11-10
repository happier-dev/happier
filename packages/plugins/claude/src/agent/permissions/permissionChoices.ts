import { createMcpCatalogPermissionChoiceV1 } from '@happier-dev/plugin-sdk/interactions';
import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

/** Claude's existing external MCP tool category. */
export function isClaudeExternalMcpTool(toolName: string): boolean {
    return toolName.startsWith('mcp__') && !toolName.startsWith('mcp__happier__') && !toolName.startsWith('mcp__happy__');
}

/** Claude's native permission response policy belongs to its request producer. */
export function buildClaudePermissionChoices(input: Readonly<{
    requestId: string; toolName: string; toolInput: unknown; allowSessionPersistence?: boolean;
    mcpTool?: ResolvedMcpToolIdentityV1 | null;
}>): NativePermissionChoicesV1 {
    const { toolName } = input;
    const exitPlan = toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode';
    const choices: NativePermissionChoicesV1['choices'][number][] = exitPlan ? [] : [{
        id: 'allow', label: 'Allow once', decision: 'approved', scope: 'once',
        response: { approved: true, decision: 'approved' },
    }];
    if (exitPlan && input.allowSessionPersistence !== false) {
        for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
            choices.push({ id: `approve:${mode}`, label: `Approve plan (${mode})`, decision: 'approved', scope: 'session',
                response: { approved: true, decision: 'approved', mode,
                    updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } });
        }
    }
    if (isClaudeExternalMcpTool(toolName) && input.mcpTool) {
        const catalogChoice = createMcpCatalogPermissionChoiceV1({ mcpTool: input.mcpTool, existingChoices: choices,
            grant: { id: 'always_allow', label: 'Allow for this session', decision: 'approved', scope: 'session',
                response: { approved: true, decision: 'approved', allowedTools: [toolName],
                    updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName }] }] } },
        });
        if (catalogChoice) choices.push(catalogChoice);
    }
    const edit = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName);
    if (edit && input.allowSessionPersistence !== false) choices.push({
        id: 'allow_all_edits', label: 'Allow all edits for this session', decision: 'approved', scope: 'session',
        response: { approved: true, decision: 'approved', mode: 'acceptEdits',
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
    });
    const addRule = (id: string, label: string, ruleContent?: string) => {
        const identifier = ruleContent ? `${toolName}(${ruleContent})` : toolName;
        choices.push({ id, label, decision: 'approved', scope: 'session', rulePreview: identifier,
            response: { approved: true, decision: 'approved', allowedTools: [identifier],
                updatedPermissions: [{
                type: 'addRules', behavior: 'allow', destination: 'session',
                rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }],
            }] } });
    };
    if (input.allowSessionPersistence !== false && !edit && toolName && toolName !== 'ExitPlanMode' && toolName !== 'exit_plan_mode') {
        addRule('always_allow', `Allow ${toolName} for this session`);
        const command = extractShellCommand(input.toolInput)?.trim();
        if (['bash', 'execute', 'shell'].includes(toolName.toLowerCase()) && command
            && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(command) && !/^unset(?:\s|$)/.test(command)
            && !/[;&|<>`\r\n]/.test(command) && !command.includes('$(')) {
            const [cmd, sub] = command.split(/\s+/);
            if (cmd && sub && !sub.startsWith('-') && ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd)) {
                addRule('allow_subcommand', `Allow ${cmd} ${sub} for this session`, `${cmd} ${sub}:*`);
            }
            if (cmd) addRule('allow_command', `Allow ${cmd} for this session`, `${cmd}:*`);
        }
    }
    choices.push({ id: 'deny', label: 'Deny', decision: 'denied', scope: 'once', ...(exitPlan ? { allowsFeedback: true } : {}), response: { approved: false, decision: 'denied' } },
        { id: 'stop', label: 'Stop', decision: 'abort', scope: 'session', response: { approved: false, decision: 'abort', mode: 'read-only' } });
    return { requirementId: input.requestId, source: 'claude', choices };
}
