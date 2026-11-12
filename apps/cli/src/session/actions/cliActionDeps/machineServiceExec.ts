import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure } from '@happier-dev/protocol/actions';
import type { CliMachineActionCall } from './machineTransport';
import { withMachineServiceCommandTarget } from '@/daemon/local/services/launch/machineServiceTarget';
import { isProjectNativeProcessUncertain } from '@/plugins/runtime/exec/errors';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

/** Invocation policy consumes the mounted generation; only its native owner executes. */
export function createMachineServiceExecAction(input: Readonly<{
  directMachineId?: string;
  serverId: string;
  callMachineAction: CliMachineActionCall;
  admit(serverId: string, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
  assertCurrent(context: ActionExecutorContext): Promise<void>;
  canExecuteEnvironment(serverId: string, environmentId: string, context: ActionExecutorContext): Promise<true | ActionExecuteFailure>;
}>): NonNullable<ActionExecutorDeps['machineServiceExec']> {
  return async ({ input: request, context, signal, approvalScope }) => {
    const denied = await input.admit(request.serverId, context);
    if (denied) return denied;
    const uncertain = () => {
      context.operationOwnerUpdate?.update({ cancellation: 'unsupported', outcome: {
        ok: false, errorCode: 'action_outcome_unknown', error: 'Native service command settlement is unknown',
      } });
      return { kind: 'outcome_unknown' as const };
    };
    if (input.directMachineId !== request.machineId) {
      await input.assertCurrent(context);
      try {
        return await input.callMachineAction({ machineId: request.machineId, serverId: request.serverId,
          method: RPC_METHODS.MACHINES_SERVICE_EXEC, request, authority: context.authority, context,
          effectActionId: 'machines.services.exec', exactMachine: true, timeoutMs: null,
          ...(signal ? { signal } : {}) });
      } catch (error) {
        // A pre-dispatch refusal or an acknowledged remote failure is not loss.
        if (readMachineRpcRequestDisposition(error) === 'outcomeUnknown') return uncertain();
        throw error;
      }
    }
    if (request.target.kind !== 'current' || !approvalScope) return {
      ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable',
    };
    const target = request.target;
    return withMachineServiceCommandTarget({ request: {
      serverId: request.serverId, machineId: request.machineId,
      serviceId: target.serviceId, expectedGeneration: target.expectedGeneration,
    }, machineId: input.directMachineId, serverId: input.serverId, approvalScope,
      ...(signal ? { signal } : {}), assertCurrent: () => input.assertCurrent(context) }, async handle => {
      if (!handle.executeServiceCommand) return {
        ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable',
      };
      if (handle.kind === 'environment') {
        // An Environment service is already one Compose member.
        if (target.service !== undefined) return {
          ok: false, errorCode: 'service_selection_invalid', error: 'service_selection_invalid',
        };
        const permission = await input.canExecuteEnvironment(request.serverId, handle.environmentId, context);
        if (permission !== true) return permission;
      }
      // An adopted watch was admitted by the Machine-scope approval match that
      // selected it (Plan 30 §3.2c); it has no Environment to re-check.
      // Run requires fresh exact-generation P42 runtime admission; a disposed
      // deployment port or latest Environment overlay cannot substitute for it.
      if (request.mode !== 'exec') return {
        ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable',
      };
      const acceptance = context.operationAcceptance;
      if (!acceptance || acceptance.actionId !== 'machines.services.exec') return {
        ok: false, errorCode: 'service_operation_unavailable', error: 'service_operation_unavailable',
      };
      const lifetime = AbortSignal.any([handle.retirementSignal, ...(signal ? [signal] : [])]);
      try {
        const options = { operation: { operationId: acceptance.operationId, kind: 'serviceCommand', signal: lifetime },
          signal: lifetime };
        const command = { mode: 'exec' as const, argv: request.argv };
        const result = handle.kind === 'adopted'
          ? await handle.executeServiceCommand!(command, { ...options, ...(target.service ? { service: target.service } : {}) })
          : await handle.executeServiceCommand!(command, options);
        if (result.kind === 'outcome_unknown') return uncertain();
        // The native owner alone applies finite output bounds and redaction.
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
      } catch (error) {
        if (isProjectNativeProcessUncertain(error)) return uncertain();
        // The watched plugin refused the selection before any launch.
        if (isPluginError(error) && error.code === 'service_selection_invalid') return {
          ok: false, errorCode: error.code, error: error.code,
        };
        throw error;
      }
    });
  };
}
