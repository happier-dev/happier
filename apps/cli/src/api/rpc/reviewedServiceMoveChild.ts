import { invokeHostReviewedChildV1, type HostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readProjectServiceMoveChildEffectV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { openReviewedServiceMove } from '@/api/externalActionExecutionAuthorization';
import { projectServiceMoveChildRole } from '@/daemon/local/services/actions/projectServiceMoveChildren';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import type { RpcHandlerContext } from './types';

/** Home admitted the original SOURCE-signed child and this physical receiver.
 * SOURCE can emit this family only through its policy-admitted common port. */
export async function invokeReviewedServiceMoveChild(input: Readonly<{
    method: string;
    params: unknown;
    context: RpcHandlerContext;
    execute(context: RpcHandlerContext): Promise<unknown>;
}>) {
    const denied = () => ({ ok: false as const, error: RPC_ERROR_CODES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    const { context } = input;
    const authorization = context.callerInputAuthorization;
    const admission = context.machineAdmission;
    const action = ActionIdSchema.safeParse(readProjectServiceMoveChildEffectV1(input.method));
    if (!authorization || !admission || !context.originalActionEnvelope || !action.success) return denied();
    const wrapper = TargetedActionRpcRequestV1Schema.safeParse(input.params);
    const normalized = getActionSpec(action.data).inputSchema.safeParse(wrapper.success ? wrapper.data.input : input.params);
    if (!normalized.success) return denied();
    const start = action.data === 'localServices.launcher.start'
        ? DaemonLocalServiceLauncherStartRequestV1Schema.parse(normalized.data) : undefined;
    const move = await openReviewedServiceMove({ authorization, envelope: context.originalActionEnvelope, signal: context.signal,
        ...(start?.setupReview ? { setupReview: start.setupReview } : {}) });
    if (!move) return denied();
    const childInput = projectNativeJsonValueForTransport(normalized.data);
    const actionContext = buildActionExecutorContextForRpc({ ...context, actionId: action.data,
        runtimeAccountId: admission.actorAccountId, externalActionExecutionAuthorization: authorization });
    const parentInput = projectNativeJsonValueForTransport(move.input);
    // The admitted Move schema is an object; transport normalization removes optional members.
    const parent: HostReviewedParentV1 = { actionId: 'projects.service.relocate', input: parentInput as Record<string, JsonValue> };
    const child = { action: action.data, role: projectServiceMoveChildRole(action.data, childInput), input: childInput };
    const result = await invokeHostReviewedChildV1({ parent, child, context: actionContext, receivingAdmission: admission,
        // This is completed SOURCE policy admission, not receiver Settings or a new grant.
        admittedReview: { action: child.action, role: child.role, surface: actionContext.surface ?? 'rpc' },
        execute: async (_childInput, issued) => {
            if (!await move.isChild({ actionId: action.data, machineId: admission.machineId, params: input.params })) return denied();
            if (action.data === 'localServices.launcher.start') {
                const claim = await move.claimStart();
                if (claim.kind !== 'claimed') return { ok: false as const, error: claim.reasonCode, errorCode: claim.reasonCode };
            }
            return { ok: true as const, result: await input.execute({ ...context, reviewedChildActionContext: issued }) };
        } });
    return result.ok ? result.result : result;
}
