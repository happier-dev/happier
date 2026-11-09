import { ScmBackendContributionSchema as canonicalScmBackendContributionSchema } from '@happier-dev/protocol/plugins/contributions/scmBackends';

import type { PluginJsonValueV2 } from '../identity.js';
import type { PluginLocalizedStringV2 } from '../manifest.js';

interface ScmBackendSchema<T> {
    parse(value: unknown): T;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: T }>
        | Readonly<{ success: false; error: unknown }>;
}

export type ScmBackendContribution = Readonly<{
    id: string;
    title: Readonly<PluginLocalizedStringV2>;
    description?: Readonly<PluginLocalizedStringV2>;
    kind: string;
    capabilities: readonly string[];
    metadata?: Readonly<Record<string, PluginJsonValueV2>>;
}>;

/** Canonical Protocol parser with an SDK-local author declaration. */
export const ScmBackendContributionSchema: ScmBackendSchema<ScmBackendContribution> =
    canonicalScmBackendContributionSchema;
