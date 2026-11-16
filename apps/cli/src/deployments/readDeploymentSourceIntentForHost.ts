import { rethrowDeploymentSourceAcquisitionFailure } from './deploymentFailure';
import { refuseDeploymentAuthorization } from './deploymentAuthorizationFailure';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readHostAdmittedReviewedChildV1, readHostReviewedChildOriginalAuthorizationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1, type DeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';
import type { DeploymentEnvironmentDetailV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentSourceAdmissionFailureV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentSourceCheckoutRequiredV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { readProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';
import { fetchWorkspaceCommitRef, resolveWorkspaceCommitRef } from '@/scm/workspace/workspaceCommitExport';
import { admitDeploymentSourceIntent } from './deploymentSourceAdmission';
import { isHostRequesterUnrestrictedOwner, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export type DeploymentSourceRequesterIdentityResolver = (context: ActionExecutorContext) => Promise<HostRequesterExecutionIdentity>;

type DeploymentSourceRequest = Readonly<{
    environment: Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>;
    sourceIntent?: DeploymentSourceIntentV1;
    sha?: string;
    context: ActionExecutorContext;
    actionId?: 'deployments.deploy' | 'deployments.promote' | 'deployments.rollback' | 'deployments.environments.update' | DeploymentBackupActionIdV1;
    /** Opened and selected by the native retained receipt owner for Add or restoration. */
    retainedSourceIntent?: DeploymentSourceIntentV1;
    /** Native materialization needs a checkout; provider Git integration does not. */
    requireWorkspace?: boolean;
}>;
export type DeploymentSourceIntentForHost = Readonly<{
    sourceIntent: DeploymentSourceIntentV1;
    workspace?: WorkspaceRefV1;
    sourceRepository?: ProjectSourceRepositorySelectorV1;
    assertSourceCurrent(): Promise<void>;
}>;
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };

/** Exact source selection shared by native materialization and provider Git deployment. */
export async function readDeploymentSourceIntentForHost(input: Readonly<{
    request: DeploymentSourceRequest;
    host: Readonly<{
        credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
        resolveRequesterIdentity: DeploymentSourceRequesterIdentityResolver;
        resolveRepositoryRef?(repository: ProjectSourceRepositorySelectorV1, ref: string, context: ActionExecutorContext): Promise<string>;
        signal?: AbortSignal; assertAuthority(): Promise<void>;
    }>;
}>): Promise<DeploymentSourceIntentForHost> {
    const { request, host } = input;
    const { environment } = request;
    const signal = request.context.signal && host.signal ? AbortSignal.any([request.context.signal, host.signal])
        : request.context.signal ?? host.signal;
    signal?.throwIfAborted();
    if (request.sha && (request.sourceIntent || environment.content.definition.kind !== 'repository')) return refuse('deployment_invalid');
    const selected = request.retainedSourceIntent ?? request.sourceIntent;
    let intent = selected ? structuredClone(selected) : undefined;
    if (intent && request.actionId !== DEPLOYMENT_ROLLBACK_ACTION_ID_V1 && !request.retainedSourceIntent) admitDeploymentSourceIntent(environment, intent);
    const repository = (intent ?? environment.content.definition).kind === 'repository';
    const needsWorkspace = repository && request.requireWorkspace !== false;
    if (needsWorkspace) {
        const requester = await host.resolveRequesterIdentity(request.context);
        if (!isHostRequesterUnrestrictedOwner(requester)) {
            const details: DeploymentSourceAdmissionFailureV1 = requester.kind === 'unknown'
                ? { phase: 'deployment_source_admission', reason: requester.reason,
                    requiredFact: 'verified_root_requester', remedy: 'retry_original_request' }
                : { phase: 'deployment_source_admission', reason: 'requester_workspace_requires_owner',
                    requiredFact: 'unrestricted_workspace_requester', remedy: 'run_from_authorized_host' };
            throw new PluginError({ code: 'agent_isolation_unavailable', retryable: false, details,
                ...(requester.kind === 'unknown' ? { remediation: { kind: 'retry' } } : {}),
                failureCause: projectActionFailureCauseV1(new Error('agent_isolation_unavailable'),
                    `deployment.source.admission.${details.reason}`) });
        }
    }
    const sourceId = intent?.kind === 'repository' ? intent.projectSourceId : environment.environment.projectSourceId;
    let sourceRevision = intent?.kind === 'repository' ? intent.sourceRevision : undefined;
    let sourceRepository: ProjectSourceRepositorySelectorV1 | undefined;
    if (intent?.kind === 'repository' && intent.projectSourceId !== environment.environment.projectSourceId) return refuse('target_mismatch');
    const assertAuthority = async () => {
        signal?.throwIfAborted();
        await host.assertAuthority();
        signal?.throwIfAborted();
    };
    const authorization = request.context.externalActionExecutionAuthorization;
    const childActionId = readRequesterAccountActionContext(authorization)?.deploymentChild?.actionId;
    const sourceActions = createCliProjectSourceActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: serverId => serverId === host.serverId ? null : { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' },
        async resolveRequestHeaders(context, effectActionId, transport) {
            await assertAuthority();
            // Source selection is the deployment parent's preparation read, not the plugin child's effect.
            const authorization = readHostReviewedChildOriginalAuthorizationV1(context) ?? context.externalActionExecutionAuthorization;
            const projection = authorization?.requesterHttpProjection;
            if (projection) return await projection.createRequestHeaders({ ...transport, effectActionId: childActionId ?? effectActionId, signal });
            if (context.externalActionCredential || context.rpcSessionAuthorization) return null;
            return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${host.credentials.token}` };
        },
    });
    const readSource = async () => {
        await assertAuthority();
        if (!repository) return;
        if (!sourceActions.projectSourcesRead) return refuse('deployment_source_unavailable');
        const result = await sourceActions.projectSourcesRead({ serverId: host.serverId, sourceId }, request.context);
        if (!result.ok) {
            if ('errorCode' in result && result.errorCode === 'action_forbidden') return refuseDeploymentAuthorization('home_project_source_read_forbidden', result);
            return refuse('errorCode' in result ? result.errorCode : result.error);
        }
        if (result.source.id !== sourceId) return refuse('target_mismatch');
        if (sourceRevision !== undefined && result.source.revision !== sourceRevision) return refuse('deployment_conflict');
        if (!result.source.repository) return refuse('deployment_source_unavailable');
        sourceRepository = result.source.repository;
        sourceRevision ??= result.source.revision;
    };
    await readSource();
    const rows = needsWorkspace ? await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => readProjectAccountRowsObservation({
        ...(authorization ? { authorization, effectActionId: readHostAdmittedReviewedChildV1(request.context)?.actionId
            ?? childActionId ?? authorization.binding.actionId } : { credentials: host.credentials }),
        serverId: host.serverId, signal, assertCurrentAuthority: assertAuthority,
        selection: { kinds: ['workspace-ref'], serverId: host.serverId },
    })) : undefined;
    const workspace = repository ? rows?.snapshot.workspaceRefs.find(ref => ref.serverId === host.serverId
        && ref.machineId === host.machineId && ref.source?.sourceId === sourceId && ref.source.revision === sourceRevision) : undefined;
    if (needsWorkspace && !workspace) {
        if (sourceRevision === undefined || !sourceRepository) return refuse('deployment_source_unavailable');
        // The person or agent opens this Source's checkout through projects.open (its own review), then deploys again.
        const code = 'deployment_source_checkout_required';
        const failure = { ok: false as const, errorCode: code, error: code, details: projectDeploymentSourceCheckoutRequiredV1({
            serverId: host.serverId, machineId: host.machineId,
            source: { id: sourceId, revision: sourceRevision, selector: sourceRepository } }) };
        throw Object.assign(createActionExecuteFailureError(failure), { cause: failure });
    }
    if (!intent) {
        const definition = environment.content.definition;
        if (definition.kind === 'stored') intent = structuredClone(definition);
        else {
            if (sourceRevision === undefined) return refuse('deployment_source_unavailable');
            let sha = request.sha;
            if (!sha) {
                if (workspace) {
                    try {
                        sha = await resolveWorkspaceCommitRef({ sourcePath: workspace.rootPath, ref: definition.ref, signal });
                    } catch (error) {
                        if (!(error instanceof Error && 'code' in error && error.code === SCM_OPERATION_ERROR_CODES.NOT_FOUND)
                            || !sourceRepository || !host.resolveRepositoryRef) return rethrowDeploymentSourceAcquisitionFailure(error);
                        sha = await host.resolveRepositoryRef(sourceRepository, definition.ref, request.context);
                        const cloneUrl = sourceRepository.protocol === 'ssh'
                            ? sourceRepository.repository.sshUrl : sourceRepository.repository.cloneUrl;
                        if (!cloneUrl) return refuse('deployment_source_unavailable');
                        await fetchWorkspaceCommitRef({ sourcePath: workspace.rootPath, cloneUrl,
                            ref: definition.ref.startsWith('refs/') ? definition.ref : `refs/heads/${definition.ref}`,
                            expectedCommitSha: sha, signal }).catch(rethrowDeploymentSourceAcquisitionFailure);
                    }
                }
                else if (sourceRepository && host.resolveRepositoryRef) {
                    sha = await host.resolveRepositoryRef(sourceRepository, definition.ref, request.context);
                } else return refuse('deployment_source_unavailable');
            }
            intent = { kind: 'repository', projectSourceId: sourceId, sourceRevision,
                ...(definition.compose === undefined ? {} : { compose: definition.compose }), sha };
        }
    }
    const assertSourceCurrent = async () => {
        await readSource();
        if (rows && !await rows.isCurrent()) return refuse('deployment_conflict');
        await assertAuthority();
    };
    return { sourceIntent: intent, ...(workspace ? { workspace } : {}), ...(sourceRepository ? { sourceRepository } : {}), assertSourceCurrent };
}
