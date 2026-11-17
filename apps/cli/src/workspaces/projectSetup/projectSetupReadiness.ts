import type { ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { readProjectRuntimeAdmissionRefusal, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import { inspectProjectSetup, type ProjectSetupInspection } from './projectSetupPreparation';
import { resolveProjectRequesterSecretInputs } from './projectSetupRequesterInputs';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import { readPublishedProjectSetup } from './projectAcceptedSetup';
import { reviewProjectSharedSetupChangeV1, type ProjectSharedSetupChangeV1 } from '@happier-dev/protocol/projects/projectSetupChangeV1';
import type { ProjectSetupReadV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectManifestInspectionSnapshot } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';
import { projectSetupInspectionFailure } from './projectSetupInspectionFailure';

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
    const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath,
        account: projectRuntimeAccountRowsInput(runtime), project: association.project,
        serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal, repositorySnapshot: input.repositorySnapshot });
    let sharedSetupChange: ProjectSharedSetupChangeV1 | undefined;
    if (input.reviewSharedSetup) {
        try {
            const publication = await readPublishedProjectSetup({ account: projectRuntimeAccountRowsInput(runtime),
                serverId: workspace.serverId, sourceId: input.reviewSharedSetup.sourceId,
                serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            const change = reviewProjectSharedSetupChangeV1({ repositoryManifest: definition.snapshot.document?.status === 'valid'
                ? definition.snapshot.document.manifest : null,
                acceptedSetup: definition.acceptedSetup, publication });
            if (change.kind === 'changed') {
                const after = await inspectProjectSetupFromRuntime({ ...input,
                    acceptedSetup: { ...definition.acceptedSetup, acceptedSharedSetup: publication }, reviewSetupConsent: true });
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

/** Passive review uses the same captured requester, current target, and native owner as execution. */
export async function inspectProjectSetupFromRuntime(input: Readonly<{
    runtime: ProjectFiniteActionRuntime; ingress: RpcHandlerContext; workspace: ProjectDefinitionWorkspace; context: ActionExecutorContext;
    reviewSetupConsent?: true;
    acceptedSetup?: ProjectSetupReadV1;
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
        if (!await isServerProfileHomeIdentity(authorityRuntime.serverId, input.workspace.serverId) || input.workspace.machineId !== runtime.machineId
            || ingress.machineAdmission && ingress.machineAdmission.machineId !== runtime.machineId) return unknown('target_mismatch');
        const refused = await phase('requester', () => readProjectRuntimeAdmissionRefusal(authorityRuntime, { ...ingress, signal }));
        if (refused) return unknown(refused.errorCode);
        releaseRequester = readRequesterAccountActionContext(runtime.accountAuthorization)?.retain();
        const association = await phase('workspace', () => resolveProjectSetupAcceptedWorkspace({ address: input.workspace,
            ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal }));
        const definition = await phase('manifest', () => readProjectEffectiveDefinition({ root: association.workspace.rootPath,
            account: projectRuntimeAccountRowsInput(runtime), project: association.project,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal, acceptedSetup: input.acceptedSetup }));
        const manifest = definition.effectiveDefinition.effectiveManifest;
        const { environmentBindings, secretEnvironment } = await phase('requester_environment', () => resolveProjectRequesterSecretInputs(runtime, {
            project: association.project, requirements: manifest?.environmentVariables ?? [],
        }, signal));
        signal.throwIfAborted();
        const inspection = await phase('review', () => inspectProjectSetup({ workspace: association.workspace, projectAssociation: association,
            acceptedSetup: definition.acceptedSetup,
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
