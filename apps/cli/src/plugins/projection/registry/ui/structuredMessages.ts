import type { ResolvedContributionRegistry } from '../types';

type PluginUiProjectedEntry = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: string;
}>;

export type StructuredMessageProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
}>;

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

/**
 * Projects plugin structured-message descriptors into renderer-feeding entries.
 *
 * Gating mirrors the other plugin-UI families: when the
 * `plugins.ui.structuredMessages` FeatureDecision is not `enabled`
 * (`hostRuntimeContext.featureEnabled !== true`) no entry is projected, so the
 * UI `structuredMessagesByKind[kind]` is `undefined` and the host transcript
 * renders the stable fallback instead of mounting a plugin renderer.
 */
export function projectStructuredMessages(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    hostRuntimeContext?: StructuredMessageProjectionHostRuntimeContext,
): void {
    if (hostRuntimeContext?.featureEnabled !== true) {
        return;
    }
    for (const contribution of registry.structuredMessages ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `structuredMessage:${pluginId}:${contribution.definition.id}`;
        entriesById[id] = Object.freeze({
            id,
            pluginId,
            contributionKind: 'structuredMessage',
            descriptorId: contribution.definition.id,
            kind: contribution.definition.kind,
            payloadSchema: contribution.definition.payloadSchema,
            renderer: contribution.definition.renderer,
            display: contribution.definition.display,
            actions: contribution.definition.actions,
            visibility: contribution.definition.visibility,
            featureGate: contribution.definition.featureGate,
            order: contribution.definition.order,
            compatibility: contribution.definition.compatibility,
        });
    }
}
