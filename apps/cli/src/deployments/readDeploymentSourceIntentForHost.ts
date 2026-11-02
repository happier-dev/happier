import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { DeploymentEnvironmentDetailV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { readProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';
import { resolveWorkspaceCommitRef } from '@/scm/workspace/workspaceCommitExport';
import { admitDeploymentSourceIntent } from './deploymentSourceAdmission';
import { isHostRequesterUnrestrictedOwner, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export type DeploymentSourceRequesterIdentityResolver = (context: ActionExecutorContext) => Promise<HostRequesterExecutionIdentity>;

type DeploymentSourceRequest = Readonly<{
    environment: DeploymentEnvironmentDetailV1;
    sourceIntent?: DeploymentSourceIntentV1;
    sha?: string;
    context: ActionExecutorContext;
    actionId?: 'deployments.deploy' | 'deployments.promote' | 'deployments.rollback';
    restoration?: boolean;
    /** Native materialization needs a checkout; provider Git integration does not. */
    requireWorkspace?: boolean;
}>;
export type DeploymentSourceIntentForHost = Readonly<{
    sourceIntent: DeploymentSourceIntentV1;
    workspace?: WorkspaceRefV1;
    sourceRepository?: ProjectSourceRepositorySelectorV1;
    assertSourceCurrent(): Promise<void>;
}>;
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Exact source selection shared by native materialization and provider Git deployment. */
export async function readDeploymentSourceIntentForHost(input: Readonly<{
    request: DeploymentSourceRequest;
    host: Readonly<{
        credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
        resolveRequesterIdentity: DeploymentSourceRequesterIdentityResolver;
        signal?: AbortSignal; assertAuthority(): Promise<void>;
    }>;
}>): Promise<DeploymentSourceIntentForHost> {
    const { request, host } = input;
    const { environment } = request;
    const signal = request.context.signal && host.signal ? AbortSignal.any([request.context.signal, host.signal])
        : request.context.signal ?? host.signal;
    signal?.throwIfAborted();
    if (request.sha && (request.sourceIntent || environment.content.definition.kind !== 'repository')) return refuse('deployment_invalid');
    let intent = request.sourceIntent ? structuredClone(request.sourceIntent) : undefined;
    if (intent && request.actionId !== 'deployments.rollback' && !request.restoration) admitDeploymentSourceIntent(environment, intent);
    const repository = (intent ?? environment.content.definition).kind === 'repository';
    const needsWorkspace = repository && (request.requireWorkspace !== false || !intent && !request.sha);
    if (needsWorkspace) {
        const requester = await host.resolveRequesterIdentity(request.context);
        if (!isHostRequesterUnrestrictedOwner(requester)) return refuse('agent_isolation_unavailable');
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
            const authorization = context.externalActionExecutionAuthorization;
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
        if (!result.ok) return refuse('errorCode' in result ? result.errorCode : result.error);
        if (result.source.id !== sourceId) return refuse('target_mismatch');
        if (sourceRevision !== undefined && result.source.revision !== sourceRevision) return refuse('deployment_conflict');
        if (!result.source.repository) return refuse('deployment_source_unavailable');
        sourceRepository = result.source.repository;
        sourceRevision ??= result.source.revision;
    };
    await readSource();
    const rows = needsWorkspace ? await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => readProjectAccountRowsObservation({
        ...(authorization ? { authorization, effectActionId: childActionId ?? authorization.binding.actionId } : { credentials: host.credentials }),
        serverId: host.serverId, signal, assertCurrentAuthority: assertAuthority,
        selection: { kinds: ['workspace-ref'], serverId: host.serverId },
    })) : undefined;
    const workspace = repository ? rows?.snapshot.workspaceRefs.find(ref => ref.serverId === host.serverId
        && ref.machineId === host.machineId && ref.source?.sourceId === sourceId && ref.source.revision === sourceRevision) : undefined;
    if (needsWorkspace && !workspace) return refuse('deployment_source_unavailable');
    if (!intent) {
        const definition = environment.content.definition;
        if (definition.kind === 'stored') intent = structuredClone(definition);
        else {
            if (sourceRevision === undefined) return refuse('deployment_source_unavailable');
            let sha = request.sha;
            if (!sha) {
                if (!workspace) return refuse('deployment_source_unavailable');
                sha = await resolveWorkspaceCommitRef({ sourcePath: workspace.rootPath, ref: definition.ref, signal });
            }
            intent = { kind: 'repository', projectSourceId: sourceId, sourceRevision, compose: definition.compose,
                sha };
        }
    }
    const assertSourceCurrent = async () => {
        await readSource();
        if (rows && !await rows.isCurrent()) return refuse('deployment_conflict');
        await assertAuthority();
    };
    return { sourceIntent: intent, ...(workspace ? { workspace } : {}), ...(sourceRepository ? { sourceRepository } : {}), assertSourceCurrent };
}
