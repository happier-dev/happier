import { controlNativeServiceForHost } from '@/daemon/local/services/launch/nativeServiceControl';
import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure } from '@happier-dev/protocol/actions';
import type { CliMachineActionCall } from './machineTransport';
import { withMachineServiceControlTarget } from '@/daemon/local/services/launch/machineServiceTarget';
import { isProjectNativeProcessUncertain } from '@/plugins/runtime/exec/errors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

/** The Action consumes the mounted service authority; native effects stay on its handle. */
export function createMachineServiceControlAction(input: Readonly<{
  directMachineId?: string;
  serverId: string;
  callMachineAction: CliMachineActionCall;
  admit(serverId: string, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
  assertCurrent(context: ActionExecutorContext): Promise<void>;
  canControlEnvironment(serverId: string, environmentId: string, context: ActionExecutorContext): Promise<true | ActionExecuteFailure>;
}>): NonNullable<ActionExecutorDeps['machineServiceControl']> {
  return async ({ input: request, context, signal, approvalScope }) => {
    const denied = await input.admit(request.serverId, context);
    if (denied) return denied;
    if (input.directMachineId !== request.machineId) return input.callMachineAction({
      machineId: request.machineId, serverId: request.serverId, method: RPC_METHODS.MACHINES_SERVICE_CONTROL,
      request, authority: context.authority, context, effectActionId: 'machines.services.control', exactMachine: true,
      timeoutMs: null, ...(signal ? { signal } : {}),
    });
    if (!approvalScope) return { ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
    return withMachineServiceControlTarget({ request, machineId: input.directMachineId, serverId: input.serverId,
      approvalScope, ...(signal ? { signal } : {}), assertCurrent: () => input.assertCurrent(context) }, async handle => {
      if (handle.kind === 'environment') {
        const admitted = await input.canControlEnvironment(request.serverId, handle.environmentId, context);
        if (admitted !== true) return admitted;
      }
      if (!handle.controlNative || handle.kind === 'adopted' && !handle.capabilities[request.operation]) {
        return { kind: 'unsupported', reason: 'unsupported' };
      }
      const acceptance = context.operationAcceptance;
      if (!acceptance || acceptance.actionId !== 'machines.services.control') {
        return { ok: false, errorCode: 'service_operation_unavailable', error: 'service_operation_unavailable' };
      }
      await input.assertCurrent(context);
      return controlNativeServiceForHost({ handle, operation: request.operation, operationId: acceptance.operationId,
        context, ...(signal ? { signal } : {}) });
    });
  };
}
