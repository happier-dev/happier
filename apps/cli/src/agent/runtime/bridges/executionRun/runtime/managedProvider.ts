import type { AccountConnectionManagedConsumerRequest } from '@/providers/broker/accountConnectionSource';
import type { ProviderBrokerAccountConnectionAccess } from '@/providers/broker/daemonProviderBrokerRuntime';
import type { DirectManagedProviderEndpointPreparer } from '@/providers/lifecycle/prepareDirectLaunch';
import type { ResolveManagedProviderPurposeBindingIntent } from '@/providers/managed/resolvePurposeBindingSnapshot';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { projectProviderRuntimeBindingBasis } from '@/providers/spawn/runtimeBindingBasis';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

/** Host-private Run source acquisition. The admitted target and owning Account
 * context are captured by the caller; source admission and custody stay with
 * the canonical Account connection source. */
export type ExecutionRunManagedProviderSourceOpener = (input: Readonly<{
    /** Captured by the issued credential/context producer, never from a cache key. */
    accountId: string;
    request: AccountConnectionManagedConsumerRequest;
    runtimeBindingBasis: import('@happier-dev/protocol').ProviderRuntimeBindingBasisV1;
    agentId: string;
    modelId: string;
    targetMachineId: string;
    expectedAccountSettingsScopeKey: string;
    readAccountSettingsSnapshot(): Promise<ActiveAccountSettingsSnapshot | null>;
    resolveManagedPurposeBindingIntent: ResolveManagedProviderPurposeBindingIntent;
    signal: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
}>) => Promise<ProviderBrokerAccountConnectionAccess | null>;

/** The actual admitted controller supplies this witness. An occurrence is not
 * minted by Provider preparation or inferred from the Run id. */
export type ExecutionRunManagedProviderLifetime = Readonly<{
    agentId: string;
    executionRunOccurrenceId: string;
    signal: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
}>;

export type ExecutionRunManagedProviderEndpointPreparer = (input:
    Parameters<DirectManagedProviderEndpointPreparer>[0] & ExecutionRunManagedProviderLifetime
) => ReturnType<DirectManagedProviderEndpointPreparer>;

/** Run delivery owns only its isolated listener. The captured Account source
 * owns admission, upstream credentials and managed process custody. */
export function createExecutionRunManagedProviderEndpointPreparer(input: Readonly<{
    machineId: string;
    accountId: string;
    readAccountSettingsSnapshot(): Promise<ActiveAccountSettingsSnapshot | null>;
    resolveManagedPurposeBindingIntent: ResolveManagedProviderPurposeBindingIntent;
    openSource: ExecutionRunManagedProviderSourceOpener;
}>): ExecutionRunManagedProviderEndpointPreparer {
    return async ({ scope, authorization, registerCleanup, signal, isCurrent, executionRunOccurrenceId, agentId }) => {
        const basis = projectProviderRuntimeBindingBasis(authorization);
        const unavailable = () => createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: basis.connectionId, machineId: input.machineId,
        });
        if (!input.accountId || scope.kind !== 'execution_run' || basis.deployment.kind !== 'managedLocal'
            || signal.aborted || !await isCurrent()) throw unavailable();
        const snapshot = await input.readAccountSettingsSnapshot();
        const modelId = authorization.binding.selection.model.id;
        if (!snapshot?.scopeKey || !modelId || signal.aborted || !await isCurrent()) throw unavailable();
        const application = { agentTargetKey: basis.agentTargetKey,
            implementationIdentity: basis.deployment.implementationIdentity,
            endpointTemplateId: basis.endpoint.endpointTemplateId, protocol: basis.endpoint.protocol };
        const opened = await input.openSource({
            accountId: input.accountId,
            request: { source: { kind: 'account_connection', connectionId: basis.connectionId,
                expectedConnectionSecurityFingerprint: basis.credentialAuthorization.connectionSecurityFingerprint,
                expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
                    implementationIdentity: basis.deployment.implementationIdentity,
                    managedRuntime: basis.deployment.managedRuntime, purposeBindings: basis.deployment.purposeBindings }) },
                application, consumer: { kind: 'execution_run', executionRunId: scope.executionRunId },
                executionRunOccurrenceId, consumerMachineId: input.machineId },
            targetMachineId: basis.deployment.gatewayPlacement.kind === 'machine'
                ? basis.deployment.gatewayPlacement.machineId : input.machineId,
            runtimeBindingBasis: basis, agentId, modelId,
            expectedAccountSettingsScopeKey: snapshot.scopeKey,
            readAccountSettingsSnapshot: input.readAccountSettingsSnapshot,
            resolveManagedPurposeBindingIntent: input.resolveManagedPurposeBindingIntent,
            signal, isCurrent,
        });
        if (!opened) throw unavailable();
        const resources = createProviderLaunchResourceScope();
        resources.register(async () => { await opened.retire(); await opened.cleanup(); });
        const cleanup = async () => {
            signal.removeEventListener('abort', onAbort);
            await resources.release();
        };
        const onAbort = () => { void cleanup().catch(() => undefined); };
        registerCleanup(cleanup);
        const revalidateBeforeCommit = async () => {
            if (!signal.aborted && await isCurrent() && await opened.revalidate(signal)
                && !signal.aborted && await isCurrent()) return { ok: true as const };
            await cleanup();
            return { ok: false as const, error: unavailable() };
        };
        try {
            const admitted = await revalidateBeforeCommit();
            if (!admitted.ok) throw admitted.error;
            const endpointUrl = opened.access.endpointUrl(application.endpointTemplateId);
            if (!endpointUrl) throw unavailable();
            const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl,
                credentialTransport: basis.runtimeCredentialTransport,
                request: async request => {
                    if (signal.aborted || !await isCurrent() || !await opened.revalidate(request.signal)
                        || signal.aborted || !await isCurrent()) {
                        void cleanup().catch(() => undefined);
                        return { ok: false, reasonCode: 'resource_forbidden' };
                    }
                    return { ok: true, response: await opened.access.request(request) };
                },
            });
            resources.register(consumer.cleanup);
            signal.addEventListener('abort', onAbort, { once: true });
            const current = await revalidateBeforeCommit();
            if (!current.ok) throw current.error;
            return { normalizedUrl: consumer.endpointUrl, downstreamBearer: consumer.credential,
                cleanup, revalidateBeforeCommit };
        } catch (error) {
            await cleanup();
            throw error;
        }
    };
}
