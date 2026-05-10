import type { AgentId } from '@/agents/catalog/catalog';
import { buildClaudeReasoningEffortMessageMetaOverrides } from '@/agents/providers/claude/buildClaudeReasoningEffortMessageMetaOverrides';

type ProviderMessageMetaOverrideBuilder = (params: Readonly<{
    session: unknown;
    metaOverrides?: Record<string, unknown>;
}>) => Record<string, unknown> | undefined;

type ProviderMessageMetaOverrideRegistration = Readonly<{
    agentId: AgentId;
    buildOverrides: ProviderMessageMetaOverrideBuilder;
}>;

const PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS = new Map<AgentId, ProviderMessageMetaOverrideBuilder>();

function registerProviderMessageMetaOverrideBuilder(
    registration: ProviderMessageMetaOverrideRegistration,
): void {
    PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS.set(registration.agentId, registration.buildOverrides);
}

registerProviderMessageMetaOverrideBuilder({
    agentId: 'claude',
    buildOverrides: buildClaudeReasoningEffortMessageMetaOverrides,
});

export function resolveProviderRegisteredMessageMetaOverrides(args: Readonly<{
    agentId: AgentId;
    session: unknown;
    metaOverrides?: Record<string, unknown>;
}>): Record<string, unknown> | undefined {
    const builder = PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS.get(args.agentId);
    return builder?.({
        session: args.session,
        metaOverrides: args.metaOverrides,
    });
}
