import type { AgentId } from '@/agents/catalog/catalog';
import {
    BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS,
    BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_DESCRIPTORS,
} from './generatedBundledPluginEntries.messageMetaOverrides';
import { createProviderMessageMetaOverrideBuilderFromDescriptor } from './providerMessageMetaDescriptors';

export function resolveProviderRegisteredMessageMetaOverrides(args: Readonly<{
    agentId: AgentId;
    session: unknown;
    metaOverrides?: Record<string, unknown>;
}>): Record<string, unknown> | undefined {
    const descriptor = BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_DESCRIPTORS[args.agentId]?.descriptor;
    const descriptorBuilder = descriptor
        ? createProviderMessageMetaOverrideBuilderFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: args.agentId,
            agentId: args.agentId,
            version: 1,
            message: descriptor,
        }).buildOverrides
        : null;
    const builder = descriptorBuilder ?? BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS[args.agentId];
    if (!builder) return args.metaOverrides;
    try {
        return builder({
            session: args.session,
            metaOverrides: args.metaOverrides,
        }) ?? args.metaOverrides;
    } catch {
        return args.metaOverrides;
    }
}
