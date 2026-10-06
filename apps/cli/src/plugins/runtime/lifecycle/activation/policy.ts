import { listDeclaredPluginContributionFamilies } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginRuntimeCapabilityFamilyV1Schema } from '@happier-dev/protocol/plugins/runtime/api';
import type {
    ParsedPluginEventContributionV1,
    PluginRuntimeCapabilityFamilyV1,
    PluginSystemToolContributionV1,
} from '@happier-dev/protocol';

import {
    readDeclaredSystemToolContributions,
    readDeclaredEventContributions,
} from '../contributions/readDeclared';
import type { CanonicalPluginManifest } from '../../../manifest/types';

/**
 * Activation metadata consumed by the runtime catalog after a target has
 * activated successfully.
 */

export type ActivationPolicy = Readonly<{
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
    declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
    systemTools: readonly PluginSystemToolContributionV1[];
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

export function buildActivationPolicy(manifest: CanonicalPluginManifest): ActivationPolicy {
    return Object.freeze({
        runtimeCapabilities: deriveRuntimeCapabilities(manifest),
        declaredEventDeclarations: readDeclaredEventContributions(manifest.contributes),
        systemTools: readDeclaredSystemToolContributions(manifest.contributes),
    });
}
