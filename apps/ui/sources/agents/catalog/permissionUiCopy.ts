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

/**
 * Footer copy for whichever Agent owns a permission request.
 *
 * This is total on purpose. A pending request is unanswerable without a footer,
 * so every Agent resolves to copy: the declared protocol when this build ships a
 * core for it, and the neutral Claude-shaped default otherwise. An externally
 * installed Agent ships no bundled core and therefore lands on exactly the same
 * default as a bundled Agent whose protocol this build does not recognise.
 */
export function getPermissionFooterCopy(agentId: AgentId): PermissionFooterCopy {
    const protocol = getAgentCore(agentId)?.permissions.promptProtocol;
    if (protocol === 'codexDecision') {
        return {
            protocol,
            yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
            yesForSessionKey: 'codex.permissions.yesForSession',
            stopKey: 'codex.permissions.stop',
        };
    }

    return {
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    };
}
