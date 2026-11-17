import { createHash } from 'node:crypto';
import { isPluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ManagedServiceNativeLogResultV1Schema } from '@happier-dev/protocol/local/services/nativeLogsV1';
import { MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { DeploymentActionOutputSchemasV1, DeploymentHealthCurrentResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { resolvePluginUiHostReadActionIdV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { HostResourceWatchError, HostResourceWatchEmit } from '@/plugins/runtime/invocation/services/uiResourceWatch';
import type { RegisterActionSpecRpcHandlersParams } from './registerActionSpecRpcHandlers';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readRetainedVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { isManagedControllerCodecRootV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

type LogsReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'machines.services.list' | 'deployments.logs' | 'deployments.health.edge' | 'database.connection' }>;
type ReadObservation = NonNullable<NonNullable<ActionExecutorContext['machineServiceLogsResource']>['observation']>
    & Readonly<{ invalidate(digest: string): void }>;

/** Keep an Action's typed refusal inside its original invocation, including its carried native review. */
export function readDaemonHostResourceActionFailure(error: unknown): ActionExecuteFailure | null {
    if (!isPluginError(error)) return null;
    const failure = ActionExecuteFailureSchema.safeParse(error.cause);
    return failure.success && failure.data.errorCode === error.code ? failure.data : null;
}

/** Host references borrow Action admission; this adapter owns no log source or policy. */
export function createDaemonHostResourceRead(input: Readonly<{
    resolveActionExecutor?: RegisterActionSpecRpcHandlersParams['resolveActionExecutor'];
    readAccountId?: () => string | null;
}>) {
    const current = async (context?: RpcHandlerContext) => {
        context?.signal.throwIfAborted();
    };
    const releaseAccountId = (context?: RpcHandlerContext): string => {
        // Disposal releases an existing slot, not log-read authority. Its
        // captured Home stamp remains an identity after current access retires.
        const actor = context?.machineAdmission?.actorAccountId;
        if (actor) return actor;
        const original = readRetainedVerifiedExternalActionRequester(context?.callerInputAuthorization);
        if (original) return original.authorization.binding.accountId;
        const own = context?.localActionContext ? input.readAccountId?.() : null;
        if (!own) throw new PluginError({ code: 'requester_credentials_unavailable' });
        return own;
    };
    const accountId = async (context?: RpcHandlerContext, reference?: LogsReference, onDisclosureLost?: () => void) => {
        const actionId = resolvePluginUiHostReadActionIdV1(reference?.hostRead ?? 'machines.services.logs');
        const refuse: (code: string) => never = (code) => {
            onDisclosureLost?.();
            throw new PluginError({ code });
        };
        await current(context);
        const ownAccountId = input.readAccountId?.();
        const actorAccountId = context?.machineAdmission?.actorAccountId;
        // Generic Machine RPC is not the original logs invocation. In-process
        // host callers retain private context; remote callers need the existing
        // receiving-host requester projection, never a JSON origin assertion.
        if (context?.localActionContext && !context.callerInputAuthorization) {
            if (!ownAccountId || actorAccountId && actorAccountId !== ownAccountId)
                refuse('requester_credentials_unavailable');
            return ownAccountId;
        }
        const authorization = context?.callerInputAuthorization;
        const requester = readRequesterAccountActionContext(authorization);
        const original = readRetainedVerifiedExternalActionRequester(authorization);
        const admission = context?.machineAdmission;
        if (authorization && original && (requester || isManagedControllerCodecRootV1(authorization.binding))
            && context?.localActionContext?.externalActionExecutionAuthorization === authorization
            && authorization.binding.actionId === actionId
            && authorization.binding.target.kind === 'machine'
            && authorization.binding.target.machineId === authorization.binding.machineId
            && (!admission || authorization.binding.machineId === admission.machineId
                && authorization.binding.installationId === admission.installationId
                && authorization.binding.accountId === admission.actorAccountId
                && authorization.binding.custodianAccountId === admission.custodianAccountId)) {
            if (!await original.isCurrent() || (requester && !await requester.isCurrent())) refuse('expired_resource');
            return authorization.binding.accountId;
        }
        if (!authorization || authorization.binding.actionId !== actionId
            || authorization.binding.target.kind !== 'machine' || !admission
            || authorization.binding.target.machineId !== admission.machineId
            || authorization.binding.machineId !== admission.machineId
            || authorization.binding.installationId !== admission.installationId
            || authorization.binding.accountId !== actorAccountId
            || authorization.binding.custodianAccountId !== admission.custodianAccountId
            || !requester) {
            refuse('service_admission_unavailable');
        }
        if (!await requester.isCurrent()) refuse('expired_resource');
        if (!actorAccountId)
            refuse('requester_credentials_unavailable');
        // Original-Account custody may belong to an admitted foreign requester;
        // the daemon's own credential is only the same-process fallback above.
        return actorAccountId;
    };
    const read = async (reference: LogsReference, machineId: string, context?: RpcHandlerContext,
        observation?: ReadObservation, onDisclosureLost = observation?.retire) => {
        // Connection references are unwrapped into the declared Resource owner at RPC ingress.
        if (reference.hostRead === 'database.connection') throw new PluginError({ code: 'plugin_resource_service_unavailable' });
        const actionId = resolvePluginUiHostReadActionIdV1(reference?.hostRead ?? 'machines.services.logs');
        await accountId(context, reference, onDisclosureLost);
        const request = reference.input;
        getActionSpec(actionId).inputSchema.parse(request);
        if (request.machineId !== machineId) throw new PluginError({ code: 'machine_target_mismatch' });
        const resolver = input.resolveActionExecutor;
        const retained = context?.callerInputAuthorization?.requesterAccountExecutor;
        if (!retained && !resolver) throw new PluginError({ code: 'service_admission_unavailable' });
        const executor = retained ?? await resolver!({ actionId, method: actionId,
            isAlias: false, input: request, ...(context ? { ingress: context } : {}) });
        const result = await executor.execute(actionId, request, {
            ...buildActionExecutorContextForRpc({ ...context, actionId, serverId: request.serverId }),
            ...context?.localActionContext,
            ...(reference.hostRead === 'machines.services.logs' || reference.hostRead === 'deployments.logs' ? {
                machineServiceLogsResource: { expectedGeneration: reference.hostRead === 'deployments.logs' ? reference.sourceRevision : reference.expectedGeneration,
                    sourceRevision: reference.sourceRevision,
                    ...(observation ? { observation } : {}) },
            } : reference.hostRead === 'machines.services.list' ? { machineServicesListResource: {
                ...(observation ? { observation } : {}),
            } } : {}),
        });
        await current(context);
        if (!result.ok) throw new PluginError({ code: result.errorCode, message: result.error }, { cause: result });
        const deploymentLogs = reference.hostRead === 'deployments.logs' ? DeploymentActionOutputSchemasV1['deployments.logs.read'].parse(result.result) : null;
        if (deploymentLogs && !deploymentLogs.ok) throw new PluginError({ code: deploymentLogs.error });
        const edge = reference.hostRead === 'deployments.health.edge'
            ? DeploymentHealthCurrentResultV1Schema.parse(result.result) : null;
        if (edge && !edge.ok) throw new PluginError({ code: edge.error });
        const value = edge?.ok ? edge : deploymentLogs?.ok ? deploymentLogs.logs : reference.hostRead === 'machines.services.list'
            ? MachineServicesListResultV1Schema.parse(result.result)
            : ManagedServiceNativeLogResultV1Schema.parse(result.result);
        const bytes = Buffer.from(JSON.stringify(value), 'utf8');
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        return { value, bytes, digest };
    };
    return {
        accountId,
        releaseAccountId,
        current,
        read,
        async observe(reference: LogsReference, machineId: string, context: RpcHandlerContext | undefined,
            signal: AbortSignal, emit: HostResourceWatchEmit, end: (error?: HostResourceWatchError) => void): Promise<Disposable & Readonly<{ digest: string }>> {
            if (reference.hostRead === 'database.connection') throw new PluginError({ code: 'plugin_resource_service_unavailable' });
            if (reference.hostRead === 'deployments.health.edge') {
                const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                const projection = lease?.registry.currentDomainEdgeObservation;
                if (!lease || !projection) {
                    await lease?.release();
                    throw new PluginError({ code: 'service_unavailable' });
                }
                const onChange = projection.subscribe(() => {
                    if (signal.aborted) return;
                    void read(reference, machineId, context).then(value => {
                        if (!signal.aborted) emit(value.digest);
                    }).catch(error => {
                        if (!signal.aborted) end({ code: 'unavailable',
                            diagnostics: [isPluginError(error) ? error.code : 'plugin_resource_unavailable'] });
                    });
                }, { environmentId: reference.input.environmentId, targetLinkId: reference.input.targetLinkId,
                    ...(reference.input.domainIds ? { domainIds: reference.input.domainIds } : {}) });
                try {
                    const initial = await read(reference, machineId, context);
                    return { digest: initial.digest, async dispose() { onChange.dispose(); await lease.release(); } };
                } catch (error) { onChange.dispose(); await lease.release(); throw error; }
            }
            const unavailable = (error: unknown) => {
                if (!signal.aborted) end({ code: 'unavailable',
                    diagnostics: [isPluginError(error) ? error.code : 'plugin_resource_unavailable'] });
            };
            const retire = (error?: import('@happier-dev/protocol/plugins/errors').PluginErrorContract) => error ? unavailable(error) : end();
            let subscription: Disposable | undefined;
            const release = readRequesterAccountActionContext(context?.callerInputAuthorization)?.retain();
            const cancelled = () => retire();
            context?.signal.addEventListener('abort', cancelled, { once: true });
            try {
                const initial = await read(reference, machineId, context, { signal, retire,
                    invalidate(digest) {
                        if (signal.aborted) return;
                        // The producer already established the changed fact. The
                        // consumer re-enters the same admitted list Action once.
                        emit(digest);
                    },
                    async emit(value, delivery) {
                        if (signal.aborted) return;
                        // The retained admission remains local; pushed Machine
                        // access loss closes this watch through its owner.
                        try {
                            await accountId(context, reference, retire);
                            if (signal.aborted) return;
                            const bytes = Buffer.from(JSON.stringify(value), 'utf8');
                            const digest: `sha256:${string}` = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
                            await emit(digest, delivery === 'pages'
                                ? [{ contentType: 'application/json', bytesBase64: bytes.toString('base64'), digest }] : undefined);
                        } catch (error) {
                            if (delivery === 'pages') throw error;
                            unavailable(error);
                        }
                    }, accept(value) { subscription = value; } });
                if (!subscription || signal.aborted) throw new PluginError({ code: 'service_unavailable' });
                const held = subscription;
                return { digest: initial.digest, async dispose() {
                    context?.signal.removeEventListener('abort', cancelled);
                    try { await held.dispose(); } finally { await release?.(); }
                } };
            } catch (error) {
                context?.signal.removeEventListener('abort', cancelled);
                try { await subscription?.dispose(); } finally { await release?.(); }
                throw error;
            }
        },
    };
}
