import {
    resolveAgentUiBehavior,
    resolveOwningMachineIdForSession,
} from '@/agents/registry/registryUiBehavior';

import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

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
        return resolveAgentUiBehavior(
            args.agentId,
            resolveOwningMachineIdForSession(args.session),
        ).message?.buildOverrides?.({
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
