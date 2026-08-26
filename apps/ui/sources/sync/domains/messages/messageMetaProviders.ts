import {
    resolveAgentUiBehavior,
    resolveOwningMachineIdForSession,
} from '@/agents/registry/registryUiBehavior';
import { BUNDLED_CANONICAL_AGENT_PREDECESSOR_MESSAGE_META_WRITERS } from '@/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides';

import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

function mergePredecessorMessageMeta(
    metaOverrides: Partial<MessageMeta> | undefined,
    extras: Readonly<Record<string, string | number | boolean | null | readonly string[]>>,
): Partial<MessageMeta> {
    const merged: Record<string, unknown> = { ...(metaOverrides ?? {}) };
    for (const [key, value] of Object.entries(extras)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (Object.hasOwn(merged, key)) continue;
        merged[key] = value;
    }
    return merged as Partial<MessageMeta>;
}

export function resolveProviderMessageMetaOverrides(args: {
    agentId: string | null;
    session: unknown;
    settings?: Record<string, unknown>;
    metaOverrides?: Partial<MessageMeta>;
}): Partial<MessageMeta> | undefined {
    if (!args.agentId) return args.metaOverrides;

    try {
        // The overrides travel outbound to the Agent running this Session, so
        // they are built from the declaration held by that Session's machine.
        const metaOverrides = resolveAgentUiBehavior(
            args.agentId,
            resolveOwningMachineIdForSession(args.session),
        ).message?.buildOverrides?.({
            session: args.session,
            settings: args.settings,
            metaOverrides: args.metaOverrides as Record<string, unknown> | undefined,
        }) as Partial<MessageMeta> | undefined ?? args.metaOverrides;
        const predecessorWriter = BUNDLED_CANONICAL_AGENT_PREDECESSOR_MESSAGE_META_WRITERS[
            args.agentId as keyof typeof BUNDLED_CANONICAL_AGENT_PREDECESSOR_MESSAGE_META_WRITERS
        ];
        if (!predecessorWriter) return metaOverrides;
        return mergePredecessorMessageMeta(
            metaOverrides,
            predecessorWriter.buildPredecessorMessageMeta(args.settings ?? {}),
        );
    } catch (error) {
        console.error('[messageMetaProviders] provider message metadata overrides failed', {
            agentId: args.agentId,
            errorName: error instanceof Error && error.name.trim().length > 0 ? error.name : 'UnknownError',
        });
        return args.metaOverrides;
    }
}
