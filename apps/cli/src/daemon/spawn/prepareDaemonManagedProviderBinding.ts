import {
    createProviderErrorV1,
    qualifiedPurposeKey,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import type {
    ExecRuntimeServiceV1,
} from '@/plugins/runtime/exec/privateContract';

import type {
    ConnectedAccountRequestAuthSubjectRegistry,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import type {
    ConnectedAccountRequestAuthSubject,
    ConnectedAccountRequestAuthService,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import type {
    LocalServicesDaemonRuntime,
    TrustedManagedLocalServiceOwnerContext,
    TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';
import type {
    ManagedLocalServiceRunAttachmentV1,
} from '@/daemon/sessionRegistry';
import {
    prepareManagedProviderEndpointLaunch,
    type ManagedProviderEndpointLaunchFailureCode,
} from '@/providers/lifecycle/managedEndpointLaunch';
import {
    prepareManagedProviderRuntimeAdapter,
} from '@/providers/lifecycle/managedRuntimeAdapterPreparation';
import type {
    ProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';
import type {
    ProviderSpawnAuthorizationAttempt,
    ProviderSpawnMaterializationResult,
} from '@/providers/spawn/authorize';

type ManagedProviderSpawnAuthorizationAttempt = Extract<
    ProviderSpawnAuthorizationAttempt,
    { deployment: { kind: 'managedLocal' } }
>;

type TrustedManagedLocalServices = Pick<
    LocalServicesDaemonRuntime['trustedManagedLocalServices'],
    'startOwned' | 'readOwnedRun' | 'registerOwnedCleanup' | 'stopOwned'
>;

export type DaemonManagedProviderBindingResult =
    | (Extract<ProviderSpawnMaterializationResult, { ok: true }> & Readonly<{
        managedLocalServiceRunAttachment: ManagedLocalServiceRunAttachmentV1;
        managedLocalServiceOwnedRun: TrustedManagedLocalServiceOwnedRun;
        activateManagedProviderRequestAuth:
            (subject: Parameters<
                ConnectedAccountRequestAuthSubjectRegistry['activate']
            >[0]['subject']) => Promise<void>;
    }>)
    | Extract<ProviderSpawnMaterializationResult, { ok: false }>;

function providerErrorForManagedLaunchFailure(input: Readonly<{
    code: ManagedProviderEndpointLaunchFailureCode;
    attempt: ManagedProviderSpawnAuthorizationAttempt;
}>): ProviderErrorV1 {
    const context = {
        connectionId: input.attempt.authorization.ticket.connectionId,
        machineId: input.attempt.authorization.ticket.machineId,
    };
    switch (input.code) {
        case 'managed_provider_execution_denied':
            return createProviderErrorV1('provider_connection_invalid', context);
        case 'managed_provider_runtime_unavailable':
        case 'managed_provider_start_failed':
        case 'managed_provider_run_invalid':
        case 'managed_provider_readiness_invalid':
            return createProviderErrorV1('provider_endpoint_unavailable', context);
        case 'managed_provider_runtime_preparation_failed':
        case 'managed_provider_activation_failed':
        case 'managed_provider_materialization_failed':
            return createProviderErrorV1('provider_materialization_failed', context);
    }
}

export async function prepareDaemonManagedProviderBinding(input: Readonly<{
    attempt: ManagedProviderSpawnAuthorizationAttempt;
    context: TrustedManagedLocalServiceOwnerContext;
    requestAuthSubject?: ConnectedAccountRequestAuthSubject;
    requestAuthHttpPort: number;
    materializationBaseDir: string;
    managedLocalServicesEnabled: boolean;
    localServices: TrustedManagedLocalServices;
    exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
    requestAuthRegistry: Pick<
        ConnectedAccountRequestAuthSubjectRegistry,
        'activate' | 'retire'
    >;
    validateRequestAuth:
        ConnectedAccountRequestAuthService['validateRequestAuth'];
    launchResourceScope: ProviderLaunchResourceScope;
    readinessTimeoutMs?: number;
}>): Promise<DaemonManagedProviderBindingResult> {
    const contribution = input.attempt.authorization.deployment.contribution;
    const runtimeAdapter = contribution.managedRuntimeAdapter;
    if (!runtimeAdapter) {
        return {
            ok: false,
            error: createProviderErrorV1('provider_connection_invalid', {
                connectionId: input.attempt.authorization.ticket.connectionId,
                machineId: input.attempt.authorization.ticket.machineId,
            }),
        };
    }
    const purposeBindings = input.attempt.authorization.deployment
        .implementation.purposeBindings.bindings;
    const requestAuthUseByLocalPurpose = new Map(
        input.attempt.authorization.deployment.implementation.facet.requestAuthUses
            .map((use) => [use.purpose, use] as const),
    );
    const purposeUseByPurposeKey = new Map(
        purposeBindings.flatMap((binding) => {
            const use = requestAuthUseByLocalPurpose.get(binding.purpose.purpose);
            return use
                ? [[qualifiedPurposeKey(binding.purpose), Object.freeze({
                    binding,
                    use: Object.freeze({
                        purpose: binding.purpose,
                        materialization: use.materialization,
                    }),
                })] as const]
                : [];
        }),
    );
    const result = await prepareManagedProviderEndpointLaunch({
        context: input.context,
        authorizationAttempt: input.attempt,
        managedLocalServicesEnabled: input.managedLocalServicesEnabled,
        requestAuthHttpPort: input.requestAuthHttpPort,
        purposeBindings,
        requestAuth: {
            resolvePurposeUse: (purpose) => (
                purposeUseByPurposeKey.get(qualifiedPurposeKey(purpose)) ?? null
            ),
            listPurposeUses: () => [...purposeUseByPurposeKey.values()],
        },
        ...(input.requestAuthSubject
            ? { requestAuthSubject: input.requestAuthSubject }
            : {}),
        localServices: input.localServices,
        exec: input.exec,
        launchResourceScope: input.launchResourceScope,
    }, {
        ...(input.readinessTimeoutMs === undefined
            ? {}
            : { readinessTimeoutMs: input.readinessTimeoutMs }),
        prepareRuntime: async ({ facet }) => {
            return await prepareManagedProviderRuntimeAdapter({
                runtimeAdapter,
                materializationBaseDir: input.materializationBaseDir,
                purposes: purposeBindings.map((binding) => binding.purpose),
                protocols: [
                    input.attempt.authorization.binding.endpoint.protocol,
                ],
                modelListEnabled: false,
            });
        },
        validateReadiness: async ({ preparation, signal }) => (
            await preparation.prepared.readiness.wait(signal)
        ),
        validateRequestAuth: input.validateRequestAuth,
        activateRequestAuth: input.requestAuthRegistry.activate,
        retireRequestAuth: input.requestAuthRegistry.retire,
        materializeAgentBinding: async ({ preparation, run }) => {
            const host = run.host;
            const port = run.port;
            if (!host || port === null) {
                throw new Error('Managed Provider run endpoint is unavailable');
            }
            const normalizedUrl = runtimeAdapter.resolveAgentEndpoint({
                host,
                port,
                protocol: input.attempt.authorization.binding.endpoint.protocol,
                endpointTemplateId:
                    input.attempt.authorization.binding.endpoint.endpointTemplateId,
            });
            const materialized = await input.attempt.materializeManagedEndpoint({
                normalizedUrl,
                downstreamBearer: preparation.prepared.downstreamBearer,
            });
            if (!materialized.ok) throw materialized.error;
            return {
                materialization: materialized,
                cleanup: input.attempt.cleanupOnFailure,
            };
        },
    });
    if (!result.ok) {
        return {
            ok: false,
            error: providerErrorForManagedLaunchFailure({
                code: result.code,
                attempt: input.attempt,
            }),
        };
    }
    return Object.freeze({
        ...result.materialization,
        managedLocalServiceRunAttachment: result.runAttachment,
        managedLocalServiceOwnedRun: result.run,
        activateManagedProviderRequestAuth: result.activateRequestAuth,
    });
}
