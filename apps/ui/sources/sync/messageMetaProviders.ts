import type { AgentId } from '@/agents/catalog';
import { getProviderSettingsPlugin } from '@/agents/providers/_registry/providerSettingsRegistry';

import type { MessageMeta } from '@/sync/typesMessageMeta';

export function addProviderMessageMetaExtras(args: {
    meta: MessageMeta;
    agentId: AgentId | null;
    settings: Record<string, unknown>;
    session: unknown;
}): MessageMeta {
    if (!args.agentId) return args.meta;

    const plugin = getProviderSettingsPlugin(args.agentId);
    if (!plugin) return args.meta;

    let extras: unknown;
    try {
        extras = plugin.buildOutgoingMessageMetaExtras({
            settings: args.settings,
            session: args.session,
            agentId: args.agentId,
        });
    } catch {
        return args.meta;
    }

    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return args.meta;

    const merged: MessageMeta = { ...args.meta };

    for (const [key, value] of Object.entries(extras as Record<string, unknown>)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (Object.prototype.hasOwnProperty.call(merged, key)) continue;
        if (!(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)) continue;
        (merged as Record<string, unknown>)[key] = value;
    }

    return merged;
}
