import type { AgentId } from '@/agents/catalog/catalog';

import { addProviderMessageMetaExtras } from '@/sync/domains/messages/messageMetaProviders';
import { buildOutgoingMessageMeta } from '@/sync/domains/messages/messageMeta';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

export function buildSendMessageMeta(args: {
    sentFrom: string;
    permissionMode: NonNullable<MessageMeta['permissionMode']>;
    appendSystemPrompt: string;
    model?: MessageMeta['model'];
    fallbackModel?: MessageMeta['fallbackModel'];
    displayText?: string;
    agentId: AgentId | null;
    settings: Record<string, unknown>;
    session: unknown;
    metaOverrides?: Partial<MessageMeta>;
}): MessageMeta {
    const base = buildOutgoingMessageMeta({
        sentFrom: args.sentFrom,
        permissionMode: args.permissionMode,
        model: args.model,
        fallbackModel: args.fallbackModel,
        appendSystemPrompt: args.appendSystemPrompt,
        displayText: args.displayText,
    });

    const withProviderExtras = addProviderMessageMetaExtras({
        meta: base,
        agentId: args.agentId,
        settings: args.settings,
        session: args.session,
    });

    if (!args.metaOverrides) return withProviderExtras;
    return {
        ...withProviderExtras,
        ...args.metaOverrides,
    };
}
