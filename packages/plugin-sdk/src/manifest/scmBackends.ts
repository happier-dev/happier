import {
    ScmBackendContributionSchema as canonicalScmBackendContributionSchema,
} from '@happier-dev/protocol';

import type { PluginJsonValueV2 } from '../identity.js';

interface ScmBackendSchema<T> {
    parse(value: unknown): T;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: T }>
        | Readonly<{ success: false; error: unknown }>;
}

export type ScmBackendContribution = Readonly<{
    id: string;
    title: string | Readonly<{ key: string; fallback: string }>;
    description?: string | Readonly<{ key: string; fallback: string }>;
    kind: string;
    capabilities: readonly string[];
    metadata?: Readonly<Record<string, PluginJsonValueV2>>;
}>;

/** Canonical Protocol parser with an SDK-local author declaration. */
export const ScmBackendContributionSchema: ScmBackendSchema<ScmBackendContribution> =
    canonicalScmBackendContributionSchema;
