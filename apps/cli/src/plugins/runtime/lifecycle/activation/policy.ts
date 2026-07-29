import {
    listDeclaredPluginContributionFamilies,
    listPluginContributionIdentities,
    PluginRuntimeCapabilityFamilyV1Schema,
} from '@happier-dev/protocol';
import type {
    PluginPermissionDeclarationV1,
    PluginPermissionCapabilityV1,
    PluginActionContributionV2,
    ParsedPluginEventContributionV1,
    PluginRequestInterceptorContributionV1,
    PluginRuntimeCapabilityFamilyV1,
    PluginSystemToolContributionV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
    PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../../validation/diagnostics/types';
import { readPluginManifest } from '../../../manifest/read';
import type { PluginDaemonModuleNamespace } from '../../types';
import { appendDiagnostic } from '../utils';
import {
    readDeclaredActionContributions,
    readDeclaredToolContributions,
    readDeclaredCommandContributions,
    readDeclaredRequestInterceptorContributions,
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
    permissions: readonly PluginPermissionCapabilityV1[];
    permissionDeclarations: readonly PluginPermissionDeclarationV1[];
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
    declaredRequestInterceptorIds: readonly string[];
    declaredMcpServerIds: readonly string[];
    declaredMcpDiscoveryProviderIds: readonly string[];
    declaredRequestInterceptors: readonly PluginRequestInterceptorContributionV1[];
    systemTools: readonly PluginSystemToolContributionV1[];
}>;

export type ProjectedPluginRuntimeAuthority = Readonly<{
    permissions: readonly PluginPermissionCapabilityV1[];
    permissionDeclarations: readonly PluginPermissionDeclarationV1[];
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

function adaptHostAccess(manifest: Readonly<{ hostAccess: Readonly<{
    required: readonly PluginHostAccessRequestV2[];
}> }>): Readonly<{
    required: readonly PluginPermissionDeclarationV1[];
}> {
    const adapt = (requests: typeof manifest.hostAccess.required): PluginPermissionDeclarationV1[] => requests.flatMap(
      (request): PluginPermissionDeclarationV1[] => {
        const reason = typeof request.reason === 'string' ? request.reason : request.reason.fallback;
        switch (request.capability) {
          case 'network':
            return request.scope.targets.flatMap((target) => target.kind === 'fixedOrigin'
              ? [{ capability: 'network' as const, reason, scope: target.origin }]
              : []);
          case 'network.intercept':
            return request.scope.origins.map((origin) => ({
              capability: 'network.intercept' as const,
              reason,
              scope: origin,
            }));
          case 'filesystem':
            return request.scope.locations.flatMap((location) => request.scope.access.flatMap((access) => {
              if (access === 'delete') return [];
              return [{
                capability: access === 'read' ? 'filesystem.read' as const : 'filesystem.write' as const,
                reason,
                scope: location.pathPrefix ?? '*',
              }];
            }));
          case 'process':
            return [{ capability: 'process.spawn', reason }];
          case 'environment':
            return request.scope.keys.map((key) => ({ capability: 'env' as const, reason, scope: key }));
          case 'terminal':
            return [{ capability: 'terminal.host.control', reason }];
          case 'sessions':
            return [
                ...(request.scope.access.includes('read')
                    ? [{ capability: 'events.session.subscribe' as const, reason }]
                    : []),
                ...(request.scope.access.includes('control')
                    ? [{ capability: 'session.hooks.control' as const, reason }]
                    : []),
            ];
          case 'network.client':
          case 'secrets':
          case 'connectedAccounts':
          case 'storage.synced':
          case 'mcp':
          case 'browser':
          case 'clipboard':
          case 'externalLinks':
            return [];
        }
      },
    );
    return { required: Object.freeze(adapt(manifest.hostAccess.required)) };
}

export function projectPluginRuntimeAuthority(
    manifest: CanonicalPluginManifest,
): ProjectedPluginRuntimeAuthority {
    const access = adaptHostAccess(manifest);
    return Object.freeze({
        permissions: Object.freeze(
            access.required.map((permission) => permission.capability),
        ),
        permissionDeclarations: access.required,
        runtimeCapabilities: deriveRuntimeCapabilities(manifest),
    });
}

export function buildActivationPolicy(manifest: CanonicalPluginManifest): ActivationPolicy {
    const runtimeAuthority = projectPluginRuntimeAuthority(manifest);
    const identities = listPluginContributionIdentities(manifest.contributes as unknown as Readonly<Record<string, unknown>>);
    const ids = (family: string) => Object.freeze(identities.filter((identity) => identity.family === family).map((identity) => identity.localId));
    return Object.freeze({
        permissions: runtimeAuthority.permissions,
        permissionDeclarations: runtimeAuthority.permissionDeclarations,
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
        declaredRequestInterceptorIds: ids('requestInterceptors'),
        declaredMcpServerIds: ids('mcp.servers'),
        declaredMcpDiscoveryProviderIds: ids('mcp.discoveryProviders'),
        declaredRequestInterceptors: readDeclaredRequestInterceptorContributions(manifest.contributes),
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
