import { PluginManifestV2Schema } from '@happier-dev/protocol';
import type {
    PluginPermissionDeclarationV1,
    PluginPermissionCapabilityV1,
    PluginActionContributionV2,
    ParsedPluginManifestV2,
    ParsedPluginEventContributionV1,
    PluginRequestInterceptorContributionV1,
    PluginRuntimeCapabilityFamilyV1,
    PluginSystemToolContributionV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../../validation/diagnostics/types';
import { readPluginManifest } from '../../../manifest/read';
import type { PluginApiHostLifecycleHandlerDeclaration } from '../../api/types';
import type { PluginDaemonModuleNamespace } from '../../types';
import { appendDiagnostic } from '../utils';
import {
    readDeclaredAgentIds,
    readDeclaredContributionIds,
    readDeclaredActionContributions,
    readDeclaredToolContributions,
    readDeclaredCommandContributions,
    readDeclaredNestedContributionIds,
    readDeclaredRequestInterceptorContributions,
    readDeclaredSystemToolContributions,
    readDeclaredLifecycleHandlers,
    readDeclaredEventContributions,
} from '../contributions/readDeclared';
import type { ActivationTarget } from './targets';

/**
 * Activation policy: the permission/runtime-capability/declared-contribution
 * facts a target's manifest grants, resolved either from a bundled plugin's
 * `PLUGIN_MANIFEST` export or from an on-disk manifest file (cached per
 * manifest path across a single activation pass).
 */

export type ActivationPolicy = Readonly<{
    permissions: readonly PluginPermissionCapabilityV1[];
    permissionDeclarations: readonly PluginPermissionDeclarationV1[];
    optionalPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
    declaredAgentIds: readonly string[];
    declaredActionIds: readonly string[];
    declaredActions: readonly PluginActionContributionV2[];
    declaredToolIds: readonly string[];
    declaredTools: readonly PluginToolContributionV2[];
    declaredCommandIds: readonly string[];
    declaredCommands: readonly PluginCommandContributionV2[];
    declaredHookIds: readonly string[];
    declaredLifecycleHandlerIds: readonly string[];
    declaredLifecycleHandlers: readonly PluginApiHostLifecycleHandlerDeclaration[];
    declaredNotificationCategoryIds: readonly string[];
    declaredNotificationChannelIds: readonly string[];
    declaredEventIds: readonly string[];
    declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
    declaredScmHostingProviderIds: readonly string[];
    declaredScmBackendIds: readonly string[];
    declaredRequestInterceptorIds: readonly string[];
    declaredMcpServerIds: readonly string[];
    declaredMcpDiscoveryProviderIds: readonly string[];
    declaredRequestInterceptors: readonly PluginRequestInterceptorContributionV1[];
    systemTools: readonly PluginSystemToolContributionV1[];
}>;

export function readBundledActivationPolicy(params: Readonly<{
    target: ActivationTarget;
    moduleNamespace: PluginDaemonModuleNamespace;
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
}>): ActivationPolicy | null {
    const raw = (params.moduleNamespace as Record<string, unknown>).PLUGIN_MANIFEST;
    if (raw === undefined) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' is missing PLUGIN_MANIFEST export`,
        });
        return null;
    }

    const parsed = PluginManifestV2Schema.safeParse(raw);
    if (!parsed.success) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' has an invalid PLUGIN_MANIFEST export`,
        });
        return null;
    }

    const manifest: ParsedPluginManifestV2 = parsed.data;
    if (manifest.id !== params.target.pluginId) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' PLUGIN_MANIFEST id '${manifest.id}' must match the plugin id`,
        });
        return null;
    }

    return Object.freeze({
        permissions: Object.freeze(manifest.permissions.required.map((permission) => permission.capability)),
        permissionDeclarations: Object.freeze([...manifest.permissions.required]),
        optionalPermissionDeclarations: Object.freeze([...manifest.permissions.optional]),
        runtimeCapabilities: Object.freeze([...manifest.uses]),
        declaredAgentIds: readDeclaredAgentIds(manifest.contributes),
        declaredActionIds: readDeclaredContributionIds(manifest.contributes, 'actions'),
        declaredActions: readDeclaredActionContributions(manifest.contributes),
        declaredToolIds: readDeclaredContributionIds(manifest.contributes, 'tools'),
        declaredTools: readDeclaredToolContributions(manifest.contributes),
        declaredCommandIds: readDeclaredContributionIds(manifest.contributes, 'commands'),
        declaredCommands: readDeclaredCommandContributions(manifest.contributes),
        declaredHookIds: readDeclaredContributionIds(manifest.contributes, 'hooks'),
        declaredLifecycleHandlerIds: readDeclaredContributionIds(manifest.contributes, 'lifecycleHandlers'),
        declaredLifecycleHandlers: readDeclaredLifecycleHandlers(manifest.contributes),
        declaredNotificationCategoryIds: readDeclaredContributionIds(manifest.contributes, 'notifications'),
        declaredNotificationChannelIds: readDeclaredContributionIds(manifest.contributes, 'notificationChannels'),
        declaredEventIds: readDeclaredContributionIds(manifest.contributes, 'events'),
        declaredEventDeclarations: readDeclaredEventContributions(manifest.contributes),
        declaredScmHostingProviderIds: readDeclaredContributionIds(manifest.contributes, 'scmHostingProviders'),
        declaredScmBackendIds: readDeclaredContributionIds(manifest.contributes, 'scmBackends'),
        declaredRequestInterceptorIds: readDeclaredContributionIds(manifest.contributes, 'requestInterceptors'),
        declaredMcpServerIds: readDeclaredNestedContributionIds(manifest.contributes, 'mcp', 'servers'),
        declaredMcpDiscoveryProviderIds: readDeclaredNestedContributionIds(manifest.contributes, 'mcp', 'discoveryProviders'),
        declaredRequestInterceptors: readDeclaredRequestInterceptorContributions(manifest.contributes),
        systemTools: readDeclaredSystemToolContributions(manifest.contributes),
    });
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
    });
    if (!manifestResult.ok) {
        return {
            ok: false,
            diagnostics: manifestResult.diagnostics,
        };
    }

    const policy: ActivationPolicy = Object.freeze({
        permissions: Object.freeze(manifestResult.manifest.permissions.map((permission) => permission.capability)),
        permissionDeclarations: Object.freeze([...manifestResult.manifest.permissions]),
        optionalPermissionDeclarations: Object.freeze([...(manifestResult.manifest.optionalPermissions ?? [])]),
        runtimeCapabilities: Object.freeze([...manifestResult.manifest.uses]),
        declaredAgentIds: readDeclaredAgentIds(manifestResult.manifest.contributes),
        declaredActionIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'actions'),
        declaredActions: readDeclaredActionContributions(manifestResult.manifest.contributes),
        declaredToolIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'tools'),
        declaredTools: readDeclaredToolContributions(manifestResult.manifest.contributes),
        declaredCommandIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'commands'),
        declaredCommands: readDeclaredCommandContributions(manifestResult.manifest.contributes),
        declaredHookIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'hooks'),
        declaredLifecycleHandlerIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'lifecycleHandlers'),
        declaredLifecycleHandlers: readDeclaredLifecycleHandlers(manifestResult.manifest.contributes),
        declaredNotificationCategoryIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'notifications'),
        declaredNotificationChannelIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'notificationChannels'),
        declaredEventIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'events'),
        declaredEventDeclarations: readDeclaredEventContributions(manifestResult.manifest.contributes),
        declaredScmHostingProviderIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'scmHostingProviders'),
        declaredScmBackendIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'scmBackends'),
        declaredRequestInterceptorIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'requestInterceptors'),
        declaredMcpServerIds: readDeclaredNestedContributionIds(manifestResult.manifest.contributes, 'mcp', 'servers'),
        declaredMcpDiscoveryProviderIds: readDeclaredNestedContributionIds(manifestResult.manifest.contributes, 'mcp', 'discoveryProviders'),
        declaredRequestInterceptors: readDeclaredRequestInterceptorContributions(manifestResult.manifest.contributes),
        systemTools: readDeclaredSystemToolContributions(manifestResult.manifest.contributes),
    });
    cache.set(target.manifestPath, policy);
    return { ok: true, policy };
}
