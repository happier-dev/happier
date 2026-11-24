import type { ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { projectRuntimeAccountRowsInput, type ProjectRuntimeAccountAccess } from '@/workspaces/projectAccountRows';
import { readProjectRuntimeAdmissionRefusal, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectSetupAcceptedWorkspace, type ProjectSetupAcceptedAssociation } from './projectSetupAcceptedWorkspace';
import { inspectProjectSetup, type ProjectSetupInspection } from './projectSetupPreparation';
import { resolveProjectRequesterSecretInputs } from './projectSetupRequesterInputs';
import { readProjectEffectiveDefinition, type PendingProjectSharedSetupInput } from './projectEffectiveDefinition';
import { readAcceptedProjectSetupForProject, readPublishedProjectSetup, type PublishedProjectSetupRead } from './projectAcceptedSetup';
import { compareProjectSharedSetupV1, reviewProjectSharedSetupChangeV1, type ProjectSharedSetupChangeV1 } from '@happier-dev/protocol/projects/projectSetupChangeV1';
import type { ProjectSetupReadV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectManifestInspectionSnapshot } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';
import { projectSetupInspectionFailure } from './projectSetupInspectionFailure';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { resolvePrivateProjectCheckoutRoot } from '@/workspaces/activation/privateProjectCheckout';
import { readProjectAsMember } from '@/workspaces/activation/memberProjectInspection';
import { createProjectDotenvPreparation } from './projectDotenv';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveHostRequesterAgentPlacementForHost } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

/** The requester Account supplies the accepted checkout: only a WorkspaceRef in the requester's
 * own Account rows is read. `placement: 'daemon'` is the placement owner's decision for this
 * requester's own Project (isolation off); otherwise the native member invocation reads it. */
export async function withProjectMemberWorkspaceSource<T>(input: Readonly<{
    runtime: ProjectRuntimeAccountAccess & Pick<ProjectFiniteActionRuntime, 'serverId' | 'serverHttpBaseUrl' | 'requesterIdentity' | 'agentIsolation'> & Readonly<{
        nativeOperationRuntime?: Pick<NonNullable<ProjectFiniteActionRuntime['nativeOperationRuntime']>, 'prepareNativeOperation'>;
    }>;
    ingress: RpcHandlerContext; workspace: ProjectDefinitionWorkspace;
    context: ActionExecutorContext; read(root: string): Promise<T>;
    placement?: 'daemon';
}>): Promise<T> {
    const unavailable = (code = 'project_workspace_unavailable'): never => { throw Object.assign(new Error(code), { code }); };
    const identity = input.runtime.requesterIdentity;
    const nativeRuntime = input.runtime.nativeOperationRuntime;
    if (identity?.kind !== 'isolated' || !nativeRuntime && input.placement !== 'daemon') return unavailable('agent_isolation_unavailable');
    const signal = input.context.signal ? AbortSignal.any([input.ingress.signal, input.context.signal]) : input.ingress.signal;
    const accepted = await resolveProjectSetupAcceptedWorkspace({ address: input.workspace,
        ...projectRuntimeAccountRowsInput(input.runtime), serverId: input.runtime.serverId,
        serverHttpBaseUrl: input.runtime.serverHttpBaseUrl, signal, allowUnassociated: true, allowProjectless: true });
    if (!accepted || accepted.workspace.machineId !== identity.requester.machineId) return unavailable();
    if (input.placement === 'daemon') {
        if (!canonicalAbsolutePathsEqual(accepted.workspace.rootPath, input.workspace.rootPath)) return unavailable();
        return await input.read(accepted.workspace.rootPath);
    }
    if (!nativeRuntime) return unavailable('agent_isolation_unavailable');
    const material = Object.freeze({ materializationKey: input.context.actionRequestId ?? input.ingress.transportRequestId ?? accepted.workspace.id,
        environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
    const native = await nativeRuntime.prepareNativeOperation({ requesterIdentity: identity, ingress: input.ingress,
        signal, readMaterial: () => material, allowMemberPreparation: false });
    try {
        if (!native.memberIdentity || accepted.workspace.machineId !== identity.requester.machineId
            || !canonicalAbsolutePathsEqual(accepted.workspace.rootPath,
                resolvePrivateProjectCheckoutRoot(native.memberIdentity.workspaceRoot, accepted.workspace.id))) return unavailable();
        return await readProjectAsMember({ agentIsolation: native.agentIsolation, requesterIdentity: identity,
            workspaceRoot: native.memberIdentity.workspaceRoot, root: accepted.workspace.rootPath, signal,
            read: () => input.read(accepted.workspace.rootPath) });
    } finally { await native.dispose(); }
}


/** A lazy dotenv snapshot owns its member reader until the complete file family settles. */
export function createProjectRuntimeDotenvPreparation(input: Readonly<Pick<Parameters<typeof withProjectMemberWorkspaceSource>[0],
    'runtime' | 'ingress' | 'context'> & { workspace: ProjectDefinitionWorkspace | WorkspaceRefV1; originalEnvironment: ProcessEnvInput }>) {
    const workspace = 'id' in input.workspace ? workspaceAddressFromRefV1(input.workspace) : input.workspace;
    return createProjectDotenvPreparation(workspace.rootPath, input.originalEnvironment,
        input.runtime.requesterIdentity?.kind === 'isolated' && resolveHostRequesterAgentPlacementForHost({
            identity: input.runtime.requesterIdentity, snapshot: input.runtime.agentIsolation?.read() }) === 'member'
            ? read => withProjectMemberWorkspaceSource({ ...input, workspace, read }) : undefined);
}

/** Demand-only definition read under the same admitted requester and accepted checkout as setup. */
export async function readProjectEffectiveDefinitionFromRuntime(input: Readonly<{
    runtime: ProjectFiniteActionRuntime; ingress: RpcHandlerContext; workspace: ProjectDefinitionWorkspace;
    context: ActionExecutorContext; repositorySnapshot?: ProjectManifestInspectionSnapshot;
    reviewSharedSetup?: Readonly<{ sourceId: string }>;
}>) {
    const { runtime, ingress, workspace } = input;
    const signal = input.context.signal ? AbortSignal.any([ingress.signal, input.context.signal]) : ingress.signal;
    const refusal = await readProjectRuntimeAdmissionRefusal(runtime, { ...ingress, signal });
    if (refusal) throw Object.assign(new Error(refusal.errorCode), { code: refusal.errorCode });
    const association = await resolveProjectSetupAcceptedWorkspace({ address: workspace,
        ...projectRuntimeAccountRowsInput(runtime), serverId: workspace.serverId,
        serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
    const account = projectRuntimeAccountRowsInput(runtime);
    const acceptedSetup = await readAcceptedProjectSetupForProject({ account, project: association.project,
        serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
    if (acceptedSetup.kind === 'unavailable') throw Object.assign(new Error(acceptedSetup.code), { code: acceptedSetup.code });
    const sourceId = input.reviewSharedSetup?.sourceId ?? association.workspace.source?.sourceId;
    let publishedSetup: PublishedProjectSetupRead | undefined;
    let publishedSetupError: unknown;
    if (sourceId) {
        try {
            publishedSetup = await readPublishedProjectSetup({ account, serverId: workspace.serverId, sourceId,
                serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
        } catch (error) {
            signal.throwIfAborted();
            publishedSetupError = error;
        }
    }
    const comparison = publishedSetup ? compareProjectSharedSetupV1({ acceptedSetup, publication: publishedSetup.publication }) : undefined;
    let pendingSharedSetup: PendingProjectSharedSetupInput | undefined;
    if (publishedSetup && association.workspace.source?.sourceId === sourceId && comparison?.kind === 'changed') {
        pendingSharedSetup = { source: publishedSetup.source,
            setup: publishedSetup.publication, manifest: publishedSetup.publication.manifest };
    }
    const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath,
        account, project: association.project, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal,
        repositorySnapshot: input.repositorySnapshot, acceptedSetup, ...(pendingSharedSetup ? { pendingSharedSetup } : {}) });
    let sharedSetupChange: ProjectSharedSetupChangeV1 | undefined;
    if (input.reviewSharedSetup) {
        try {
            if (publishedSetupError || !publishedSetup) throw publishedSetupError
                ?? Object.assign(new Error('project_setup_review_unavailable'), { code: 'project_setup_review_unavailable' });
            const publication = publishedSetup.publication;
            const change = reviewProjectSharedSetupChangeV1({ repositoryManifest: definition.snapshot.document?.status === 'valid'
                ? definition.snapshot.document.manifest : null,
                acceptedSetup: definition.acceptedSetup, publication, comparison });
            if (change.kind === 'changed') {
                const after = await inspectSelectedProjectSetup({ ...input, reviewSetupConsent: true }, {
                    association, manifest: change.after.effectiveManifest,
                    acceptedSetup: { ...definition.acceptedSetup, acceptedSharedSetup: publication },
                });
                sharedSetupChange = { ...change, setupReadiness: after.setupReadiness,
                    ...(after.setupReview ? { setupReview: after.setupReview } : {}) };
            } else sharedSetupChange = change;
        } catch (error) {
            signal.throwIfAborted();
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'project_setup_review_unavailable';
            sharedSetupChange = { kind: 'upstreamUnavailable', code,
                failureCause: projectActionFailureCauseV1(error, 'projects.inspect') };
        }
    }
    return { ...definition, association, ...(sharedSetupChange ? { sharedSetupChange } : {}) };
}

type ProjectSetupRuntimeInspection = Readonly<{
    runtime: ProjectFiniteActionRuntime; ingress: RpcHandlerContext; workspace: ProjectDefinitionWorkspace; context: ActionExecutorContext;
    reviewSetupConsent?: true;
}>;

/** Passive review uses the same captured requester, current target, and native owner as execution. */
export function inspectProjectSetupFromRuntime(input: ProjectSetupRuntimeInspection): Promise<ProjectSetupInspection> {
    return inspectSelectedProjectSetup(input);
}

async function inspectSelectedProjectSetup(input: ProjectSetupRuntimeInspection, selected?: Readonly<{
    association: ProjectSetupAcceptedAssociation; manifest: ProjectManifestV1 | null; acceptedSetup: ProjectSetupReadV1;
}>): Promise<ProjectSetupInspection> {
    const { runtime: authorityRuntime, ingress } = input;
    const runtime = { ...authorityRuntime, serverId: input.workspace.serverId };
    const signal = input.context.signal ? AbortSignal.any([ingress.signal, input.context.signal]) : ingress.signal;
    const phase = async <T>(name: string, read: () => T | Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        let status: 'completed' | 'failed' = 'failed';
        try { const result = await read(); status = 'completed'; return result; }
        finally { logger.debug('[ProjectSetup] inspection phase', { phase: name, status,
            requestId: input.context.actionRequestId ?? ingress.transportRequestId,
            durationMs: Math.round(performance.now() - startedAt) }); }
    };
    let releaseRequester: (() => Promise<void>) | undefined;
    const unknown = (code: string): ProjectSetupInspection => ({ setupReadiness: { kind: 'unknown', code } });
    try {
        if (!selected) {
            if (!await isServerProfileHomeIdentity(authorityRuntime.serverId, input.workspace.serverId) || input.workspace.machineId !== runtime.machineId
                || ingress.machineAdmission && ingress.machineAdmission.machineId !== runtime.machineId) return unknown('target_mismatch');
            const refused = await phase('requester', () => readProjectRuntimeAdmissionRefusal(authorityRuntime, { ...ingress, signal }));
            if (refused) return unknown(refused.errorCode);
        }
        releaseRequester = readRequesterAccountActionContext(runtime.accountAuthorization)?.retain();
        const association = selected?.association ?? await phase('workspace', () => resolveProjectSetupAcceptedWorkspace({ address: input.workspace,
            ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal }));
        const { manifest, acceptedSetup } = selected ?? await phase('manifest', async () => {
            const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath,
                account: projectRuntimeAccountRowsInput(runtime), project: association.project,
                serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            return { manifest: definition.effectiveDefinition.effectiveManifest, acceptedSetup: definition.acceptedSetup };
        });
        const { environmentBindings, secretEnvironment } = await phase('requester_environment', () => resolveProjectRequesterSecretInputs(runtime, {
            project: association.project, requirements: manifest?.environmentVariables ?? [],
        }, signal));
        signal.throwIfAborted();
        const inspection = await phase('review', () => inspectProjectSetup({ workspace: association.workspace, projectAssociation: association,
            acceptedSetup,
            requesterIdentity: runtime.requesterIdentity,
            requester: { ...projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl },
            purpose: 'setup', approvalContext: input.context,
            platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform,
                arch: runtime.arch ?? process.arch }, nativeIo: runtime.nativeIo, signal,
            ...(environmentBindings ? { environmentBindings } : {}),
            ...(secretEnvironment ? { secretEnvironment } : {}), ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}), ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}) },
            input.reviewSetupConsent ? { reviewConsent: true } : undefined));
        signal.throwIfAborted();
        return inspection;
    } catch (error) {
        return projectSetupInspectionFailure(error, signal);
    } finally {
        await releaseRequester?.();
    }
}
