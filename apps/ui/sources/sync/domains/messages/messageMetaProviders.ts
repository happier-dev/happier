import type { AgentId } from '@/agents/catalog/catalog';
import { resolveProviderOutgoingMessageMetaExtras } from '@happier-dev/agents';
import { resolveProviderRegisteredMessageMetaOverrides } from '@/agents/registry/providerMessageMetaOverrides';

import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

const PROTOCOL_OWNED_MESSAGE_META_KEYS = new Set([
    'sentFrom',
    'source',
    'permissionMode',
    'model',
    'fallbackModel',
    'customSystemPrompt',
    'appendSystemPrompt',
    'allowedTools',
    'disallowedTools',
    'displayText',
    'happier',
]);

export function addProviderMessageMetaExtras(args: {
    meta: MessageMeta;
    agentId: AgentId | null;
    settings: Record<string, unknown>;
    session: unknown;
}): MessageMeta {
    if (!args.agentId) return args.meta;

    let extras: unknown;
    try {
        extras = resolveProviderOutgoingMessageMetaExtras({
            agentId: args.agentId,
            settings: args.settings,
            session: args.session,
        });
    } catch {
        return args.meta;
    }

    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return args.meta;

    const merged: MessageMeta = { ...args.meta };

    for (const [key, value] of Object.entries(extras as Record<string, unknown>)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (PROTOCOL_OWNED_MESSAGE_META_KEYS.has(key)) continue;
        if (Object.prototype.hasOwnProperty.call(merged, key)) continue;
        const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;
        const isSmallStringArray =
            Array.isArray(value)
            && value.length <= 16
            && value.every((entry) => typeof entry === 'string');
        if (!(isPrimitive || isSmallStringArray)) continue;
        (merged as Record<string, unknown>)[key] = value;
    }

    return merged;
}

export function resolveProviderMessageMetaOverrides(args: {
    agentId: AgentId | null;
    session: unknown;
    metaOverrides?: Partial<MessageMeta>;
}): Partial<MessageMeta> | undefined {
    if (!args.agentId) return args.metaOverrides;

    try {
        return resolveProviderRegisteredMessageMetaOverrides({
            agentId: args.agentId,
            session: args.session,
            metaOverrides: args.metaOverrides as Record<string, unknown> | undefined,
        }) as Partial<MessageMeta> | undefined ?? args.metaOverrides;
    } catch {
        return args.metaOverrides;
    }
}
