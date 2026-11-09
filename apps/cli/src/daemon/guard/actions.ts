import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import type { RpcActionExecutor, RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { MachineProcessesCleanUpInputV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

export type GuardLeftBehindActionRequest = Readonly<{ mode: 'ask' | 'automatic'; refs: readonly string[]; sessionId?: string; signal?: AbortSignal }>;
export function createGuardLeftBehindActionExecutor(params: Readonly<{
  readContext(signal?: AbortSignal): Promise<RpcActionExecutorContext | null>;
  getExecutor(context: RpcActionExecutorContext): RpcActionExecutor | null;
  observeExecution: HostActionOperationRuntime['observeExecution'];
}>): (request: GuardLeftBehindActionRequest) => Promise<ActionExecuteResult> {
  return async request => {
    try {
      request.signal?.throwIfAborted();
      const captured = await params.readContext(request.signal);
      const admission = captured?.machineAdmission;
      if (!captured || !admission || admission.role !== 'manage'
        || admission.actorAccountId !== admission.custodianAccountId
        || captured.runtimeAccountId !== admission.actorAccountId
        || captured.authority !== 'account_automation' || captured.actionCaller?.kind !== 'host'
        || !captured.verifyMachineAdmissionCurrent || !await captured.verifyMachineAdmissionCurrent()) {
        return { ok: false, errorCode: 'scope-retired', error: 'scope-retired' };
      }
      // Action operands travel across clients; the creator-local profile id
      // stays in executionOriginV1, while the target uses the captured Home id.
      const input = MachineProcessesCleanUpInputV1Schema.parse({ serverId: captured.serverIdentityId, machineId: admission.machineId, refs: [...request.refs] });
      const context: RpcActionExecutorContext = { ...captured,
        ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
        ...(request.signal ? { signal: request.signal } : {}) };
      const execute = async (current: RpcActionExecutorContext) => {
        current.signal?.throwIfAborted();
        const executor = params.getExecutor(current);
        if (!executor) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
        const result = await executor.execute(request.mode === 'ask' ? 'approval.request.create' : 'machines.processes.leftBehind.cleanUp',
          request.mode === 'ask' ? { actionId: 'machines.processes.leftBehind.cleanUp', actionArgs: input,
            summary: 'Clean up the confirmed left-behind process set', createdBy: { surface: 'system', ...(request.sessionId ? { sessionId: request.sessionId } : {}) } } : input, current);
        return result;
      };
      if (request.mode === 'ask') return await execute(context);
      let completion: Promise<ActionExecuteResult> | undefined;
      const observed = await params.observeExecution({ actionId: 'machines.processes.leftBehind.cleanUp', input,
        actionRequestId: context.actionRequestId, rpcContext: context,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        execute: operation => {
          completion = (async () => {
            const lifetime = new AbortController();
            const cancel = () => lifetime.abort(operation.signal.aborted ? operation.signal.reason : request.signal?.reason);
            operation.signal.addEventListener('abort', cancel, { once: true });
            request.signal?.addEventListener('abort', cancel, { once: true });
            if (operation.signal.aborted || request.signal?.aborted) cancel();
            try { return await execute({ ...context, ...operation, signal: lifetime.signal }); }
            finally {
              operation.signal.removeEventListener('abort', cancel);
              request.signal?.removeEventListener('abort', cancel);
            }
          })();
          return completion;
        } });
      // The operation may publish acceptance early; Guard records only the
      // original Action's actual decision/effect result, never acceptance.
      return completion ? await completion : observed;
    } catch (error) {
      const code = request.signal?.aborted ? 'cancelled'
        : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed';
      return { ok: false, errorCode: code, error: code };
    }
  };
}
