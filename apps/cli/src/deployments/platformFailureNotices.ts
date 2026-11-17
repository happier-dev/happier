import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentFailedEventV1Schema, DeploymentReceiptOutcomeEventV1Schema, DeploymentReceiptEventSourceConfigV1Schema,
    DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import type { AutomationEventSourceDefinitionV1, AutomationEventAdmitInputV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { StoredCredentials } from '@/persistence';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createCommittedServiceHealthDelivery } from '@/notifications/activity/committedServiceHealthDelivery';
import { logger } from '@/ui/logger';
import { readDeploymentTargetV1 } from './targets/deploymentTargetCatalog';

export type PlatformFailureNoticeHost = Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    readEnvironment(request: Readonly<{ environmentId: string; context: Readonly<{ signal: AbortSignal }> }>): Promise<DeploymentEnvironmentDetailV1>;
    readReceipt(request: Readonly<{ environmentId: string; deploymentId: string; context: Readonly<{ signal: AbortSignal }> }>): Promise<DeploymentReceiptDetailV1>;
    acquirePluginRuntimeRegistryLease(): Promise<Readonly<{
        registry: Pick<PluginRuntimeRegistryLease['registry'], 'contributes'>;
        release(): Promise<void>;
    }>>;
}>;
export type PlatformFailureNoticeObservation = Readonly<{
    caller: PluginMachineMaterializationRefV1; definition: AutomationEventSourceDefinitionV1;
    observation: AutomationEventAdmitInputV1; signal: AbortSignal;
}>;

const refuse = (code: 'target_mismatch' | 'invalid_parameters' | 'notice_account_scope_mismatch'): never => {
    throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code });
};

/** Consumes an admitted source observation; descriptor and current link own its association. */
export function createPlatformFailureNotices(host: PlatformFailureNoticeHost) {
    const store = createCredentialedAccountArtifactStore(host.credentials);
    const deliver = createCommittedServiceHealthDelivery(host);
    return async (input: PlatformFailureNoticeObservation): Promise<
        Readonly<{ kind: 'notApplicable' }> | Readonly<{ kind: 'consumed'; changed: boolean; artifactId: string }>
    > => {
        input.signal.throwIfAborted();
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            const { definition, observation, caller } = input;
            const declarations = lease.registry.contributes.deploymentTargets;
            const failed = sameStrictJsonValue(definition.eventRef, DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed);
            const succeeded = sameStrictJsonValue(definition.eventRef, DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded);
            if (!failed && !succeeded) {
                return { kind: 'notApplicable' };
            }
            if (!sameStrictJsonValue(definition.eventRef, observation.eventRef) || caller.pluginId !== definition.eventRef.pluginId
                || caller.machineId !== host.machineId) return refuse('target_mismatch');
            const scope = DeploymentReceiptEventSourceConfigV1Schema.safeParse(definition.sourceConfig);
            const transition = (failed ? DeploymentFailedEventV1Schema : DeploymentReceiptOutcomeEventV1Schema).safeParse(observation.payload);
            if (!scope.success || !transition.success) return refuse('invalid_parameters');
            const subject = transition.data;
            if (!scope.data.targetLinkId || !scope.data.credentialPrincipal) return { kind: 'notApplicable' };
            if (scope.data.serverId !== host.serverId || scope.data.environmentId !== subject.environmentId
                || scope.data.targetLinkId !== subject.targetLinkId) return refuse('target_mismatch');
            const detail = await host.readEnvironment({ environmentId: subject.environmentId, context: { signal: input.signal } });
            const environment = detail.environment;
            const row = detail.targetLinks.find(value => value.targetLink.id === subject.targetLinkId);
            const link = row?.targetLink;
            if (!link || environment.serverId !== host.serverId || environment.id !== subject.environmentId
                || !environment.capabilities.read || environment.controllerMachineId !== host.machineId
                || environment.runtimeTargetLinkId !== link.id || link.environmentId !== environment.id || link.role !== 'runtime'
                || link.state === 'none' || link.source.kind !== 'plugin'
                || !sameStrictJsonValue(row?.content?.credentialPrincipal, scope.data.credentialPrincipal)) return refuse('target_mismatch');
            const descriptor = readDeploymentTargetV1(link.source, declarations);
            if (!descriptor || descriptor.role !== 'runtime' || descriptor.targetKind !== link.targetKind) return refuse('target_mismatch');
            const accountId = readAccountIdFromToken(host.credentials.token);
            if (!accountId) return refuse('notice_account_scope_mismatch');
            const targetName = buildQualifiedPluginContributionKey(link.source.contribution);
            input.signal.throwIfAborted();
            const receipt = await host.readReceipt({ environmentId: subject.environmentId, deploymentId: subject.deploymentId,
                context: { signal: input.signal } });
            const content = receipt.content;
            const provider = content.platform?.observation;
            const committed = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.writeNotice({
                accountId, source: { kind: 'host', topic: 'service_health', subject: { kind: 'platformTarget',
                    environmentId: environment.id, targetLinkId: link.id } },
                page: { kind: 'host', page: 'environment', targetLinkId: link.id, environment: { serverId: host.serverId,
                    projectSourceId: environment.projectSourceId, environmentId: environment.id } },
                title: `${detail.content.name}: deployment ${failed ? 'failed' : 'succeeded'}`,
                type: failed && environment.protection === 'production' ? 'blocked' : 'update',
                healthPhase: succeeded ? 'recovered' : 'open', resolved: false,
                platformTransition: { transitionId: observation.occurrenceId, observedAtMs: subject.observedAt },
                body: [`Target: ${targetName}. Deployment: ${provider?.providerDeploymentId ?? subject.deploymentId}.`,
                    ...(content.failure?.phase ? [`Phase: ${content.failure.phase}.`] : []),
                    ...(content.failure?.code ? [`Reason: ${content.failure.code}.`] : []),
                    ...(content.sourceIntent?.kind === 'repository' ? [`Source revision: ${content.sourceIntent.sha}.`] : []),
                    ...(provider?.urls ?? []),
                    ...(provider?.steps ?? []).flatMap(step => step.streamRef ? [`Logs: ${step.streamRef}.`] : []),
                ].join(' '), signal: input.signal,
            }));
            try {
                await deliver({ receipt: committed, signal: input.signal, controllerMachineId: environment.controllerMachineId });
            } catch (error) {
                // Delivery availability cannot undo a committed private notice.
                if (!input.signal.aborted) logger.warnLocalFile('[deploymentHealth] Platform notice delivery unavailable', {
                    failureCause: projectActionFailureCauseV1(error, 'deployment.notice.platform_delivery', { allowUnknownErrorCode: false }),
                });
            }
            return { kind: 'consumed', changed: committed.changed, artifactId: committed.artifactId };
        } finally {
            await lease.release();
        }
    };
}
