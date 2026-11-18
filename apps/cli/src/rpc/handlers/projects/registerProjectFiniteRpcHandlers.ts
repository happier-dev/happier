import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { PROJECT_FINITE_ACTION_IDS_V1, isProjectFiniteActionIdV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createProjectFiniteAction, readProjectFiniteIngressRefusal, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createSnapshotActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const unavailable = (result: ActionExecuteFailure): RpcActionExecutor => ({ execute: async () => result });

export async function createProjectFiniteActionExecutor(
    runtime: ProjectFiniteActionRuntime,
    ingress: RpcHandlerContext,
    actionsSettingsProvider?: RuntimeActionSettingsProvider,
): Promise<RpcActionExecutor> {
    // Signed Project runtimes retain requester custody instead of exposing raw
    // credentials. Never substitute the Machine custodian's Account here.
    const requester = readRequesterAccountActionContext(runtime.accountAuthorization);
    const credentials = runtime.accountAuthorization ? requester?.credentials : runtime.credentials;
    if (!credentials) return unavailable(readProjectFiniteIngressRefusal(ingress)
        ?? failure('project_requester_credentials_unavailable'));
    const accountPolicy = requester ? createSnapshotActionSettingsProvider(() => {
        const snapshot = requester.savedSecretOperationContext.readSnapshot();
        if (!snapshot) throw new Error('requester_account_context_retired');
        return snapshot;
    }, requester.savedSecretOperationContext) : actionsSettingsProvider;
    return (await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials({
        credentials, serverId: runtime.serverId, serverApiUrl: runtime.serverHttpBaseUrl,
        machineId: runtime.machineId, pluginActionExecutionOwner: 'current_process',
        ...(accountPolicy ? { actionsSettingsProvider: accountPolicy } : {}),
        projectAction: createProjectFiniteAction(runtime, ingress),
    });
}

export function registerProjectFiniteRpcHandlers(registrar: RpcHandlerRegistrar, input: Readonly<{
    serverId: string;
    machineId: string;
    runtime?: ProjectFiniteActionRuntime | ((context: RpcHandlerContext) => Promise<ProjectFiniteActionRuntime | null>);
    createActionExecutor?: (runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext) => RpcActionExecutor | Promise<RpcActionExecutor>;
}>): void {
    registerActionSpecRpcHandlers({ rpcHandlerManager: registrar, targetMachineId: input.machineId, defaultMachineTarget: true,
        actionIds: PROJECT_FINITE_ACTION_IDS_V1,
        mapRequestForMethod: async ({ actionId, input: raw }) => {
            if (!isProjectFiniteActionIdV1(actionId)) return { accepted: false, response: failure('unsupported_action') };
            // The generic registrar remains the owner of opening and validating the target wrapper.
            const envelope = TargetedActionRpcRequestV1Schema.safeParse(raw);
            const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(envelope.success ? envelope.data.input : raw);
            if (!parsed.success) return { accepted: false, response: failure('invalid_parameters') };
            if (!input.runtime && !await isServerProfileHomeIdentity(input.serverId, parsed.data.workspace.serverId)) {
                return { accepted: false, response: failure('target_mismatch') };
            }
            return { accepted: true, input: raw };
        },
        resolveActionExecutor: async ({ ingress }) => {
            if (!input.runtime) return unavailable(failure('project_finite_execution_unavailable'));
            if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent) return unavailable(failure('machine_admission_required'));
            const refused = readProjectFiniteIngressRefusal(ingress);
            if (refused) return unavailable(refused);
            if (ingress.signal.aborted) return unavailable(failure('cancelled'));
            if (!await ingress.verifyMachineAdmissionCurrent()) return unavailable(failure('machine_admission_changed'));
            const runtime = typeof input.runtime === 'function' ? await input.runtime(ingress) : input.runtime;
            if (!runtime) return unavailable(failure('project_finite_execution_unavailable'));
            if (runtime.serverId !== input.serverId || runtime.machineId !== input.machineId) return unavailable(failure('target_mismatch'));
            const executor = input.createActionExecutor ? await input.createActionExecutor(runtime, ingress)
                : await createProjectFiniteActionExecutor(runtime, ingress);
            return { execute: (actionId, semanticInput, context) => executor.execute(actionId, semanticInput, {
                ...context,
                // A raw external Home request is an API invocation, not an already-approved local RPC edge.
                ...(!ingress.localActionContext?.surface && !ingress.sessionActionOrigin ? { surface: 'api' as const } : {}),
            }) };
        },
    });
}
