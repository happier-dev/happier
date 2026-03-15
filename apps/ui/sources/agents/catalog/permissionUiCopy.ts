import type { TranslationKey } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/registry/registryCore';

export type PermissionFooterCopy =
    | Readonly<{
        protocol: 'codexDecision';
        yesAlwaysAllowCommandKey: TranslationKey;
        yesForSessionKey: TranslationKey;
        stopKey: TranslationKey;
    }>
    | Readonly<{
        protocol: 'claude';
        yesAllowAllEditsKey: TranslationKey;
        yesForToolKey: TranslationKey;
        stopKey: TranslationKey;
    }>;

export function getPermissionFooterCopy(agentId: AgentId): PermissionFooterCopy {
    const protocol = getAgentCore(agentId).permissions.promptProtocol;
    if (protocol === 'codexDecision') {
        return {
            protocol,
            yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
            yesForSessionKey: 'codex.permissions.yesForSession',
            stopKey: 'codex.permissions.stop',
        };
    }

    if (protocol === 'claude') {
        return {
            protocol: 'claude',
            yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
            yesForToolKey: 'claude.permissions.yesForTool',
            stopKey: 'claude.permissions.stop',
        };
    }

    return {
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    };
}
