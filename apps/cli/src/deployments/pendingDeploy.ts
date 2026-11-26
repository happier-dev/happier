import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import { raceWithAbort } from '@happier-dev/cli-common/plugins/http';
import {
    HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
    HAPPIER_DEPLOYMENT_RECEIPT_INVALIDATED_HOST_EVENT_ID_V1,
    projectDeploymentReceiptCompletionV1,
    type DeploymentReceiptCompletionV1,
} from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import type { StablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { deploymentOutputValidationFailure } from './outputValidation';
import { isDeepStrictEqual } from 'node:util';
import axios from '@/api/client/credentialAxios';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { ActionOperationCancelV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { DeploymentActionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_PENDING_OPERATION_CANCEL_HTTP_PATH_V1 } from '@happier-dev/protocol/deployments/deploymentPendingAdmissionV1';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { DeploymentReceiptListResultV1Schema, readDeploymentAccountChangeV1,
    type ActionExecutorContext, type DeploymentDeployInputV1, type DeploymentEnvironmentHeaderV1,
    type DeploymentEnvironmentGetResultV1Schema, type DeploymentReceiptHeaderV1, type DeploymentReceiptResultV1 } from '@happier-dev/protocol';
import type { z } from 'zod/mini';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { observeSessionSocketEvents } from '@/session/transport/socket/sessionSocketAgentState';
import type { StoredCredentials } from '@/persistence';
import { DeploymentPendingDeployIntentV1Schema, DeploymentPendingDeployStoredIntentV1Schema, DeploymentPendingDeployV1Schema,
    type DeploymentPendingDeployIntentV1 } from '@happier-dev/protocol';
import { readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol';
import { readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployments';
import type { AccountArtifact, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { ActionOperationCancellation, ActionOperationCancellationContext } from '@/daemon/actionOperations/actionOperationTypes';
import { DEFAULT_DEPLOYMENT_ON_FAILURE_V1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

type Resource = NonNullable<Awaited<ReturnType<ReturnType<typeof createCredentialedAccountArtifactStore>['readForUpdate']>>>;
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
const resourceBinding = (environment: DeploymentEnvironmentHeaderV1) => ({ artifactId: environment.contentArtifactId,
    expectedRevision: { headerVersion: environment.contentHeaderVersion, bodyVersion: environment.contentBodyVersion } });

async function readPendingResource(environment: DeploymentEnvironmentHeaderV1,
    read: (artifactId: string) => Promise<Resource | null>) {
    const resource = await read(environment.contentArtifactId);
    if (!resource) return refuse('deployment_content_unavailable');
    const opened = readDeploymentEnvironmentArtifactV1(environment, resource.artifact);
    if (!opened.ok) return refuseDeploymentArtifactRead(opened);
    return resource;
}

/** Open the explicit envelope with the exact owning Environment resource key. */
export async function readPendingDeploymentIntentForHost(request: Readonly<{
    environment: DeploymentEnvironmentHeaderV1; pendingDeploy: import('@happier-dev/protocol').DeploymentPendingDeployV1;
}>, host: Readonly<{ readResource(artifactId: string): Promise<Resource | null> }>): Promise<DeploymentPendingDeployIntentV1> {
    const resource = await readPendingResource(request.environment, host.readResource);
    const intent = DeploymentPendingDeployStoredIntentV1Schema.safeParse(resource.openAssociatedContent({
        ...resourceBinding(request.environment), content: request.pendingDeploy }));
    return intent.success ? intent.data : refuse('deployment_content_unavailable');
}

/** The accepted host binds private intent before spending the storage/native root.
 * Storage cannot establish these facts from an encrypted envelope. */
export async function preparePendingDeploymentForHost(request: Readonly<{
    input: DeploymentDeployInputV1; context: ActionExecutorContext;
}>, host: Readonly<{
    readEnvironment(): Promise<EnvironmentMetadata>;
    readResource(artifactId: string): Promise<Resource | null>;
    open(artifactId: string): Promise<AccountArtifact | null>;
    assertCurrent(): Promise<void>;
}>): Promise<Readonly<{ input: DeploymentDeployInputV1; intent: DeploymentPendingDeployIntentV1 }>> {
    const { input, context } = request;
    const operation = context.operationAcceptance;
    if (!operation || operation.actionId !== 'deployments.deploy') return refuse('operation_unavailable');
    await host.assertCurrent();
    const current = await host.readEnvironment();
    return validatePendingDeploymentInputForHost({ input, current, operationId: operation.operationId }, host);
}

/** The active invocation and cold re-admission validate the same opened intent
 * and candidate before either may spend or restore its operation identity. */
export async function validatePendingDeploymentInputForHost(request: Readonly<{
    input: DeploymentDeployInputV1; current: EnvironmentMetadata; operationId: string;
}>, host: Readonly<{
    readResource(artifactId: string): Promise<Resource | null>;
    open(artifactId: string): Promise<AccountArtifact | null>;
    assertCurrent(): Promise<void>;
}>): Promise<Readonly<{ input: DeploymentDeployInputV1; intent: DeploymentPendingDeployIntentV1 }>> {
    const { input, current, operationId } = request;
    const environment = current.environment;
    if (environment.id !== input.environmentId || !environment.capabilities.deploy) return refuse('deployment_access_denied');
    const candidate = readDeploymentReceiptArtifactV1(input, await host.open(input.contentArtifactId));
    if (!candidate.ok) return refuseDeploymentArtifactRead(candidate);
    const binding = resourceBinding(environment);
    const intent = input.pendingDeploy
        ? await readPendingDeploymentIntentForHost({ environment, pendingDeploy: input.pendingDeploy }, host)
        : DeploymentPendingDeployIntentV1Schema.parse({ sourceIntent: candidate.content.sourceIntent,
            ...(candidate.content.sourceMethod ? { sourceMethod: candidate.content.sourceMethod } : {}),
            ...(candidate.content.onFailure ? { onFailure: candidate.content.onFailure } : {}),
            ...(candidate.content.services ? { services: candidate.content.services } : {}),
            requestKey: input.requestKey, targetLinkId: input.targetLinkId, actionOperationId: operationId });
    // Automation owns authenticated occurrence admission. An opened caller
    // reference is not that proof, in either storage mode.
    if (intent.triggerOccurrence) return refuse('unsupported_action');
    if (intent.requestKey !== input.requestKey || intent.targetLinkId !== input.targetLinkId
        || intent.actionOperationId !== operationId
        || !isDeepStrictEqual(intent.sourceIntent, candidate.content.sourceIntent)
        || intent.sourceMethod !== candidate.content.sourceMethod
        || !isDeepStrictEqual(intent.services, candidate.content.services)
        || !isDeepStrictEqual(input.services, candidate.content.services)
        || (intent.onFailure ?? DEFAULT_DEPLOYMENT_ON_FAILURE_V1) !== (candidate.content.onFailure ?? DEFAULT_DEPLOYMENT_ON_FAILURE_V1)
        || input.onFailure !== undefined && input.onFailure !== candidate.content.onFailure) return refuse('deployment_conflict');
    // Never reseal a retained envelope: exact ciphertext is the storage TAKE
    // operand even when normal preparation creates a fresh receipt Artifact.
    const pendingDeploy = input.pendingDeploy ?? DeploymentPendingDeployV1Schema.parse(
        (await readPendingResource(environment, host.readResource)).sealAssociatedContent({ ...binding, value: intent }));
    await host.assertCurrent();
    return { input: { ...input, pendingDeploy }, intent };
}

type PendingResult = Extract<DeploymentReceiptResultV1, { kind: 'pending' }>;
type EnvironmentMetadata = Extract<z.infer<typeof DeploymentEnvironmentGetResultV1Schema>, { ok: true }>;

/** This wait belongs to the already accepted invocation. Typed Environment
 * changes and reconnects invalidate it; unrelated Account traffic does no reads. */
export async function waitForPendingDeploymentForHost(request: Readonly<{
    input: DeploymentDeployInputV1;
    result: PendingResult; context: ActionExecutorContext;
}>, host: Readonly<{
    credentials: StoredCredentials; serverHttpBaseUrl: string;
    readEnvironment(): Promise<EnvironmentMetadata>;
    readReceipts(): Promise<unknown>;
    resume(): Promise<DeploymentReceiptResultV1 | import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteFailure>;
    cancel(context: ActionOperationCancellationContext): Promise<void>;
    assertCurrent(): Promise<void>;
}>) {
    const { context } = request;
    let revision = 0;
    let observed = 0;
    let failure: unknown;
    const listeners = new Set<() => void>();
    const changed = () => { revision += 1; for (const listener of listeners) listener(); };
    const observation = observeSessionSocketEvents({ token: host.credentials.token, serverUrl: host.serverHttpBaseUrl, scope: 'user' }, {
        onConnected: changed,
        onError: error => { failure = error; changed(); },
        onUpdate: raw => {
            const parsed = UpdateContainerSchema.safeParse(raw);
            if (!parsed.success || parsed.data.body.t !== 'account-change') return;
            if (parsed.data.body.entityIds?.some(entityId => readDeploymentAccountChangeV1({ kind: 'account', entityId })
                ?.environmentId === request.input.environmentId)) changed();
        },
    });
    const waitForChange = () => new Promise<void>((resolve, reject) => {
        const finish = () => {
            listeners.delete(finish);
            context.signal?.removeEventListener('abort', finish);
            if (context.signal?.aborted) reject(context.signal.reason);
            else if (failure !== undefined) reject(failure);
            else resolve();
        };
        listeners.add(finish);
        context.signal?.addEventListener('abort', finish, { once: true });
        if (context.signal?.aborted || failure !== undefined || observed !== revision) finish();
    });
    const cancellation: ActionOperationCancellation | undefined = context.operationCancellation;
    const stopCancellation = cancellation?.onRequest(fresh => {
        // Internal retirement has no newly admitted requester and spends no
        // protected transport. Public cancellation awaits this cleanup.
        if (fresh) return host.cancel(fresh);
        return undefined;
    });
    try {
        context.operationOwnerUpdate?.update({ cancellation: 'supported' });
        context.operationAcceptance?.accept(request.result);
        for (;;) {
            await waitForChange();
            observed = revision;
            await host.assertCurrent();
            const current = await host.readEnvironment();
            if (current.environment.id !== request.input.environmentId
                || !isDeepStrictEqual(current.pendingDeploy, request.input.pendingDeploy)) return refuse('cancelled');
            if (!current.pendingDeploy) return refuse('cancelled');
            const receipts = DeploymentReceiptListResultV1Schema.parse(await host.readReceipts());
            if (!receipts.ok) return refuse(receipts.error);
            if (receipts.items.length > 0) continue;
            await host.assertCurrent();
            // Release this observation before the ordinary preparation/executor
            // re-enters. A racing new busy receipt is owned by that same path.
            stopCancellation?.();
            await observation.dispose();
            return await host.resume();
        }
    } finally { stopCancellation?.(); await observation.dispose(); }
}

/** Consume the follower's committed result without starting another provider read. */
export async function waitForPlatformDeploymentReceiptForHost(request: Readonly<{
    serverId: string; initial: Extract<DeploymentReceiptResultV1, { ok: true; deploymentId: string }>;
    context: ActionExecutorContext; events: StablePluginEventsBroker;
}>, host: Readonly<{
    readReceipt(): Promise<DeploymentReceiptHeaderV1>;
    readEnvironmentRevision(): Promise<number>;
}>) {
    const { context, initial, serverId } = request;
    const { environmentId, deploymentId } = initial;
    const acceptance = context.operationAcceptance;
    if (!acceptance) return refuse('action_operation_unavailable');

    let changed = Promise.withResolvers<DeploymentReceiptCompletionV1 | undefined>();
    const isCurrent = () => context.signal?.aborted !== true;
    const receipt = request.events.subscribeHost({
        target: { eventId: HAPPIER_DEPLOYMENT_RECEIPT_INVALIDATED_HOST_EVENT_ID_V1, scope: { kind: 'account' } },
        isCurrent,
        listener: event => {
            if (event.eventId !== HAPPIER_DEPLOYMENT_RECEIPT_INVALIDATED_HOST_EVENT_ID_V1) return;
            const address = event.payload;
            if (address.serverId === serverId && address.environmentId === environmentId
                && address.deploymentId === deploymentId && address.completion !== null) changed.resolve(address.completion);
        },
    });
    const reconnect = request.events.subscribeHost({
        target: { eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1, scope: { kind: 'account' } },
        isCurrent,
        listener: event => {
            if (event.eventId === HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1
                && event.payload.reason === 'reconnect') changed.resolve(undefined);
        },
    });
    try {
        acceptance.accept({ ok: true, kind: 'pending', environmentId, revision: initial.revision,
            actionOperationId: acceptance.operationId });
        const readCompletion = async () => {
            context.signal?.throwIfAborted();
            const current = await host.readReceipt();
            return projectDeploymentReceiptCompletionV1(initial.state, {
                state: current.state,
                settledAt: current.settledAtMs === undefined ? null : new Date(current.settledAtMs),
                cancelRequestedAt: current.cancelRequestedAtMs === undefined ? null : new Date(current.cancelRequestedAtMs),
            }, current.revision, current.startedAtMs ?? current.requestedAtMs);
        };
        // Subscriptions precede the catch-up read so early settlement is retained.
        let completion = await readCompletion();
        while (!completion) {
            const delivered = await raceWithAbort(changed.promise, context.signal);
            changed = Promise.withResolvers<DeploymentReceiptCompletionV1 | undefined>();
            // A committed wake carries the Receipt owner's result. Reconnects
            // and old senders only invalidate and need one exact read.
            completion = delivered ?? await readCompletion();
        }
        const terminal = { ...initial, deploymentRevision: completion.revision, state: completion.state };
        // Refresh the Environment revision when available. The Receipt already settled independently.
        try {
            return { ...terminal, revision: await host.readEnvironmentRevision() };
        } catch {
            return terminal;
        }
    } finally {
        receipt.dispose();
        reconnect.dispose();
    }
}

/** A reload loses runner custody, not the pending owner's admitted intent.
 * Home resolves its captured Address and delegates to the same exact-CAS writer. */
export async function cancelPendingDeploymentForHost(request: Readonly<{
    scope: Readonly<{ accountId: string; machineId: string }>;
    operationId: string;
    custody: Readonly<{ serverId: string; installationId: string }>;
    context: ActionOperationCancellationContext;
}>) {
    const { context, scope } = request;
    const authorization = context.callerInputAuthorization;
    const http = authorization?.requesterHttpProjection;
    if (!authorization || !http) return null;
    const binding = authorization.binding;
    const denied = (): never => { throw new RpcError('action_forbidden', 'action_forbidden'); };
    if (binding.accountId !== scope.accountId || binding.machineId !== scope.machineId
        || binding.installationId !== request.custody.installationId
        || !await isServerProfileHomeIdentity(request.custody.serverId, binding.serverIdentityId)) return denied();
    const body = ActionOperationAddressV1Schema.parse({ serverId: binding.serverIdentityId,
        machineId: scope.machineId, operationId: request.operationId });
    const path = DEPLOYMENT_PENDING_OPERATION_CANCEL_HTTP_PATH_V1;
    const headers = await http.createRequestHeaders({ method: 'POST', path, body,
        effectActionId: 'action.operations.cancel', signal: context.signal });
    if (!headers) return denied();
    const response = await axios.request<unknown>({ method: 'POST', url: `${http.serverHttpBaseUrl}${path}`,
        headers, data: body, signal: context.signal, validateStatus: () => true });
    const failure = DeploymentActionFailureV1Schema.safeParse(response.data);
    if (failure.success) throw new RpcError(failure.data.error, failure.data.error);
    if (response.status < 200 || response.status >= 300) throw Object.assign(new RpcError('invalid_action_output', 'invalid_action_output'), { cause: deploymentOutputValidationFailure('deployments.pending.cancel', undefined) });
    return ActionOperationCancelV1ResponseSchema.parse(response.data);
}
