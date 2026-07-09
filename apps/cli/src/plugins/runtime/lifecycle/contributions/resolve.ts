import type {
    PluginActionContributionV2,
    PluginSourceSpecV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
} from '@happier-dev/protocol';

import type {
    ResolvedCommandContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedActionContribution,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedToolContribution,
} from '../../../projection/registry/types';
import type { PluginApiLifecycleHandlerRegistration } from '../../api/types';
import type { ActivationTarget } from '../activation/targets';

/**
 * Contribution resolvers: turn a plugin's runtime registrations (actions,
 * tools, commands, lifecycle handlers) plus their manifest declarations into
 * the `Resolved*Contribution` shapes consumed by the projection layer.
 * Tools/commands additionally get a synthetic action projection so they are
 * invocable through the generic action surface.
 */

export function resolveContributionMetadata(target: ActivationTarget): Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
}> {
    return {
        provenance: target.provenance,
        source: target.source,
        pluginId: target.pluginId,
        manifestPath: target.manifestPath,
        manifestDigest: target.manifestDigest,
        daemonEntryPath: target.daemonEntryPath,
        ...(target.devDaemonEntryPath ? { devDaemonEntryPath: target.devDaemonEntryPath } : {}),
        ...(target.sourceSpec ? { sourceSpec: target.sourceSpec } : {}),
    };
}

export function toResolvedActionContribution(
    target: ActivationTarget,
    definition: PluginActionContributionV2,
): ResolvedActionContribution {
    const declaredSurfaces = new Set(definition.surfaces);
    const surfaces = {
        ui: false,
        voice: false,
        agent: declaredSurfaces.has('agent'),
        mcp: declaredSurfaces.has('mcp'),
        cli: declaredSurfaces.has('cli'),
        rpc: false,
        sdk: false,
    };

    const normalizedDescription = typeof definition.description === 'string'
        ? definition.description.trim()
        : '';

    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            title: definition.title,
            description: normalizedDescription.length > 0 ? normalizedDescription : null,
            safety: definition.dangerLevel === 'safe' ? 'safe' : 'danger',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces,
            inputHints: null,
            inputSchema: definition.inputSchema ?? {},
            ...(definition.resultSchema ? { outputSchema: definition.resultSchema } : {}),
            execution: {
                routing: 'daemon',
                handler: definition.handler,
            },
        },
    };
}

export function toResolvedToolContribution(
    target: ActivationTarget,
    definition: PluginToolContributionV2,
): ResolvedToolContribution {
    const normalizedDescription = typeof definition.description === 'string'
        ? definition.description.trim()
        : '';
    const surfaces = {
        cli: definition.surfaces.includes('cli'),
        mcp: definition.surfaces.includes('mcp'),
        agent: definition.surfaces.includes('agent'),
    };

    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            name: definition.name,
            title: definition.title,
            description: normalizedDescription.length > 0 ? normalizedDescription : null,
            safety: definition.safety ?? 'safe',
            surfaces,
            inputSchema: definition.inputSchema ?? {},
            ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
            ...(definition.inputHints ? { inputHints: definition.inputHints } : {}),
            ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
            ...(definition.examples ? { examples: definition.examples } : {}),
            ...(definition.promptSnippet !== undefined ? { promptSnippet: definition.promptSnippet } : {}),
            ...(definition.promptGuidelines ? { promptGuidelines: Object.freeze([...definition.promptGuidelines]) } : {}),
            actionId: definition.id,
        },
    };
}

export function toSyntheticActionContributionFromTool(
    target: ActivationTarget,
    definition: PluginToolContributionV2,
): ResolvedActionContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            title: definition.title,
            description: typeof definition.description === 'string' && definition.description.trim().length > 0
                ? definition.description.trim()
                : null,
            safety: definition.safety ?? 'safe',
            placements: [],
            slash: null,
            bindings: {
                mcpToolName: definition.name,
            },
            examples: definition.examples ?? null,
            surfaces: {
                ui: false,
                voice: false,
                agent: definition.surfaces.includes('agent'),
                mcp: definition.surfaces.includes('mcp'),
                cli: definition.surfaces.includes('cli'),
                rpc: false,
                sdk: false,
            },
            inputHints: definition.inputHints ?? null,
            inputSchema: definition.inputSchema ?? {},
            ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
            ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
        },
    };
}

export function toResolvedCommandContribution(
    target: ActivationTarget,
    definition: PluginCommandContributionV2,
): ResolvedCommandContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            command: definition.command,
            ...(definition.rootHelpLabel ? { rootHelpLabel: definition.rootHelpLabel } : {}),
            ...(definition.rootHelpDescription ? { rootHelpDescription: definition.rootHelpDescription } : {}),
            ...(definition.rootHelpDetail ? { rootHelpDetail: definition.rootHelpDetail } : {}),
            allowTmux: definition.allowTmux,
            ...(definition.visibility ? { visibility: definition.visibility } : {}),
            ...(definition.featureGate ? { featureGate: definition.featureGate } : {}),
            actionId: definition.id,
        },
    };
}

export function toSyntheticActionContributionFromCommand(
    target: ActivationTarget,
    definition: PluginCommandContributionV2,
): ResolvedActionContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            title: definition.rootHelpLabel ?? definition.command,
            description: definition.rootHelpDescription ?? null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
                ui: false,
                voice: false,
                agent: false,
                mcp: false,
                cli: true,
                rpc: false,
                sdk: false,
            },
            inputHints: null,
            inputSchema: {
                type: 'object',
                properties: {
                    argv: {
                        type: 'array',
                    },
                    rawArgv: {
                        type: 'array',
                    },
                },
                additionalProperties: true,
            },
        },
    };
}

export function toResolvedLifecycleHandlerContribution(
    target: ActivationTarget,
    definition: PluginApiLifecycleHandlerRegistration,
): ResolvedLifecycleHandlerContribution {
    const normalizedId = typeof definition.id === 'string' ? definition.id.trim() : '';
    if (!normalizedId) {
        throw new Error(`Plugin '${target.pluginId}' lifecycle handler for event '${definition.event}' must declare a stable lifecycle handler id`);
    }
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: normalizedId,
            event: definition.event,
            priority: definition.priority ?? 0,
        },
    };
}
