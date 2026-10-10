import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createProjectFiniteAction, readProjectFiniteIngressRefusal, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const unavailable = (result: ActionExecuteFailure): RpcActionExecutor => ({ execute: async () => result });

export function registerProjectFiniteRpcHandlers(registrar: RpcHandlerRegistrar, input: Readonly<{
    serverId: string;
    machineId: string;
    runtime?: ProjectFiniteActionRuntime | ((context: RpcHandlerContext) => Promise<ProjectFiniteActionRuntime | null>);
    createActionExecutor?: (runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext) => RpcActionExecutor | Promise<RpcActionExecutor>;
}>): void {
    registerActionSpecRpcHandlers({ rpcHandlerManager: registrar, targetMachineId: input.machineId, defaultMachineTarget: true,
        actionIds: ['projects.prepare', 'projects.script.run', 'projects.compute.exec'],
        mapRequestForMethod: async ({ actionId, input: raw }) => {
            if (actionId !== 'projects.prepare' && actionId !== 'projects.script.run' && actionId !== 'projects.compute.exec') return { accepted: false, response: failure('unsupported_action') };
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
                : runtime.credentials ? (await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials({
                    credentials: runtime.credentials, serverId: runtime.serverId, serverApiUrl: runtime.serverHttpBaseUrl,
                    machineId: runtime.machineId, pluginActionExecutionOwner: 'current_process',
                    projectAction: createProjectFiniteAction(runtime, ingress),
                }) : unavailable(failure('project_requester_credentials_unavailable'));
            return { execute: (actionId, semanticInput, context) => executor.execute(actionId, semanticInput, {
                ...context,
                // A raw external Home request is an API invocation, not an already-approved local RPC edge.
                ...(!ingress.localActionContext?.surface && !ingress.sessionActionOrigin ? { surface: 'api' as const } : {}),
            }) };
        },
    });
}
