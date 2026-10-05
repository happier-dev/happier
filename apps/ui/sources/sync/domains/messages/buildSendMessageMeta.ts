import { resolveProviderMessageMetaOverrides } from '@/sync/domains/messages/messageMetaProviders';
import { buildOutgoingMessageMeta } from "@happier-dev/session-core/messages";
import type { MessageMeta } from "@happier-dev/session-core/messages";

export function buildSendMessageMeta(args: {
    sentFrom: NonNullable<MessageMeta['sentFrom']>;
    permissionMode: NonNullable<MessageMeta['permissionMode']>;
    appendSystemPrompt?: string;
    model?: MessageMeta['model'];
    fallbackModel?: MessageMeta['fallbackModel'];
    displayText?: string;
    agentId: string | null;
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

    const metaOverrides = resolveProviderMessageMetaOverrides({
        agentId: args.agentId,
        session: args.session,
        settings: args.settings,
        metaOverrides: args.metaOverrides,
    });

    if (!metaOverrides) return base;
    return {
        ...base,
        ...metaOverrides,
    };
}
