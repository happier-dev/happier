import { createHash } from 'node:crypto';
import { MachineServiceAdoptInputV1Schema, MachineServiceAdoptResultV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure,
    DeploymentEnvironmentCreateInputV1 } from '@happier-dev/protocol';
import type { HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeStrictJsonValue, projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { DeploymentNativeComposeOriginV1 } from '@happier-dev/deployment-protocol';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';

const CREATE_ROLE = 'adopt-environment';
const BINDINGS_ROLE = 'adopt-bindings';
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
type Host = Readonly<{
    serverId: string; machineId: string;
    ensureServiceObservations?(): Promise<void>;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    readInstallation(context: ActionExecutorContext): Promise<string>;
    prepareCreate(request: Readonly<{ input: ReturnType<typeof DeploymentEnvironmentCreateIntentInputV1Schema.parse>;
        context: ActionExecutorContext; nativeOrigin: DeploymentNativeComposeOriginV1 }>):
        Promise<Readonly<{ input: DeploymentEnvironmentCreateInputV1; preview: unknown }>
            | Readonly<{ existingNative: Readonly<{ environmentId: string; revision: number; targetLinkId: string }> }>
            | ActionExecuteFailure>;
    readEnvironment(request: Parameters<typeof readDeploymentEnvironmentForHost>[0]): ReturnType<typeof readDeploymentEnvironmentForHost>;
    readOperation?: Parameters<typeof createDaemonDeploymentActionDeps>[0]['readOperation'];
    runActionOperation?: ActionExecutorDeps['runActionOperation'];
}>;

/** Explicit adoption demand only. The native adapter is the sole Compose import producer. */
export async function prepareServiceAdoptionForHost(request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    host: Host): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure> {
    const parsed = MachineServiceAdoptInputV1Schema.safeParse(request.input);
    if (!parsed.success) return failure('invalid_parameters');
    const input = parsed.data;
    if (input.serverId !== host.serverId || input.machineId !== host.machineId) return failure('target_mismatch');
    try {
        await host.ensureServiceObservations?.();
        const capture = async (context: ActionExecutorContext) => {
            const registry = host.acquirePluginRuntimeRegistryLease ? await host.acquirePluginRuntimeRegistryLease()
                : tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!registry) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            try {
                const handle = registry.registry.projectManagedServices.listMachineServices().find(handle =>
                    handle.serviceId === input.serviceId && handle.machineId === input.machineId);
                if (!handle || !await isServerProfileHomeIdentity(input.serverId, handle.serverId)
                    || handle.instanceId !== input.expectedGeneration || !handle.isCurrent() || handle.retirementSignal.aborted) {
                    throw Object.assign(new Error('approval_stale'), { code: 'approval_stale' });
                }
                const selected = await registry.registry.resolveProjectNativeAdapter(handle.watch.adapter, 'nativeServiceLifecycle');
                if (selected.kind !== 'ready') throw Object.assign(new Error('service_admission_unavailable'), { code: 'service_admission_unavailable' });
                const native = selected.lease.captureNativeServiceLifecycle(handle.watch, { machine: { serverId: host.serverId,
                    machineId: host.machineId }, ...(context.signal ? { signal: context.signal } : {}) });
                if (native.kind !== 'ready') throw Object.assign(new Error('service_admission_unavailable'), { code: 'service_admission_unavailable' });
                try {
                    if (!native.captureComposeDefinition) throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
                    const captured = await native.captureComposeDefinition(input.profiles, { signal: context.signal });
                    const installationId = await host.readInstallation(context);
                    const origin = { ...captured.origin, capture: { installationId } };
                    // Only value-free source, native identity and selected future profiles enter this digest.
                    const reviewedDigest = `sha256:${createHash('sha256').update(createCanonicalJsonSigningInput({
                        origin, containerIds: captured.containerIds, document: captured.document, variables: captured.variables,
                        services: captured.services, profiles: captured.profiles,
                    })).digest('hex')}`;
                    return { captured, origin, reviewedDigest };
                } finally { await native.release(); }
            } finally { await registry.release(); }
        };
        const reviewed = await capture(request.context);
        const review = MachineServiceAdoptResultV1Schema.parse({ kind: 'review', originalProfiles: 'unknown',
            reviewedDigest: reviewed.reviewedDigest, document: reviewed.captured.document,
            variables: reviewed.captured.variables, services: reviewed.captured.services,
            profiles: reviewed.captured.profiles, availableProfiles: reviewed.captured.availableProfiles });
        if (input.mode === 'review') return { children: [], approvalPreview: normalizeStrictJsonValue(review),
            executeAdmittedAction: async () => ({ ok: true, result: review }) };
        if (reviewed.reviewedDigest !== input.reviewedDigest) return failure('approval_stale');
        const requested = new Map(input.bindings.map(binding => [`${binding.phase}:${binding.name}`, binding]));
        if (requested.size !== input.bindings.length || requested.size !== reviewed.captured.variables.length
            || reviewed.captured.variables.some(variable => !requested.has(`${variable.phase}:${variable.name}`))) return failure('secret_binding_required');
        const create = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ ...input.destination, serverId: input.serverId,
            requestKey: input.requestKey, mode: 'apply', firstTargetLink: { machines: [{ machineId: input.machineId,
                installationId: reviewed.origin.capture.installationId }] },
            definition: { from: 'compose', document: reviewed.captured.document, profiles: reviewed.captured.profiles,
                services: reviewed.captured.services },
            controllerMachineId: input.destination.controllerMachineId ?? input.machineId });
        return { children: [
            { action: 'deployments.environments.create', role: CREATE_ROLE,
                scopeInput: { serverId: input.serverId, ...(create.projectSourceId ? { projectSourceId: create.projectSourceId } : {}) } },
            ...(input.bindings.length ? [{ action: 'deployments.bindings.set' as const, role: BINDINGS_ROLE }] : []),
        ], approvalPreview: normalizeStrictJsonValue(review), executeAdmittedAction: async execution => {
            const run = execution.context.runActionOperation ?? host.runActionOperation;
            if (!run || !execution.context.hostReviewedChild) return failure('action_operation_unavailable');
            return run({ actionId: 'machines.services.adopt', input, context: execution.context, execute: async context => {
                let prepared: DeploymentEnvironmentCreateInputV1 | undefined;
                let environmentId: string | undefined;
                let revision: number | undefined;
                let targetLinkId: string | undefined;
                const partial = (errorCode: string) => prepared ? { ok: true as const, result: MachineServiceAdoptResultV1Schema.parse({
                    kind: 'partial', errorCode, preparedCreate: prepared,
                    ...(environmentId ? { environmentId, revision } : {}), ...(targetLinkId ? { targetLinkId } : {}),
                }) } : failure(errorCode);
                try {
                    const priorOperation = context.operationAcceptance && host.readOperation
                        ? await host.readOperation(context.operationAcceptance.operationId, context) : null;
                    const prior = MachineServiceAdoptResultV1Schema.safeParse(priorOperation?.result);
                    if (prior.success && prior.data.kind === 'partial') {
                        prepared = prior.data.preparedCreate; environmentId = prior.data.environmentId;
                        revision = prior.data.revision; targetLinkId = prior.data.targetLinkId;
                    }
                    if (!prepared) {
                        const createdInput = await host.prepareCreate({ input: create, context, nativeOrigin: reviewed.origin });
                        if ('errorCode' in createdInput) return createdInput;
                        if ('existingNative' in createdInput) return { ok: true, result: { kind: 'adopted', ...createdInput.existingNative } };
                        prepared = createdInput.input;
                    }
                    if (!environmentId) {
                        const created = await context.hostReviewedChild!.invoke({ action: 'deployments.environments.create', role: CREATE_ROLE,
                            input: projectNativeJsonValueForTransport(prepared) });
                        if (!created.ok) return partial(created.errorCode);
                        const result = DeploymentEnvironmentCreateResultV1Schema.safeParse(created.result);
                        if (!result.success) return partial('invalid_action_output');
                        if (!result.data.ok) return partial(result.data.error);
                        environmentId = result.data.environmentId; revision = result.data.revision;
                    }
                    const current = await host.readEnvironment({ environmentId, context });
                    revision = current.environment.revision;
                    targetLinkId = current.environment.runtimeTargetLinkId ?? undefined;
                    if (!targetLinkId) return partial('target_mismatch');
                    if (!sameStrictJsonValue(current.content.bindings, input.bindings)) {
                        if (current.environment.contentArtifactId !== prepared.contentArtifactId
                            || current.environment.contentHeaderVersion !== prepared.contentHeaderVersion
                            || current.environment.contentBodyVersion !== prepared.contentBodyVersion) return partial('deployment_conflict');
                        const runtime = current.targetLinks.find(link => link.id === targetLinkId);
                        if (!sameStrictJsonValue(runtime?.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                            prepared.firstTargetLink?.machines)) return partial('approval_stale');
                        const applied = await context.hostReviewedChild!.invoke({ action: 'deployments.bindings.set', role: BINDINGS_ROLE,
                            input: normalizeStrictJsonValue({ serverId: input.serverId, environmentId, expectedRevision: revision,
                                set: input.bindings, remove: [] }) });
                        if (!applied.ok) return partial(applied.errorCode);
                        const result = DeploymentBindingsSetResultV1Schema.safeParse(applied.result);
                        if (!result.success) return partial('invalid_action_output');
                        if (!result.data.ok) return partial(result.data.error);
                        revision = result.data.revision;
                    }
                    return { ok: true, result: MachineServiceAdoptResultV1Schema.parse({ kind: 'adopted', environmentId, revision, targetLinkId }) };
                } catch (error) {
                    return partial(context.signal?.aborted ? 'cancelled' : error instanceof Error && 'code' in error
                        && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable');
                }
            } });
        } };
    } catch (error) {
        return failure(request.context.signal?.aborted ? 'cancelled' : error instanceof Error && 'code' in error
            && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable');
    }
}
