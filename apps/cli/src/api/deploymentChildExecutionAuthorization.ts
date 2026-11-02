import { projectDeploymentChildRoutingV1 } from '@happier-dev/protocol';
import type { ActionExecutorContext, DeploymentChildRpcV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncSourceExecutionV1 } from '@happier-dev/protocol/socketRpc';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isReviewedDeploymentChild, readReviewedDeploymentDeployInput } from './externalActionExecutionAuthorization';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { assertReviewedDeploymentSource } from '@/deployments/reviewedSource';

type NativeDeploymentChild = Extract<DeploymentChildRpcV1, { kind: 'build' | 'member' }>;

/** The signed current receipt pins this Artifact id; its current head retains
 * the primary source even when archive restoration selects a different release. */
export async function assertReviewedDeploymentArchiveSourceForHost(input: Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown;
    contentArtifactId: string; signal?: AbortSignal;
}>): Promise<void> {
    const refuse = (code = 'action_forbidden'): never => { throw Object.assign(new Error(code), { code }); };
    if (input.authorization.binding.actionId !== 'deployments.deploy') return;
    const root = await readReviewedDeploymentDeployInput(input);
    if (!root) return refuse();
    // Explicit roots already pin the exact prepared Artifact. Legacy semantic
    // roots do not promise an event SHA and retain their existing admission.
    if ('contentArtifactId' in root || root.sha === undefined && root.sourceIntent === undefined) return;
    const requester = readRequesterAccountActionContext(input.authorization);
    const projection = input.authorization.requesterHttpProjection;
    if (!requester || !projection) return refuse();
    input.signal?.throwIfAborted();
    // Only this finite byte-admission path needs content. Ordinary operation
    // identity/observation stays structural and never opens a private Artifact.
    const [{ createCredentialedAccountArtifactStore }, { runWithServerHttpBaseUrl },
        { readDeploymentReceiptArtifactV1 }, { buildCurrentAccountStoredContentCompatibilityHttpHeaders }] = await Promise.all([
        import('@/api/artifacts/accountArtifactStore'), import('@/api/client/serverHttpBaseUrl'),
        import('@happier-dev/deployment-protocol'), import('@/api/clientCompatibility/cliClientCompatibility'),
    ]);
    const store = createCredentialedAccountArtifactStore(requester.credentials);
    const artifact = await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => store.read(input.contentArtifactId, {
        signal: input.signal, prepareRecipients: false, includeSharedAudience: false,
        authorizationHeaders: async request => {
            input.signal?.throwIfAborted();
            const headers = await projection.createRequestHeaders({ ...request, effectActionId: 'deployments.deploy',
                ...(input.signal ? { signal: input.signal } : {}) });
            if (!headers) return refuse();
            return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers };
        },
    }));
    input.signal?.throwIfAborted();
    if (!artifact) return refuse('deployment_content_unavailable');
    const opened = readDeploymentReceiptArtifactV1({ contentArtifactId: input.contentArtifactId,
        contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion }, artifact);
    if (!opened.ok) return refuse(opened.error);
    assertReviewedDeploymentSource({ intent: root, content: opened.content });
}

/** Private installed custody for the existing finite archive driver, never a path or byte grant. */
export async function assertDeploymentArchiveChildCurrentForHost(input: Readonly<{
    context: ActionExecutorContext; machineId: string; installationId: string;
}>): Promise<Readonly<{ job: NativeDeploymentChild; execution: WorkspaceSyncSourceExecutionV1 }>> {
    const refuse = (): never => { throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' }); };
    input.context.signal?.throwIfAborted();
    const authorization = input.context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    const execution = requester?.deploymentChildExecution;
    const job = requester?.deploymentChild;
    if (!authorization || !requester || !execution || !job || (job.kind !== 'build' && job.kind !== 'member')
        || job.kind === 'member' && job.phase === 'cleanup'
        || job.machineId !== input.machineId || job.installationId !== input.installationId
        || execution.externalActionExecution.authorization.token !== authorization.token
        || !sameStrictJsonValue(execution.externalActionExecution.authorization.binding, authorization.binding)
        || !sameStrictJsonValue(execution.externalActionExecution.deploymentChildRouting, projectDeploymentChildRoutingV1(job))
        || !await isReviewedDeploymentChild({ authorization, envelope: execution.originalActionEnvelope,
            actionId: job.actionId, machineId: job.machineId, params: job, signal: input.context.signal })) return refuse();
    input.context.signal?.throwIfAborted();
    return { job, execution };
}
