import type { AgentId } from '@/agents/catalog/catalog';
import { buildClaudeReasoningEffortMessageMetaOverrides } from '@/agents/providers/claude/buildClaudeReasoningEffortMessageMetaOverrides';

import { addProviderMessageMetaExtras } from '@/sync/domains/messages/messageMetaProviders';
import { buildOutgoingMessageMeta } from '@/sync/domains/messages/messageMeta';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

export function buildSendMessageMeta(args: {
    sentFrom: string;
    permissionMode: NonNullable<MessageMeta['permissionMode']>;
    appendSystemPrompt?: string;
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

    const metaOverrides = args.agentId === 'claude'
        ? buildClaudeReasoningEffortMessageMetaOverrides({
            session: args.session,
            metaOverrides: args.metaOverrides as Record<string, unknown> | undefined,
        })
        : args.metaOverrides;

    if (!metaOverrides) return withProviderExtras;
    return {
        ...withProviderExtras,
        ...metaOverrides,
    };
}
