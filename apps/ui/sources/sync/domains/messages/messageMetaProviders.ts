import type { AgentId } from '@/agents/catalog/catalog';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';

import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

export function resolveProviderMessageMetaOverrides(args: {
    agentId: AgentId | null;
    session: unknown;
    settings?: Record<string, unknown>;
    metaOverrides?: Partial<MessageMeta>;
}): Partial<MessageMeta> | undefined {
    if (!args.agentId) return args.metaOverrides;

    try {
        return resolveAgentUiBehavior(args.agentId).message?.buildOverrides?.({
            session: args.session,
            settings: args.settings,
            metaOverrides: args.metaOverrides as Record<string, unknown> | undefined,
        }) as Partial<MessageMeta> | undefined ?? args.metaOverrides;
    } catch (error) {
        console.error('[messageMetaProviders] provider message metadata overrides failed', {
            agentId: args.agentId,
            errorName: error instanceof Error && error.name.trim().length > 0 ? error.name : 'UnknownError',
        });
        return args.metaOverrides;
    }
}
