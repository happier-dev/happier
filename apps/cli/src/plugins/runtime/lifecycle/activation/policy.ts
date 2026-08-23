import {
    listDeclaredPluginContributionFamilies,
    listPluginContributionIdentities,
    PluginRuntimeCapabilityFamilyV1Schema,
} from '@happier-dev/protocol';
import type {
    PluginActionContributionV2,
    ParsedPluginEventContributionV1,
    PluginRuntimeCapabilityFamilyV1,
    PluginSystemToolContributionV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../../validation/diagnostics/types';
import { readPluginManifest } from '../../../manifest/read';
import { pluginSourceProvenanceForKind } from '../../../manifest/sourceProvenance';
import type { PluginDaemonModuleNamespace } from '../../types';
import { appendDiagnostic } from '../utils';
import {
    readDeclaredActionContributions,
    readDeclaredToolContributions,
    readDeclaredCommandContributions,
    readDeclaredSystemToolContributions,
    readDeclaredEventContributions,
} from '../contributions/readDeclared';
import type { ActivationTarget } from './targets';
import type { CanonicalPluginManifest } from '../../../manifest/types';

/**
 * Activation policy: the permission/runtime-capability/declared-contribution
 * facts a target's manifest grants, resolved either from a bundled plugin's
 * `PLUGIN_MANIFEST` export or from an on-disk manifest file (cached per
 * manifest path across a single activation pass).
 */

export type ActivationPolicy = Readonly<{
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
    declaredAgentIds: readonly string[];
    declaredActionIds: readonly string[];
    declaredActions: readonly PluginActionContributionV2[];
    declaredToolIds: readonly string[];
    declaredTools: readonly PluginToolContributionV2[];
    declaredCommandIds: readonly string[];
    declaredCommands: readonly PluginCommandContributionV2[];
    declaredHookIds: readonly string[];
    declaredNotificationCategoryIds: readonly string[];
    declaredNotificationChannelIds: readonly string[];
    declaredEventIds: readonly string[];
    declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
    declaredScmHostingProviderIds: readonly string[];
    declaredScmBackendIds: readonly string[];
    declaredMcpServerIds: readonly string[];
    declaredMcpDiscoverySourceIds: readonly string[];
    systemTools: readonly PluginSystemToolContributionV1[];
}>;

export type ProjectedPluginRuntimeAuthority = Readonly<{
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
}>;

function deriveRuntimeCapabilities(manifest: CanonicalPluginManifest): readonly PluginRuntimeCapabilityFamilyV1[] {
    const hostAccess = [...manifest.hostAccess.required, ...manifest.hostAccess.optional];
    const capabilities = [
        ...listDeclaredPluginContributionFamilies(manifest.contributes as unknown as Readonly<Record<string, unknown>>)
            .flatMap((family) => {
                const parsed = PluginRuntimeCapabilityFamilyV1Schema.safeParse(
                    family.split('.')[0],
                );
                return parsed.success ? [parsed.data] : [];
            }),
        ...(hostAccess.some((request) => request.capability === 'terminal') ? ['terminalHost' as const] : []),
        ...(hostAccess.some((request) => request.capability === 'sessions' && request.scope.access.includes('control'))
            ? ['sessionHooks' as const]
            : []),
    ];
    return Object.freeze(capabilities.filter((family, index) => capabilities.indexOf(family) === index));
}

export function projectPluginRuntimeAuthority(
    manifest: CanonicalPluginManifest,
): ProjectedPluginRuntimeAuthority {
    return Object.freeze({
        runtimeCapabilities: deriveRuntimeCapabilities(manifest),
    });
}

export function buildActivationPolicy(manifest: CanonicalPluginManifest): ActivationPolicy {
    const runtimeAuthority = projectPluginRuntimeAuthority(manifest);
    const identities = listPluginContributionIdentities(manifest.contributes as unknown as Readonly<Record<string, unknown>>);
    const ids = (family: string) => Object.freeze(identities.filter((identity) => identity.family === family).map((identity) => identity.localId));
    return Object.freeze({
        runtimeCapabilities: runtimeAuthority.runtimeCapabilities,
        declaredAgentIds: ids('agents'),
        declaredActionIds: ids('actions'),
        declaredActions: readDeclaredActionContributions(manifest.contributes),
        declaredToolIds: ids('tools'),
        declaredTools: readDeclaredToolContributions(manifest.contributes),
        declaredCommandIds: ids('commands'),
        declaredCommands: readDeclaredCommandContributions(manifest.contributes),
        declaredHookIds: ids('hooks'),
        declaredNotificationCategoryIds: ids('notifications'),
        declaredNotificationChannelIds: ids('notificationChannels'),
        declaredEventIds: ids('events'),
        declaredEventDeclarations: readDeclaredEventContributions(manifest.contributes),
        declaredScmHostingProviderIds: ids('scmHostingProviders'),
        declaredScmBackendIds: ids('scmBackends'),
        declaredMcpServerIds: ids('mcp.servers'),
        declaredMcpDiscoverySourceIds: ids('mcp.discoverySources'),
        systemTools: readDeclaredSystemToolContributions(manifest.contributes),
    });
}

export function readBundledActivationPolicy(params: Readonly<{
    target: ActivationTarget;
    moduleNamespace: PluginDaemonModuleNamespace;
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
}>): ActivationPolicy | null {
    const manifest = params.target.manifest;
    if (manifest.id !== params.target.pluginId) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' PLUGIN_MANIFEST id '${manifest.id}' must match the plugin id`,
        });
        return null;
    }

    return buildActivationPolicy(manifest);
}

export async function resolveActivationPolicy(
    target: ActivationTarget,
    cache: Map<string, ActivationPolicy>,
): Promise<
    | Readonly<{ ok: true; policy: ActivationPolicy }>
    | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>
> {
    const cached = cache.get(target.manifestPath);
    if (cached) {
        return { ok: true, policy: cached };
    }

    const manifestResult = await readPluginManifest({
        manifestPath: target.manifestPath,
        sourceProvenance: pluginSourceProvenanceForKind(target.sourceSpec.kind),
    });
    if (!manifestResult.ok) {
        return {
            ok: false,
            diagnostics: manifestResult.diagnostics,
        };
    }

    const policy = buildActivationPolicy(manifestResult.manifest);
    cache.set(target.manifestPath, policy);
    return { ok: true, policy };
}
