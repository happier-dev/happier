import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { DeploymentExecEnvPortV1 } from '@happier-dev/plugin-sdk/exec';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { createDeploymentExecEnvPortForHost } from '../secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '../secrets/prepareEnvironmentSecretBindingsForLaunch';
import { resolveEnvironmentDeploymentFactForHost } from '../secrets/deploymentFacts';
import { readEnvironmentSecretLaunchAdmissionForHost } from '../secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { createServiceReferenceForwardCustody } from './ownServer/serviceReferenceForwardCustody';
import { acquirePrivateServiceReferenceForwardForHost, resolvePrivateServiceReferenceMaterialForHost } from './ownServer/privateServiceReference';
import type { DeploymentTargetRoleAdmissionForHost, DeploymentTargetRoleAdmissionHost } from './admitDeploymentTargetRoleForHost';

type RuntimeAdmission = DeploymentTargetRoleAdmissionForHost & Readonly<{
    environment: NonNullable<DeploymentTargetRoleAdmissionForHost['environment']>;
    receipt: NonNullable<DeploymentTargetRoleAdmissionForHost['receipt']>;
    executionEnvironment: NonNullable<DeploymentTargetRoleAdmissionForHost['executionEnvironment']>;
    workloadControl: NonNullable<DeploymentTargetRoleAdmissionForHost['workloadControl']>;
}>;
const unavailable = (): never => { throw new PluginError({ code: 'unavailable', message: 'Deployment execution environment is unavailable' }); };

/** Role admission, not the authored prepare operand, selects the executing installation and phase. */
export function createDeploymentTargetRoleExecEnvironmentForHost(input: Readonly<{
    admission: RuntimeAdmission;
    host: DeploymentTargetRoleAdmissionHost;
    context: ActionExecutorContext;
    source: DeploymentSourceMaterializationV1;
    signal: AbortSignal;
    retainCleanup(resource: Readonly<{ dispose(): void | Promise<void> }>): void;
    readOwner(): Parameters<typeof resolvePrivateServiceReferenceMaterialForHost>[0]['owner'] | undefined;
}>): DeploymentExecEnvPortV1 {
    const { admission, host, source } = input;
    const placement = admission.executionEnvironment;
    return createDeploymentExecEnvPortForHost({ source, phase: placement.phase, signal: input.signal,
        isCurrent: () => !input.signal.aborted,
        async prepare({ phase, signal }: Readonly<{ phase: 'build' | 'runtime'; signal: AbortSignal }>) {
            const identity = readInstallationIdentityIfExistsSync();
            if (!identity || identity.installationId !== placement.installationId) return unavailable();
            const privateKey = decodeBase64(identity.privateKey, 'base64url');
            const seed = privateKey.slice(0, 32);
            const forwards = createServiceReferenceForwardCustody({ signal, async acquire(selected, forwardSignal) {
                return acquirePrivateServiceReferenceForwardForHost(selected, remote => {
                    if (!host.acquireServiceExportForward) return unavailable();
                    return host.acquireServiceExportForward({ targetMachineId: remote.machineId,
                        serviceExport: remote.serviceExport, context: input.context, signal: forwardSignal });
                });
            } });
            input.retainCleanup({ dispose: forwards.release });
            let custody: Awaited<ReturnType<typeof readEnvironmentSecretLaunchAdmissionForHost>> | undefined;
            try {
                custody = await readEnvironmentSecretLaunchAdmissionForHost({ credentials: host.credentials,
                    serverId: host.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl,
                    machineId: placement.machineId, installationId: placement.installationId,
                    environmentId: admission.environment.environment.id, targetLinkId: admission.receipt.deployment.targetLinkId,
                    materialization: { kind: 'deployment', deploymentId: admission.receipt.deployment.id },
                    actionOperationId: admission.receipt.deployment.actionOperationId, context: input.context, signal });
                const material = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: source.environmentId,
                    machineId: placement.machineId, installationId: placement.installationId,
                    installationPrivateSeed: seed, phase, bindings: admission.environment.content.bindings, grants: custody.grants,
                    assertCurrent: async () => { signal.throwIfAborted(); await source.assertCurrent(); },
                    async resolveNonSecret(binding) {
                        if (binding.kind === 'deploymentFact') return resolveEnvironmentDeploymentFactForHost(binding.fact, {
                            environmentName: admission.environment.content.name,
                            deploymentId: admission.receipt.deployment.id,
                            commitSha: admission.receipt.content.sourceIntent?.kind === 'repository' ? admission.receipt.content.sourceIntent.sha : undefined,
                            domainUrl: undefined,
                            primaryUrl: undefined,
                            telemetryEndpoint: undefined,
                        });
                        const owner = input.readOwner();
                        if (!owner) return unavailable();
                        return resolvePrivateServiceReferenceMaterialForHost({ source: binding, environment: admission.environment,
                            host, context: input.context, actionId: admission.workloadControl.kind, signal, owner,
                            readEnvironment: host.readEnvironment, homeServerIdentityId: host.serverId,
                            installationId: placement.installationId, privateKey, acquireForward: forwards.acquire });
                    } });
                return { ...material, dispose() { material.dispose(); seed.fill(0); privateKey.fill(0); forwards.retire(); custody?.release?.(); } };
            } catch (error) { seed.fill(0); privateKey.fill(0); await forwards.release(); await custody?.release?.(); throw error; }
        } });
}
