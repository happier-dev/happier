import { AgentProviderRequirementsV1Schema } from '@happier-dev/protocol/providers/compatibility/v1';
import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol/bugs/reports/redaction';
import type { SensitiveDiagnosticValuesLease } from '@happier-dev/protocol';

import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

const INACTIVE_LEASE: SensitiveDiagnosticValuesLease = Object.freeze({ close: () => undefined });

function readProviderOwnedEnvironmentValues(params: Readonly<{
    agentId: string;
    providerRequirements?: unknown;
    environment?: NodeJS.ProcessEnv;
}>): readonly string[] {
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
    return support.data.authIsolation.ownedEnvKeys
        .map((key) => environment[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * The runner's one registration of a Session launch's secret values, held for the Session
 * runtime's life: the credential values an active Provider binding owns in the launch environment
 * (Connected Account and Provider credentials, decided by the Agent's `authIsolation.ownedEnvKeys`)
 * and the values the launch owner carried to this process (`launchSecretValues`: the daemon launch
 * lease from the runner bootstrap, or the foreground admission's sensitive Profile environment).
 * They are redacted from diagnostics and from the transcript this process writes.
 */
export function beginSessionLaunchSecretRedaction(params: Readonly<{
    agentId: string;
    providerBindingActive: boolean;
    providerRequirements?: unknown;
    environment?: NodeJS.ProcessEnv;
    launchSecretValues?: readonly string[];
}>): SensitiveDiagnosticValuesLease {
    const values = [...new Set([
        ...(params.launchSecretValues ?? []),
        ...(params.providerBindingActive ? readProviderOwnedEnvironmentValues(params) : []),
    ])].filter((value) => value.length > 0);
    if (values.length === 0) return INACTIVE_LEASE;
    const diagnostic = registerSensitiveDiagnosticValues(values);
    const releaseTranscriptSecrets = values.map((value) => registerTranscriptSecret(value));
    let closed = false;
    return Object.freeze({
        close: () => {
            if (closed) return;
            closed = true;
            for (const release of releaseTranscriptSecrets) release();
            diagnostic.close();
        },
    });
}
