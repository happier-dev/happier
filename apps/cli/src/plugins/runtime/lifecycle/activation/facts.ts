import type {
    PluginDiagnosticHostV1,
    PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

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
    required: readonly Readonly<{ family: string; localId: string }>[];
    bound: readonly Readonly<{ family: string; localId: string }>[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;
