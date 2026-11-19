import { z } from 'zod/mini';
import type { ProviderBrokerModelRouteGrantPayloadV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { logger } from '@/ui/logger';
import { PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH } from './providerBrokerPrivateProtocol';
import { observeConnectedServiceMaterializationPhase } from '@/daemon/connectedServices/materialize/materializationPhase';

type ProviderBrokerApplicationPhaseDiagnostic = Readonly<{ consumerId: string; grantId?: string; agentTargetKey: string }>;
const diagnosticGrantId = z.uuid();

/** Observe only the private endpoint demand; inference keeps its existing logs. */
export function providerBrokerEndpointPhaseDiagnostic(
    authority: ProviderBrokerModelRouteGrantPayloadV1,
    request: Readonly<{ method?: string; pathAndQuery: string }>,
): ProviderBrokerApplicationPhaseDiagnostic | undefined {
    if (request.method !== 'GET' || request.pathAndQuery !== PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) return undefined;
    const grantId = diagnosticGrantId.safeParse(authority.grantId);
    return { consumerId: authority.consumer.kind === 'session' ? authority.consumer.sessionId : authority.consumer.executionRunId,
        agentTargetKey: authority.application.agentTargetKey,
        ...(grantId.success ? { grantId: grantId.data } : {}) };
}

type ProviderBrokerApplicationPhase =
    | 'request_policy'
    | 'home_admission'
    | 'source_select'
    | 'source_open'
    | 'model_catalog_authorization'
    | 'operation_close'
    | 'upstream_forward';

/** Host-private diagnostic context, never a public refusal or Provider error
 * property. Keep the original error only for the application's safe classifier. */
export class ProviderBrokerApplicationPhaseError extends Error {
    constructor(
        readonly phase: ProviderBrokerApplicationPhase,
        readonly brokerRequestId: string,
        cause: unknown,
    ) {
        super('Provider broker application phase failed', { cause });
        this.name = 'ProviderBrokerApplicationPhaseError';
    }
}

export async function runProviderBrokerApplicationPhase<T>(
    phase: ProviderBrokerApplicationPhase,
    brokerRequestId: string,
    run: () => Promise<T>,
    diagnostic?: ProviderBrokerApplicationPhaseDiagnostic,
): Promise<T> {
    const startedAt = diagnostic ? performance.now() : 0;
    const record = (status: 'started' | 'completed' | 'failed') => {
        if (!diagnostic) return;
        try {
            logger.infoFile('[provider-broker-application]', { stage: 'handler', phase, brokerRequestId,
                consumerId: diagnostic.consumerId, ...(diagnostic.grantId ? { grantId: diagnostic.grantId } : {}),
                status, durationMs: status === 'started' ? 0 : Math.round(performance.now() - startedAt) });
        } catch { /* Diagnostic IO cannot change broker admission or source custody. */ }
    };
    record('started');
    try {
        // The admitted target is only a diagnostic correlation label here; do
        // not resolve or activate an Agent just to observe the broker's source.
        // Request id joins this scope to the existing Session/grant receipt.
        const result = await (diagnostic && phase === 'source_open'
            ? observeConnectedServiceMaterializationPhase({ agentId: diagnostic.agentTargetKey,
                materializationKey: brokerRequestId }, 'materialization_invoke', run)
            : run());
        record('completed');
        return result;
    } catch (error) {
        record('failed');
        // Admission contains source selection, Home admission and source open.
        // Preserve the innermost failed boundary rather than relabelling it.
        if (error instanceof ProviderBrokerApplicationPhaseError) throw error;
        throw new ProviderBrokerApplicationPhaseError(phase, brokerRequestId, error);
    }
}
