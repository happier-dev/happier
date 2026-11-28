import { rethrowDeploymentSourceAcquisitionFailure } from './deploymentFailure';
import { refuseDeploymentAuthorization } from './deploymentAuthorizationFailure';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readHostAdmittedReviewedChildV1, readHostReviewedChildOriginalAuthorizationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1, type DeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { suggestProjectOpenCloneDestinationV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceRepositorySelectorV1, ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { isManagedWorkspaceRefV2, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';
import { ScmCommitOidSchema } from '@happier-dev/protocol/scm/commitPublication';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { DeploymentTargetRepositoryAccessV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import type { DeploymentEnvironmentDetailV1, DeploymentSourceIntentV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentSourceAdmissionFailureV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentSourceCheckoutRequiredV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { projectDeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { readProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';
import { fetchWorkspaceCommitRef, requireWorkspaceCommitRepository, resolveWorkspaceCommitRef } from '@/scm/workspace/workspaceCommitExport';
import { runScmCommand } from '@/scm/runtime';
import { admitDeploymentSourceIntent } from './deploymentSourceAdmission';
import { captureDeploymentFolderSourceForHost } from './captureDeploymentFolderSourceForHost';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { canExecuteRequesterWorkspaceOnDaemonForHost, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export type DeploymentSourceRequesterIdentityResolver = (context: ActionExecutorContext) => Promise<
    HostRequesterExecutionIdentity & Readonly<{ canExecuteWorkspaceOnDaemon?: boolean }>
>;

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
    /** The materialization owner takes custody of the admitted snapshot. */
    retainFolderExport?: true;
    /** The selected target's retained repository observation. */
    gitRepository?: Readonly<{ access?: DeploymentTargetRepositoryAccessV1 }>;
    /** The selected Git target requires a clean checkout and a published commit on a declared forge. */
    publishedGitProviders?: readonly string[];
}>;
export type DeploymentSourceIntentForHost = Readonly<{
    sourceIntent: DeploymentSourceIntentV1;
    workspace?: WorkspaceRefV1;
    sourceRepository?: ProjectSourceRepositorySelectorV1;
    folderExport?: Awaited<ReturnType<typeof captureDeploymentFolderSourceForHost>>['captured'];
    assertSourceCurrent(): Promise<void>;
}>;
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };

/** Exact source selection shared by native materialization and provider Git deployment. */
type DeploymentSourceReadInput = Readonly<{
    request: DeploymentSourceRequest;
    host: Readonly<{
        credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
        resolveRequesterIdentity: DeploymentSourceRequesterIdentityResolver;
        resolveRepositoryRef?(repository: ProjectSourceRepositorySelectorV1, ref: string, context: ActionExecutorContext): Promise<string>;
        signal?: AbortSignal; assertAuthority(): Promise<void>;
    }>;
}>;

async function requireWorkspaceRequester(context: ActionExecutorContext, resolveRequesterIdentity: DeploymentSourceRequesterIdentityResolver) {
    const requester = await resolveRequesterIdentity(context);
    if (requester.canExecuteWorkspaceOnDaemon ?? canExecuteRequesterWorkspaceOnDaemonForHost(requester)) return;
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

type FolderSelection = Parameters<typeof captureDeploymentFolderSourceForHost>[0]['selection'];

function captureOwnedFolder(workspace: WorkspaceRefV1 | undefined, folder: FolderSelection, signal?: AbortSignal) {
    if (!workspace || isManagedWorkspaceRefV2(workspace)) return refuse('deployment_source_unavailable');
    const { kind, workspaceId, includeEnvFiles, compose } = folder;
    return runWithWorkspaceSource(localWorkspaceSource, () => captureDeploymentFolderSourceForHost({ workspace,
        selection: { kind, workspaceId, ...(includeEnvFiles === undefined ? {} : { includeEnvFiles }),
            ...(compose === undefined ? {} : { compose }) },
        signal })).catch(rethrowDeploymentSourceAcquisitionFailure);
}

/** Create previews may open only the authored WorkspaceRef on this Machine. */
export async function previewDeploymentFolderOnHost(folder: FolderSelection, context: ActionExecutorContext,
    host: DeploymentSourceReadInput['host']) {
    await requireWorkspaceRequester(context, host.resolveRequesterIdentity);
    const authorization = context.externalActionExecutionAuthorization;
    const rows = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => readProjectAccountRowsObservation({
        ...(authorization ? { authorization, effectActionId: authorization.binding.actionId } : { credentials: host.credentials }),
        serverId: host.serverId, signal: context.signal, assertCurrentAuthority: host.assertAuthority,
        selection: { key: { kind: 'workspace-ref', serverId: host.serverId, id: folder.workspaceId } },
    }));
    const workspace = rows.snapshot.workspaceRefs.find(ref => ref.id === folder.workspaceId
        && ref.serverId === host.serverId && ref.machineId === host.machineId);
    const captured = await captureOwnedFolder(workspace, folder, context.signal);
    try {
        return projectDeploymentReviewRevisionV1(captured.sourceIntent);
    } finally {
        await captured.captured.dispose();
    }
}

export function readDeploymentSourceIntentForHost(input: DeploymentSourceReadInput & {
    request: { retainFolderExport?: never };
}): Promise<DeploymentSourceIntentForHost & {
    sourceIntent: Exclude<DeploymentSourceIntentV1, { kind: 'folder' }>;
}>;
export function readDeploymentSourceIntentForHost(input: DeploymentSourceReadInput): Promise<DeploymentSourceIntentForHost>;
export async function readDeploymentSourceIntentForHost(input: DeploymentSourceReadInput): Promise<DeploymentSourceIntentForHost> {
    const { request, host } = input;
    const { environment } = request;
    const signal = request.context.signal && host.signal ? AbortSignal.any([request.context.signal, host.signal])
        : request.context.signal ?? host.signal;
    signal?.throwIfAborted();
    if (request.sha && (request.sourceIntent || environment.content.definition.kind !== 'repository')) return refuse('deployment_invalid');
    const selected = request.retainedSourceIntent ?? request.sourceIntent;
    let intent = selected ? structuredClone(selected) : undefined;
    if (intent && request.actionId !== DEPLOYMENT_ROLLBACK_ACTION_ID_V1 && !request.retainedSourceIntent) admitDeploymentSourceIntent(environment, intent);
    const selectedSource = intent ?? environment.content.definition;
    const repository = selectedSource.kind === 'repository';
    const folder = selectedSource.kind === 'folder' ? selectedSource : undefined;
    if (folder && !request.retainFolderExport) return refuse('repository_required');
    const publishedGitProviders = request.publishedGitProviders;
    if (publishedGitProviders && !repository) return refuse('repository_required');
    const needsWorkspace = folder !== undefined || repository && (publishedGitProviders !== undefined || request.requireWorkspace !== false);
    if (needsWorkspace) await requireWorkspaceRequester(request.context, host.resolveRequesterIdentity);
    const sourceId = intent?.kind === 'repository' ? intent.projectSourceId : environment.environment.projectSourceId;
    let sourceRevision = intent?.kind === 'repository' ? intent.sourceRevision : undefined;
    let sourceRepository: ProjectSourceRepositorySelectorV1 | undefined;
    let sourceDefaults: Pick<ProjectSourceV1, 'defaultRef' | 'subdir'> = {};
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
        const { defaultRef, subdir } = result.source;
        sourceDefaults = { ...(defaultRef === undefined ? {} : { defaultRef }), ...(subdir === undefined ? {} : { subdir }) };
    };
    await readSource();
    if (publishedGitProviders && sourceRepository && !publishedGitProviders.includes(sourceRepository.provider.kind)) {
        return refuse('deployment_source_forge_unsupported');
    }
    if (request.gitRepository && repository) {
        const access = request.gitRepository.access;
        const identity = sourceRepository && normalizeScmHostingRepositoryIdentity({
            kind: sourceRepository.provider.kind, deployment: sourceRepository.provider.baseUrl,
            repository: sourceRepository.repository.nameWithOwner,
        });
        if (access?.status !== 'ready' || !sameScmHostingRepositoryIdentity(identity, access.repository)) {
            return refuse('needsGitAccess');
        }
    }
    const rows = needsWorkspace ? await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => readProjectAccountRowsObservation({
        ...(authorization ? { authorization, effectActionId: readHostAdmittedReviewedChildV1(request.context)?.actionId
            ?? childActionId ?? authorization.binding.actionId } : { credentials: host.credentials }),
        serverId: host.serverId, signal, assertCurrentAuthority: assertAuthority,
        selection: { kinds: ['workspace-ref'], serverId: host.serverId },
    })) : undefined;
    const machineCheckouts = rows?.snapshot.workspaceRefs.filter(ref => ref.serverId === host.serverId
        && ref.machineId === host.machineId) ?? [];
    let workspace = folder ? machineCheckouts.find(ref => ref.id === folder.workspaceId) : undefined;
    let folderExport: DeploymentSourceIntentForHost['folderExport'];
    if (folder) {
        // This owned ref addresses this Machine, even when the caller has a Session workspace.
        const captured = await captureOwnedFolder(workspace, folder, signal);
        if (intent?.kind === 'folder' && intent.manifestFingerprint !== captured.sourceIntent.manifestFingerprint) {
            await captured.captured.dispose();
            return refuse('deployment_conflict');
        }
        intent = captured.sourceIntent;
        folderExport = captured.captured;
    }
    const refuseMissingCheckout = (): never => {
        if (sourceRevision === undefined || !sourceRepository) return refuse('deployment_source_unavailable');
        // The person or agent opens this Source's checkout through projects.open (its own review), then deploys again.
        const code = 'deployment_source_checkout_required';
        const destination = suggestProjectOpenCloneDestinationV1({ machineId: host.machineId, homeDir: resolveHomeDirFromEnvironment(),
            name: sourceRepository.repository.nameWithOwner.split('/').pop() ?? '', checkouts: rows?.snapshot.workspaceRefs ?? [] });
        const definition = environment.content.definition;
        const failure = { ok: false as const, errorCode: code, error: code, details: projectDeploymentSourceCheckoutRequiredV1({
            serverId: host.serverId, machineId: host.machineId,
            source: { kind: 'source', id: sourceId, revision: sourceRevision, selector: sourceRepository, ...sourceDefaults },
            ...(definition.kind === 'repository' && definition.ref !== undefined ? { ref: definition.ref } : {}),
            materialization: { kind: 'clone', ...destination } }) };
        throw Object.assign(createActionExecuteFailureError(failure), { cause: failure });
    };
    const definition = environment.content.definition;
    const provenance = environment.content.previewProvenance;
    const previewHead = !intent && !publishedGitProviders && definition.kind === 'repository'
        && sourceRepository && provenance?.repository.kind === 'github'
        && sameScmHostingRepositoryIdentity(provenance.repository, normalizeScmHostingRepositoryIdentity({
            kind: sourceRepository.provider.kind, deployment: sourceRepository.provider.baseUrl,
            repository: sourceRepository.repository.nameWithOwner,
        }))
        ? { number: provenance.pullRequestNumber } : undefined;
    const pullRequestHead = intent?.kind === 'repository' ? intent.pullRequestHead : previewHead;
    let sha = request.sha ?? (previewHead && definition.kind === 'repository' ? ScmCommitOidSchema.safeParse(definition.ref).data : undefined);
    const pinnedSha = intent?.kind === 'repository' ? intent.sha : sha;
    if (repository && needsWorkspace) {
        for (const checkout of machineCheckouts) {
            if (checkout.source?.sourceId !== sourceId || checkout.source.revision !== sourceRevision) continue;
            try {
                if (publishedGitProviders) {
                    const status = await runScmCommand({ bin: 'git', cwd: checkout.rootPath, signal, args: [
                        '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none',
                    ] });
                    signal?.throwIfAborted();
                    if (status.workingDirectoryMissing) continue;
                    if (!status.success) {
                        // Status also fails for an unreadable repository. The SCM owner distinguishes absence.
                        if (!status.executableMissing && !status.timedOut && !status.signal && !status.aborted) {
                            await requireWorkspaceCommitRepository(checkout.rootPath, signal);
                        }
                        return refuse('deployment_source_unavailable');
                    }
                    if (status.stdout.length > 0) return refuse('deployment_source_dirty');
                }
                if (!intent && !sha && definition.kind === 'repository') {
                    try {
                        sha = await resolveWorkspaceCommitRef({ sourcePath: checkout.rootPath, ref: definition.ref, signal });
                    } catch (error) {
                        if (publishedGitProviders || !(error instanceof Error && 'code' in error && error.code === SCM_OPERATION_ERROR_CODES.NOT_FOUND)
                            || !sourceRepository || !host.resolveRepositoryRef) throw error;
                        const resolvedSha = await host.resolveRepositoryRef(sourceRepository, definition.ref, request.context);
                        const cloneUrl = sourceRepository.protocol === 'ssh'
                            ? sourceRepository.repository.sshUrl : sourceRepository.repository.cloneUrl;
                        if (!cloneUrl) return refuse('deployment_source_unavailable');
                        await fetchWorkspaceCommitRef({ sourcePath: checkout.rootPath, cloneUrl,
                            ref: definition.ref.startsWith('refs/') ? definition.ref : `refs/heads/${definition.ref}`,
                            expectedCommitSha: resolvedSha, signal }).catch(rethrowDeploymentSourceAcquisitionFailure);
                        sha = resolvedSha;
                    }
                } else if (pullRequestHead && !publishedGitProviders) {
                    // Materialization fetches the approved exact PR head into this repository.
                    await requireWorkspaceCommitRepository(checkout.rootPath, signal);
                } else if (!publishedGitProviders && pinnedSha) {
                    // Upload must choose a checkout containing the reviewed object.
                    try {
                        const resolved = await resolveWorkspaceCommitRef({ sourcePath: checkout.rootPath, ref: pinnedSha, signal });
                        if (resolved !== pinnedSha) return refuse('deployment_conflict');
                    } catch (error) {
                        if (error instanceof Error && 'code' in error && error.code === SCM_OPERATION_ERROR_CODES.NOT_FOUND) continue;
                        throw error;
                    }
                }
            } catch (error) {
                const cause = error instanceof Error ? error.cause : undefined;
                if (cause instanceof Error && 'errorCode' in cause
                    && (cause.errorCode === SCM_OPERATION_ERROR_CODES.ROOT_NOT_FOUND
                        || cause.errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY)) continue;
                return rethrowDeploymentSourceAcquisitionFailure(error);
            }
            workspace = checkout;
            break;
        }
        if (!workspace) return refuseMissingCheckout();
    }
    if (!intent) {
        if (definition.kind === 'stored') intent = structuredClone(definition);
        else if (definition.kind === 'repository') {
            if (sourceRevision === undefined) return refuse('deployment_source_unavailable');
            if (!sha && sourceRepository && host.resolveRepositoryRef) {
                sha = await host.resolveRepositoryRef(sourceRepository, definition.ref, request.context);
            }
            if (!sha) return refuse('deployment_source_unavailable');
            intent = { kind: 'repository', projectSourceId: sourceId, sourceRevision,
                ...(definition.compose === undefined ? {} : { compose: definition.compose }),
                ...(previewHead ? { pullRequestHead: previewHead } : {}), sha };
        }
    }
    if (!intent) return refuse('deployment_source_unavailable');
    if (publishedGitProviders) {
        if (intent.kind !== 'repository' || definition.kind !== 'repository' || !workspace
            || !sourceRepository || !host.resolveRepositoryRef) return refuse('deployment_source_unavailable');
        const reviewedSha = intent.sha;
        if (definition.ref.startsWith('refs/') && !definition.ref.startsWith('refs/heads/')) {
            return refuse('deployment_source_unpushed');
        }
        const branch = definition.ref.startsWith('refs/heads/') ? definition.ref : `refs/heads/${definition.ref}`;
        const publishedSha = await host.resolveRepositoryRef(sourceRepository, branch, request.context).catch(error => {
            if (error instanceof Error && 'code' in error && error.code === 'github_not_found') {
                return refuse('deployment_source_unpushed');
            }
            throw error;
        });
        signal?.throwIfAborted();
        if (publishedSha !== reviewedSha) {
            // A repository's commit endpoint can resolve objects outside the selected branch.
            const compare = () => runScmCommand({ bin: 'git', cwd: workspace.rootPath, signal,
                args: ['--no-replace-objects', 'merge-base', '--is-ancestor', reviewedSha, publishedSha] });
            let ancestry = await compare();
            signal?.throwIfAborted();
            if (!ancestry.success && ancestry.exitCode !== 1) {
                const cloneUrl = sourceRepository.protocol === 'ssh' ? sourceRepository.repository.sshUrl : sourceRepository.repository.cloneUrl;
                if (!cloneUrl) return refuse('deployment_source_unavailable');
                await fetchWorkspaceCommitRef({ sourcePath: workspace.rootPath, cloneUrl,
                    ref: branch,
                    expectedCommitSha: publishedSha, signal }).catch(rethrowDeploymentSourceAcquisitionFailure);
                ancestry = await compare();
                signal?.throwIfAborted();
            }
            if (!ancestry.success) return refuse(ancestry.exitCode === 1 ? 'deployment_source_unpushed' : 'deployment_source_unavailable');
        }
    }
    const assertSourceCurrent = async () => {
        await readSource();
        if (rows && !await rows.isCurrent()) return refuse('deployment_conflict');
        await assertAuthority();
    };
    return { sourceIntent: intent, ...(workspace ? { workspace } : {}), ...(sourceRepository ? { sourceRepository } : {}),
        ...(folderExport ? { folderExport } : {}), assertSourceCurrent };
}
