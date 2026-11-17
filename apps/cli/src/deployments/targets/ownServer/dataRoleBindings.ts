import { isDeepStrictEqual } from 'node:util';
import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import { randomUUID } from 'node:crypto';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { applyEnvironmentSecretBindingsPatchV1, isSettledEnvironmentSecretBindingV1,
    type ActionExecutorContext, type DeploymentChildRpcV1 } from '@happier-dev/protocol';
import { DeploymentDataRoleChildRpcV1Schema } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { createActionExecuteFailureError, parseActionExecuteFailure, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentEnvironmentArtifactV1, environmentSecretBindingIdentityV1, machineSecretGrantSubjectKey, MachineSecretGrantV1Schema,
    type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import type { PrepareDataRoleBindingsForHost } from '../../secrets/prepareDeploymentBindingsForHost';
import { prepareEnvironmentSecretBindingsForLaunch } from '../../secrets/prepareEnvironmentSecretBindingsForLaunch';
import { acquireOwnServerDataServiceForHost, resolveOwnServerDataServiceDeclarationForHost, type OwnServerDataServiceHost } from './dataQueryScope';
import { withOwnServerDataQueryNativeForHost } from './dataQueryNative';
import { bootstrapOwnServerReadOnlyDataRoleForHost, bootstrapOwnServerWriteDataRoleForHost } from './dataRoleBootstrap';

type RoleJob = Extract<DeploymentChildRpcV1, { kind: 'dataRole' }>;
type ServiceRole = Extract<EnvironmentSecretBindingV1, { purpose: 'dataRole' }> & { service: string };
const isServiceRole = (binding: EnvironmentSecretBindingV1): binding is ServiceRole => binding.purpose === 'dataRole' && 'service' in binding;
const refuse = (code: string, cause?: unknown): never => { throw Object.assign(createActionExecuteFailureError(parseActionExecuteFailure(cause)
    ?? { ok: false, errorCode: code, error: code }), { message: code, code, cause }); };

/** The bindings author seals the selected credential; the existing mounted data
 * owner installs it before the one Environment bindings CAS publishes it. */
export function createOwnServerDataRoleBindingsForHost(host: OwnServerDataServiceHost & Readonly<{
    open(id: string, context: ActionExecutorContext): Promise<AccountArtifact | null>;
    sendChild(job: DeploymentChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
}>) {
    async function executeChild(job: RoleJob, context: ActionExecutorContext,
        preparedEnvironment?: Parameters<typeof acquireOwnServerDataServiceForHost>[3]) {
        const identity = readInstallationIdentityIfExistsSync();
        if (job.machineId !== host.machineId || identity?.installationId !== job.installationId) return refuse('target_mismatch');
        let environment = preparedEnvironment;
        if (!environment) {
            const settledSet = 'set' in job.input ? job.input.set.filter(isSettledEnvironmentSecretBindingV1) : [];
            if ('set' in job.input && settledSet.length !== job.input.set.length) return refuse('client_required');
            const current = await host.readEnvironment({ environmentId: job.input.environmentId, targetLinkId: job.targetLinkId, context });
            const candidate = 'set' in job.input ? { ok: true as const, content: { ...current.content,
                bindings: applyEnvironmentSecretBindingsPatchV1(current.content.bindings, { set: settledSet, remove: job.input.remove }, randomUUID) } }
                : readDeploymentEnvironmentArtifactV1(job.input, await host.open(job.input.contentArtifactId, context));
            if (!candidate.ok) return refuseDeploymentArtifactRead(candidate);
            environment = { ...current, content: candidate.content };
        }
        const scope = await acquireOwnServerDataServiceForHost(host, { ...job.input, targetLinkId: job.targetLinkId,
            deploymentId: job.deploymentId, machineId: job.machineId, installationId: job.installationId, service: job.service,
            role: job.use.role }, context, environment);
        try {
            if (!isDeepStrictEqual(scope.use, job.use)) return refuse('target_mismatch');
            const signal = context.signal ?? new AbortController().signal;
            const prepared = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: job.input.environmentId,
                machineId: job.machineId, installationId: job.installationId,
                installationPrivateSeed: decodeBase64(identity.privateKey, 'base64url').slice(0, 32),
                bindings: environment.content.bindings, grants: [MachineSecretGrantV1Schema.parse(job.grant)], use: scope.use,
                assertCurrent: async () => { signal.throwIfAborted(); } });
            try {
                const password = prepared.operationalValues.get(environmentSecretBindingIdentityV1(scope.use));
                if (!password) return refuse('secret_missing');
                await withOwnServerDataQueryNativeForHost({ ...scope, operationId: context.actionRequestId ?? randomUUID(), signal },
                    native => (scope.use.role === 'write' ? bootstrapOwnServerWriteDataRoleForHost : bootstrapOwnServerReadOnlyDataRoleForHost)(
                        { ...scope.definition, password, signal }, native));
                return { ok: true as const };
            } finally { prepared.dispose(); }
        } finally { await scope.dispose(); }
    }
    const prepare: PrepareDataRoleBindingsForHost = async request => {
        const { input, environment, content, previousContent, context, runtimeInstallations } = request;
        const roles = content.bindings.filter(isServiceRole);
        const selected = 'set' in input ? input.set.filter(isSettledEnvironmentSecretBindingV1).filter(isServiceRole)
            : roles.filter(use => !previousContent.bindings.some(previous => isDeepStrictEqual(previous, use)));
        const link = environment.targetLinks.find(row => row.id === environment.environment.runtimeTargetLinkId);
        if (selected.length && (!link || link.targetKind !== 'ownServer' || !link.activeDeploymentId || !runtimeInstallations.length)) return refuse('service_unavailable');
        for (const use of selected) resolveOwnServerDataServiceDeclarationForHost(content, use.service);
        const operationalDestinations = [...roles, ...previousContent.bindings.filter(isServiceRole)]
            .map(binding => ({ binding, installations: runtimeInstallations }));
        return { operationalDestinations, dispose() {}, async complete(grants) {
            if (!selected.length || !link?.activeDeploymentId) return;
            for (const use of selected) for (const installation of runtimeInstallations) {
                const ref = parseSavedSecretRefV1(use.source.ref);
                if (ref.kind !== 'shared_resource') return refuse('secret_missing');
                const subject = { v: 1 as const, kind: 'secret' as const, environmentId: input.environmentId,
                    machineId: installation.machineId, installationId: installation.installationId,
                    resourceId: ref.resourceId, resourceRevision: use.source.resourceRevision };
                const grant = grants.find(row => machineSecretGrantSubjectKey(row) === machineSecretGrantSubjectKey(subject));
                if (!grant) return refuse('secret_missing');
                const job = DeploymentDataRoleChildRpcV1Schema.parse({ v: 1, kind: 'dataRole', actionId: 'deployments.bindings.set',
                    input, targetLinkId: link.id, deploymentId: link.activeDeploymentId, service: use.service, use, grant,
                    machineId: installation.machineId, installationId: installation.installationId });
                const result = installation.machineId === host.machineId
                    ? await executeChild(job, context, { ...environment, content,
                        targetLinks: environment.targetLinks.map(targetLink => ({ targetLink })) })
                    : await host.sendChild(job, context);
                const failure = ActionExecuteFailureSchema.safeParse(result);
                if (failure.success) return refuse(failure.data.errorCode, failure.data);
                if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) return refuse('invalid_action_transport_output');
            }
        } };
    };
    return { prepare, executeChild };
}
