import {
    AgentProviderRequirementsV1Schema,
    registerSensitiveDiagnosticValues,
    type SensitiveDiagnosticValuesLease,
} from '@happier-dev/protocol';

import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

const INACTIVE_LEASE: SensitiveDiagnosticValuesLease = Object.freeze({ close: () => undefined });

export function beginProviderBindingRuntimeDiagnosticRedaction(params: Readonly<{
    agentId: string;
    providerBindingActive: boolean;
    providerRequirements?: unknown;
    environment?: NodeJS.ProcessEnv;
}>): SensitiveDiagnosticValuesLease {
    if (!params.providerBindingActive) return INACTIVE_LEASE;

    const providerRequirements = Object.prototype.hasOwnProperty.call(
        params,
        'providerRequirements',
    )
        ? params.providerRequirements
        : readCurrentContributionRegistry()
            .agentDefinitionsById
            .get(params.agentId)
            ?.definition.providerRequirements;
    const support = AgentProviderRequirementsV1Schema.safeParse(
        providerRequirements,
    );
    if (!support.success) {
        throw new Error(`Agent '${params.agentId}' has no valid static provider support for runtime redaction`);
    }

    const environment = params.environment ?? process.env;
    const values = support.data.authIsolation.ownedEnvKeys
        .map((key) => environment[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    return registerSensitiveDiagnosticValues(values);
}
