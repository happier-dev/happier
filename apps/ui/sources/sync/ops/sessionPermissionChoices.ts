import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import type { SessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { parseParenIdentifier } from '@happier-dev/session-core/tools';

import { getPermissionFooterCopy } from '@/agents/catalog/permissionUiCopy';
import { t } from '@/text';
import { resolveSessionPermissionAnswerPolicy, resolveSessionPermissionAnswers, supportsSessionPermissionPersistence,
    type resolveSessionPermissionBehavior } from './sessionPermissionAnswers';

export type SessionPermissionChoice = Readonly<{
    id: 'allow' | 'always_allow' | 'allow_all_edits' | 'allow_subcommand' | 'allow_command' | 'allow_execpolicy' | 'mcp_always_allow' | 'deny' | 'stop';
    label: string;
    response: Omit<SessionPermissionRespondRpcParamsV1, 'id' | 'turnId' | 'answers'>;
    catalog?: Readonly<{ identity: ResolvedMcpToolIdentityV1; source?: string }>;
}>;

/** Catalog consent is available only for the existing external, persistent request scope. */
export function canPersistSessionMcpPermission(input: Readonly<{
    identity?: ResolvedMcpToolIdentityV1 | null; source?: string; canWriteCatalog: boolean;
}>): boolean {
    return input.canWriteCatalog && Boolean(input.identity && input.identity.server !== 'happier')
        && supportsSessionPermissionPersistence(input.source);
}

/** The Session's choices, shared by its transcript and every permission presenter. */
export function resolveSessionPermissionChoices(input: Readonly<{
    toolName: string;
    toolInput?: unknown;
    source?: string;
    suggestions?: unknown;
    mcpTool?: ResolvedMcpToolIdentityV1;
    canWriteCatalog?: boolean;
    permissionBehavior: ReturnType<typeof resolveSessionPermissionBehavior>;
}>): readonly SessionPermissionChoice[] {
    const { toolName, permissionBehavior } = input;
    const policy = resolveSessionPermissionAnswerPolicy({ permissionBehavior, suggestions: input.suggestions });
    const answers = resolveSessionPermissionAnswers({ toolName, protocol: policy.protocol, source: input.source });
    const deny: SessionPermissionChoice = { id: 'deny', label: t('common.no'), response: { approved: false, decision: 'denied' } };
    if (!answers.includes('allowOnce')) return [deny];
    const copy = getPermissionFooterCopy(permissionBehavior?.promptProtocol);
    if (copy.protocol === 'unavailable') return [deny];
    const choices: SessionPermissionChoice[] = [{ id: 'allow', label: t('settingsDesktop.overlay.notchAllowOnce'),
        response: { approved: true, decision: 'approved' } }];
    const persistent = supportsSessionPermissionPersistence(input.source);
    if (copy.protocol === 'codexDecision') {
        const raw = input.toolInput && typeof input.toolInput === 'object' ? input.toolInput as Record<string, unknown> : {};
        const amendment = raw.proposedExecpolicyAmendment ?? raw.proposed_execpolicy_amendment;
        const command = Array.isArray(amendment) ? amendment.filter((part): part is string => typeof part === 'string' && part.length > 0) : [];
        if (persistent && permissionBehavior?.footer?.supportsExecPolicyAmendment === true && command.length > 0) {
            choices.push({ id: 'allow_execpolicy', label: t(copy.yesAlwaysAllowCommandKey),
                response: { approved: true, decision: 'approved_execpolicy_amendment', execPolicyAmendment: { command } } });
        }
        if (answers.includes('allowForSession')) choices.push({ id: 'always_allow', label: t(copy.yesForSessionKey),
            response: { approved: true, decision: 'approved_for_session' } });
    } else {
        if (persistent && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName)) {
            choices.push({ id: 'allow_all_edits', label: t(copy.yesAllowAllEditsKey), response: {
                approved: true, decision: 'approved', mode: 'acceptEdits',
                ...(policy.usePermissionUpdates ? { updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } : {}),
            } });
        }
        const toolRule = (id: SessionPermissionChoice['id'], label: string, identifier: string) => {
            const parsed = parseParenIdentifier(identifier);
            choices.push({ id, label, response: { approved: true, decision: 'approved', allowedTools: [identifier],
                ...(policy.usePermissionUpdates ? { updatedPermissions: [{ type: 'addRules',
                    rules: [parsed ? { toolName: parsed.name, ...(parsed.spec ? { ruleContent: parsed.spec } : {}) } : { toolName: identifier }],
                    behavior: 'allow', destination: 'session' }] } : {}),
            } });
        };
        if (answers.includes('allowForSession')) {
            toolRule('always_allow', `${t(copy.yesForToolKey)} ${toolName}`, toolName);
            const command = extractShellCommand(input.toolInput);
            if (['bash', 'execute', 'shell'].includes(toolName.toLowerCase()) && command && isBroadShellGrantEligible(command)) {
                const [cmd, sub] = command.trim().split(/\s+/).filter(Boolean);
                if (cmd && sub && !sub.startsWith('-') && ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd)) {
                    toolRule('allow_subcommand', `${t('claude.permissions.yesForSubcommand')} (${cmd} ${sub})`, `${toolName}(${cmd} ${sub}:*)`);
                }
                if (cmd) toolRule('allow_command', `${t('claude.permissions.yesForCommandName')} (${cmd})`, `${toolName}(${cmd}:*)`);
            }
        }
    }
    const sessionGrant = choices.find(choice => choice.id === 'always_allow');
    if (sessionGrant && input.mcpTool && canPersistSessionMcpPermission({ identity: input.mcpTool,
        source: input.source, canWriteCatalog: input.canWriteCatalog === true })) {
        choices.push({ id: 'mcp_always_allow', label: t('capabilities.session.toolAsk.alwaysAllow'),
            response: sessionGrant.response, catalog: { identity: input.mcpTool, source: input.source } });
    }
    choices.push(deny, { id: 'stop', label: t(copy.stopKey), response: { approved: false,
        decision: permissionBehavior?.footer?.stopHandling === 'denyOnly' ? 'denied' : 'abort' } });
    return choices;
}

/** Existing Session rule eligibility, also used to recognize its selected grants. */
export function isBroadShellGrantEligible(command: string): boolean {
    const trimmed = command.trim();
    return trimmed.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) && !/^unset(?:\s|$)/.test(trimmed)
        && !/[;&|<>`\r\n]/.test(trimmed) && !trimmed.includes('$(');
}
