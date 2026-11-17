import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { deploymentAuthorizationFailure, refuseDeploymentAuthorization } from './deploymentAuthorizationFailure';
import { projectDeploymentException } from './deploymentFailure';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentChildRpcV1Schema, readDeploymentChildRpcV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { readReviewedDeploymentChildRoot } from '@/api/externalActionExecutionAuthorization';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { AdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

type InstalledRuntime = Readonly<{ serverId: string; machineId: string; accountId: string;
    credentials: StoredCredentials; serverHttpBaseUrl: string; isCurrent(): Promise<boolean> }>;

/** Installed child ingress consumes the original admitted root; it never executes another Action. */
export function registerDaemonDeploymentChildRpcHandler(registrar: RpcHandlerRegistrar, host: Readonly<{
    machineId: string;
    executeManagedSnapshot?: import('./daemonDeploymentNativeSnapshot').ExecuteManagedNativeSnapshot;
    resolveRequesterIdentity: import('./readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    resolveRequesterRuntime(ingress: RpcHandlerContext): Promise<AdmittedRequesterAccountReadRuntime | null>;
    resolveInstalledRuntime(signal: AbortSignal, accountId: string): Promise<InstalledRuntime | null>;
    acquirePluginRuntimeRegistryLease(): Promise<PluginRuntimeRegistryLease>;
    ensureServiceObservations?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
    captureNativeSetup?(): import('./targets/ownServer/ownServerDomainNative').DomainNativeSetupForHost;
    signal?: AbortSignal;
}>): void {
    registrar.registerHandler<unknown, unknown>(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, async (raw, ingress) => {
        const failure = (errorCode = 'action_forbidden') => ({ ok: false as const, errorCode, error: errorCode });
        const parsed = DeploymentChildRpcV1Schema.safeParse(raw);
        if (!parsed.success) return failure('invalid_parameters');
        const job = parsed.data;
        const authority = ingress?.callerInputAuthorization;
        const admission = ingress?.machineAdmission;
        const packet = ingress?.workspaceSyncSourceExecution;
        // The manager binds the signed wire bytes before decrypting. Compare
        // the full admitted private job here, never ciphertext or lossy routing.
        const admittedChild = readRequesterAccountActionContext(authority)?.deploymentChild;
        if (ingress?.signal.aborted) return failure('cancelled');
        if (!ingress || !authority || !admission || !packet || !ingress.originalActionEnvelope
            || !ingress.verifyMachineAdmissionCurrent) return failure('deployment_child_custody_missing');
        if (job.machineId !== host.machineId || admission.machineId !== host.machineId
            || admission.installationId !== job.installationId) return failure('target_mismatch');
        if (packet.method !== `${host.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`
            || !sameStrictJsonValue(admittedChild, job)
            || !sameStrictJsonValue(packet.originalActionEnvelope, ingress.originalActionEnvelope)
            || packet.externalActionExecution.authorization.token !== authority.token
            || !sameStrictJsonValue(packet.externalActionExecution.authorization.binding, authority.binding)) {
            return failure('deployment_child_binding_mismatch');
        }
        if (!readDeploymentChildRpcV1({ deploymentChildRoot: authority.binding.deploymentChildRoot, rootActionId: authority.binding.actionId,
            rootPreparationAdmission: authority.binding.deploymentPreparationAdmission,
            reviewedChild: packet.externalActionExecution.reviewedChild,
            effectActionId: packet.externalActionExecution.effectActionId, method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: job })) return deploymentAuthorizationFailure('child_root_derivation_refused');
        let admissionRefusal = 'action_forbidden';
        let admissionFailure: ActionExecuteFailure | undefined;
        // The admitted requester owner performs the one Home verification.
        // Preserve its refusal instead of re-running that same request here.
        const requesterRuntime = await host.resolveRequesterRuntime({ ...ingress, async verifyMachineAdmissionCurrent() {
            try {
                const current = await ingress.verifyMachineAdmissionCurrent!();
                if (!current) admissionRefusal = 'deployment_child_admission_revoked';
                return current;
            } catch (error) {
                // Only the Home transport owner's proven no-dispatch makes this an outage; any other
                // throw keeps its own typed cause through the one deployment classifier.
                admissionRefusal = ingress.signal.aborted ? 'cancelled' : 'home_unreachable';
                if (!ingress.signal.aborted && classifyHomeDomainHttpMutationFailureV1({ error, issued: true, aborted: false }) !== 'not_dispatched') {
                    admissionFailure = projectDeploymentException(error, { phase: 'deployment.child.admission_current' });
                }
                return false;
            }
        } });
        if (ingress.signal.aborted) return failure('cancelled');
        if (!requesterRuntime && admissionFailure) return admissionFailure;
        if (!requesterRuntime) return admissionRefusal === 'action_forbidden'
            ? deploymentAuthorizationFailure('requester_runtime_unavailable') : failure(admissionRefusal);
        if (requesterRuntime.accountId !== authority.binding.accountId) return deploymentAuthorizationFailure('requester_account_mismatch');
        const requester = readRequesterAccountActionContext(requesterRuntime.accountAuthorization);
        if (!requester) return deploymentAuthorizationFailure('requester_context_unavailable');
        const installed = await host.resolveInstalledRuntime(ingress.signal, admission.custodianAccountId);
        if (!installed) return deploymentAuthorizationFailure('installed_target_unavailable');
        if (installed.machineId !== host.machineId) return deploymentAuthorizationFailure('installed_target_machine_mismatch');
        if (!await installed.isCurrent()) return deploymentAuthorizationFailure('installed_target_not_current');
        const assertInstalledCurrent = async () => {
            if (ingress.signal.aborted) throw createActionExecuteFailureError({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
            if (!await installed.isCurrent()) {
                refuseDeploymentAuthorization('installed_target_not_current');
            }
        };
        const context = buildActionExecutorContextForRpc({ ...ingress, actionId: job.actionId,
            runtimeAccountId: requesterRuntime.accountId,
            serverId: job.input.serverId, externalActionTarget: authority.binding.target,
            externalActionExecutionAuthorization: requesterRuntime.accountAuthorization });
        // Deployment dependencies load on the first deployment child RPC.
        const [{ createDaemonDeploymentActionDeps }, { createOwnServerDeploymentRuntimeForHost }] = await Promise.all([
            import('./createDaemonDeploymentActionDeps'),
            import('./targets/ownServer/ownServerDeploymentHostRuntime'),
        ]);
        const deps = createDaemonDeploymentActionDeps({ credentials: requester.credentials,
            ...(host.executeManagedSnapshot ? { executeManagedSnapshot: host.executeManagedSnapshot } : {}),
            ...(host.ensureServiceObservations ? { ensureServiceObservations: host.ensureServiceObservations } : {}),
            ...(host.captureNativeSetup ? { captureNativeSetup: host.captureNativeSetup } : {}),
            resolveRequesterIdentity: host.resolveRequesterIdentity,
            installedCredentials: installed.credentials,
            savedSecretOperationContext: requester.savedSecretOperationContext, serverId: job.input.serverId,
            serverHttpBaseUrl: requesterRuntime.serverHttpBaseUrl, machineId: host.machineId,
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials: installed.credentials,
                ensureServiceObservations: host.ensureServiceObservations,
                resolveRequesterIdentity: host.resolveRequesterIdentity,
                credentialProfileId: installed.serverId,
                serverId: job.input.serverId, serverHttpBaseUrl: installed.serverHttpBaseUrl, machineId: host.machineId,
                acquirePluginRuntimeRegistryLease: host.acquirePluginRuntimeRegistryLease, assertInstalledCurrent,
                ...(host.signal ? { signal: host.signal } : {}) }) });
        const previewDomain = job.kind === 'prepare' && job.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? job.previewDomain : undefined;
        if (authority.binding.actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && job.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1) {
            const parent = await readReviewedDeploymentChildRoot({ authorization: requesterRuntime.accountAuthorization,
                envelope: ingress.originalActionEnvelope, actionId: job.actionId, machineId: host.machineId,
                params: job, signal: ingress.signal, reviewedChild: packet.externalActionExecution.reviewedChild });
            if (!parent) return ingress.signal.aborted ? failure('cancelled') : deploymentAuthorizationFailure('child_root_not_reviewed');
            return invokeHostReviewedChildV1({ parent, context, receivingAdmission: admission,
                ...(previewDomain ? { invocationServices: { deploymentPreviewDomain: previewDomain } } : {}),
                child: { action: job.actionId, role: packet.externalActionExecution.reviewedChild?.role ?? 'template.deploy',
                    input: projectNativeJsonValueForTransport(job.input) },
                execute: (_input, childContext) => deps.deploymentChild(job, childContext) });
        }
        return deps.deploymentChild(job, previewDomain ? { ...context,
            invocationServices: { deploymentPreviewDomain: previewDomain } } : context);
    });
}
