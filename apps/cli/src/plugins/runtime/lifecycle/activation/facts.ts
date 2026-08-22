import type {
    PluginDiagnosticHostV1,
    PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type PluginTargetActivationRegistrationFact = Readonly<{
    family: string;
    localId: string;
}>;

/**
 * Projects host-private registration rights/runtime values to the exact
 * read-side activation fact. Registration targets and family-specific
 * authority must remain owned by their registration/lifecycle owners.
 */
export function projectPluginTargetActivationRegistrationFacts(
    registrations: readonly PluginTargetActivationRegistrationFact[],
): readonly PluginTargetActivationRegistrationFact[] {
    return Object.freeze(registrations.map(({ family, localId }) => Object.freeze({ family, localId })));
}

/**
 * Immutable host-owned activation evidence exposed to read-side projections.
 * Consumer projections must not infer these facts from handler presence.
 */
export type PluginTargetActivationFact = Readonly<{
    pluginId: string;
    pluginVersion: string;
    source: PluginDiagnosticRecordV1['plugin']['source'];
    generation: string;
    host: PluginDiagnosticHostV1;
    platform: string;
    occurredAtMs: number;
    status: 'active' | 'dormant' | 'unavailable';
    required: readonly PluginTargetActivationRegistrationFact[];
    bound: readonly PluginTargetActivationRegistrationFact[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;
