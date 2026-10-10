import type { ProjectDefinitionWorkspace, ProjectSetupReadinessV1 } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { readProjectRuntimeRequesterRefusal, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import { inspectProjectSetupReadiness } from './projectSetupPreparation';
import { resolveProjectRequesterSecretEnvironment } from './projectSetupRequesterInputs';

/** Passive review uses the same captured requester, current target, and native owner as execution. */
export async function inspectProjectSetupReadinessFromRuntime(input: Readonly<{
    runtime: ProjectFiniteActionRuntime; ingress: RpcHandlerContext; workspace: ProjectDefinitionWorkspace; context: ActionExecutorContext;
}>): Promise<ProjectSetupReadinessV1> {
    const { runtime, ingress } = input;
    const signal = input.context.signal ? AbortSignal.any([ingress.signal, input.context.signal]) : ingress.signal;
    let releaseRequester: (() => Promise<void>) | undefined;
    const unknown = (code: string): ProjectSetupReadinessV1 => ({ kind: 'unknown', code });
    const current = async () => !signal.aborted && (!runtime.isCurrent || await runtime.isCurrent())
        && Boolean(ingress.verifyMachineAdmissionCurrent && await ingress.verifyMachineAdmissionCurrent());
    try {
        const refused = await readProjectRuntimeRequesterRefusal(runtime, ingress);
        if (refused) return unknown(refused.errorCode);
        if (input.workspace.serverId !== runtime.serverId || input.workspace.machineId !== runtime.machineId
            || ingress.machineAdmission?.machineId !== runtime.machineId) return unknown('target_mismatch');
        if (!await current()) return unknown('project_requester_credentials_unavailable');
        releaseRequester = readRequesterAccountActionContext(runtime.accountAuthorization)?.retain();
        const association = await resolveProjectSetupAcceptedWorkspace({ address: input.workspace,
            ...projectRuntimeAccountRowsInput(runtime, 'projects.inspect'), serverId: runtime.serverId,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
        const secretEnvironment = await resolveProjectRequesterSecretEnvironment(runtime, undefined, signal);
        if (!await current()) return unknown('project_requester_credentials_unavailable');
        const readiness = await inspectProjectSetupReadiness({ workspace: association.workspace, projectAssociation: association,
            requester: { ...projectRuntimeAccountRowsInput(runtime, 'projects.inspect'), serverHttpBaseUrl: runtime.serverHttpBaseUrl },
            purpose: 'setup', platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform,
                arch: runtime.arch ?? process.arch }, nativeIo: runtime.nativeIo, signal,
            ...(secretEnvironment ? { secretEnvironment } : {}), ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}), ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}) });
        return await current() ? readiness : unknown('project_requester_credentials_unavailable');
    } catch (error) {
        return unknown(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_setup_requester_review_unavailable');
    } finally {
        await releaseRequester?.();
    }
}
