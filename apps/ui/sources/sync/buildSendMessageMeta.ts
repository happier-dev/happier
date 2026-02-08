import type { AgentId } from '@/agents/catalog';

import { addProviderMessageMetaExtras } from '@/sync/messageMetaProviders';
import { buildOutgoingMessageMeta } from '@/sync/messageMeta';
import type { MessageMeta } from '@/sync/typesMessageMeta';

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
}): MessageMeta {
    const base = buildOutgoingMessageMeta({
        sentFrom: args.sentFrom,
        permissionMode: args.permissionMode,
        model: args.model,
        fallbackModel: args.fallbackModel,
        appendSystemPrompt: args.appendSystemPrompt,
        displayText: args.displayText,
    });

    return addProviderMessageMetaExtras({
        meta: base,
        agentId: args.agentId,
        settings: args.settings,
        session: args.session,
    });
}

