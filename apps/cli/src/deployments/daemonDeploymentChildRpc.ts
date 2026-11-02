import { DeploymentChildRpcV1Schema, readDeploymentChildRpcV1 } from '@happier-dev/protocol';
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
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

type InstalledRuntime = Readonly<{ serverId: string; machineId: string; accountId: string;
    credentials: StoredCredentials; serverHttpBaseUrl: string; isCurrent(): Promise<boolean> }>;

/** Installed child ingress consumes the original admitted root; it never executes another Action. */
export function registerDaemonDeploymentChildRpcHandler(registrar: RpcHandlerRegistrar, host: Readonly<{
    machineId: string;
    resolveRequesterIdentity: import('./readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    resolveRequesterRuntime(ingress: RpcHandlerContext): Promise<AdmittedRequesterAccountReadRuntime | null>;
    resolveInstalledRuntime(signal: AbortSignal, accountId: string): Promise<InstalledRuntime | null>;
    acquirePluginRuntimeRegistryLease(): Promise<PluginRuntimeRegistryLease>;
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
        if (!readDeploymentChildRpcV1({ rootActionId: authority.binding.actionId,
            rootPreparationAdmission: authority.binding.deploymentPreparationAdmission,
            effectActionId: packet.externalActionExecution.effectActionId, method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: job })) return failure();
        let admissionRefusal = 'action_forbidden';
        // The admitted requester owner performs the one Home verification.
        // Preserve its refusal instead of re-running that same request here.
        const requesterRuntime = await host.resolveRequesterRuntime({ ...ingress, async verifyMachineAdmissionCurrent() {
            try {
                const current = await ingress.verifyMachineAdmissionCurrent!();
                if (!current) admissionRefusal = 'deployment_child_admission_revoked';
                return current;
            } catch {
                admissionRefusal = ingress.signal.aborted ? 'cancelled' : 'home_unreachable';
                return false;
            }
        } });
        if (ingress.signal.aborted) return failure('cancelled');
        if (!requesterRuntime || requesterRuntime.accountId !== authority.binding.accountId) return failure(admissionRefusal);
        const requester = readRequesterAccountActionContext(requesterRuntime.accountAuthorization);
        if (!requester) return failure();
        const installed = await host.resolveInstalledRuntime(ingress.signal, admission.custodianAccountId);
        if (!installed || installed.machineId !== host.machineId || !await installed.isCurrent()) return failure();
        const assertInstalledCurrent = async () => {
            if (ingress.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
            if (!await installed.isCurrent()) {
                throw Object.assign(new Error('Deployment custody is no longer current'), { code: 'action_forbidden' });
            }
        };
        const context = buildActionExecutorContextForRpc({ ...ingress, actionId: job.actionId,
            runtimeAccountId: requesterRuntime.accountId,
            serverId: job.input.serverId, externalActionTarget: authority.binding.target,
            externalActionExecutionAuthorization: requesterRuntime.accountAuthorization });
        const deps = createDaemonDeploymentActionDeps({ credentials: requester.credentials,
            ...(host.captureNativeSetup ? { captureNativeSetup: host.captureNativeSetup } : {}),
            resolveRequesterIdentity: host.resolveRequesterIdentity,
            installedCredentials: installed.credentials,
            savedSecretOperationContext: requester.savedSecretOperationContext, serverId: job.input.serverId,
            serverHttpBaseUrl: requesterRuntime.serverHttpBaseUrl, machineId: host.machineId,
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials: installed.credentials,
                resolveRequesterIdentity: host.resolveRequesterIdentity,
                credentialProfileId: installed.serverId,
                serverId: job.input.serverId, serverHttpBaseUrl: installed.serverHttpBaseUrl, machineId: host.machineId,
                acquirePluginRuntimeRegistryLease: host.acquirePluginRuntimeRegistryLease, assertInstalledCurrent,
                ...(host.signal ? { signal: host.signal } : {}) }) });
        if (authority.binding.actionId === 'deployments.publish') {
            const parent = await readReviewedDeploymentChildRoot({ authorization: requesterRuntime.accountAuthorization,
                envelope: ingress.originalActionEnvelope, actionId: job.actionId, machineId: host.machineId,
                params: job, signal: ingress.signal });
            if (!parent) return failure(ingress.signal.aborted ? 'cancelled' : 'action_forbidden');
            return invokeHostReviewedChildV1({ parent, context, receivingAdmission: admission,
                child: { action: job.actionId, role: 'publish.deploy', input: projectNativeJsonValueForTransport(job.input) },
                execute: (_input, childContext) => deps.deploymentChild(job, childContext) });
        }
        return deps.deploymentChild(job, context);
    });
}
