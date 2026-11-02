import { MACHINE_ADMIN_ACCESS_ACTION_IDS, MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS,
  MachineAdminAccessInspectResultV1Schema, MachineAdminAccessMutationResultV1Schema,
  mutateMachineAdminAccessV1, readMachineAdminAccessV1, getMachineAdminAccessV1, MachineAdminAccessFieldV1,
  MachineSudoPasswordPromptV1Schema,
  type ActionExecutorDeps, type MachineAdminAccessV1, type MachineElevatedResultV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import type { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import type { MachineAdminAccessReconcileInput } from '@/machines/adminAccess/machineAdminAccessHost';
import type { MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { assertMachineSystemTaskResponseCurrent } from '@/capabilities/service';
import { buildActionExecutorContextForRpc, type RpcActionExecutorContext } from './_actionDispatchAdapter';
import type { InteractiveSystemTaskContext } from '@happier-dev/cli-common/systemTasks/interactiveTaskKinds';

export type DaemonMachineAdminAccessRoutes = Readonly<{
  observer: ReturnType<typeof createMachineAdminAccessObserver>;
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
  reconcile: (input: MachineAdminAccessReconcileInput & Readonly<{
    installationId: string; port: MachineMetadataFieldPortV1;
    inspect: ReturnType<typeof createMachineAdminAccessObserver>['inspect'];
    emit?: MachineElevationDependencies['emit'];
    prompt?: MachineElevationDependencies['prompt'];
  }>) => Promise<MachineElevatedResultV1>;
}>;

export function registerDaemonMachineAdminAccessRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineAdminAccessRoutes & Readonly<{
  captureMetadataPort: () => MachineMetadataFieldPortV1;
  runActionOperation: NonNullable<ActionExecutorDeps['runActionOperation']>;
}>): void {
  for (const actionId of MACHINE_ADMIN_ACCESS_ACTION_IDS) {
    rpc.registerHandler(actionId, async (raw, ingress) => {
      const run = async (context?: RpcHandlerContext) => {
      const request = MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS[actionId].parse(raw);
      const target = options.target();
      if (!context || context.signal.aborted || !target
        || (actionId === 'machines.setup.adminAccess.set' && context.machineAdmission?.role !== 'manage')
        || !doesMachineRpcTargetMatchAdmission(request, context.machineAdmission, target)) {
        throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
      }
      if (actionId === 'machines.setup.adminAccess.set') {
        const mutation = MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS[actionId].parse(raw);
        const port = options.captureMetadataPort();
        const captured: { previousPolicy: MachineAdminAccessV1 | null } = { previousPolicy: null };
        const result = await mutateMachineAdminAccessV1({ expectedMetadataVersion: mutation.expectedMetadataVersion,
          expectedAdminAccess: mutation.expectedAdminAccess, adminAccess: mutation.adminAccess, comparison: mutation.comparison }, {
          read: async () => {
            const snapshot = await port.read();
            if (captured.previousPolicy === null && snapshot.status === 'ready') {
              const previous = readMachineAdminAccessV1(snapshot.metadata);
              if (previous.status === 'ready') captured.previousPolicy = previous.policy;
            }
            return snapshot;
          },
          compareAndSwap: input => port.compareAndSwap(input),
        }, { signal: context?.signal });
        const operation = context?.localActionContext;
        const accepted = operation?.operationAcceptance;
        const operationId = (accepted?.actionId === actionId ? accepted.operationId : undefined)
          ?? operation?.actionRequestId ?? context?.transportRequestId;
        const previousPolicy = captured.previousPolicy;
        if (previousPolicy?.mode === 'none' && 'policy' in result && result.policy?.mode === 'none') {
          return MachineAdminAccessMutationResultV1Schema.parse(result);
        }
        if (target && previousPolicy && operationId
          && (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged')) {
          const previous = previousPolicy;
          const verifyTransition = async () => {
            if (context.signal.aborted) return false;
            const current = await getMachineAdminAccessV1(port);
            return current.status === 'ready' && MachineAdminAccessFieldV1.equal(current.policy, result.policy);
          };
          const reconcile = async (taskContext: InteractiveSystemTaskContext) => await options.reconcile({ machineId: target.machineId, installationId: target.installationId,
            operationId, previousPolicy: previous, policy: result.policy, port, inspect: options.observer.inspect,
            signal: taskContext.signal ? AbortSignal.any([context!.signal, taskContext.signal]) : context!.signal,
            verifyCurrent: verifyTransition,
            prompt: async question => await taskContext.prompt({ ...question, validateResponse: async authorization => {
              await assertMachineSystemTaskResponseCurrent(authorization, {
                admission: context!.machineAdmission!,
                verifyCurrent: async () => doesMachineRpcTargetMatchAdmission(request, context.machineAdmission, options.target())
                  && await verifyTransition(),
              });
              await question.validateResponse?.(authorization);
            } }),
            emit: event => {
              taskContext.emit(event);
              const phase = event.data && typeof event.data === 'object' && 'phase' in event.data
                && typeof event.data.phase === 'string' ? event.data.phase : undefined;
              if (phase) context?.localActionContext?.operationProgress?.update({ phase });
            },
          });
          const tasks = getLiveSystemTasksRunnerAdapter();
          let effect: MachineElevatedResultV1 | undefined;
          const publishTask = (task: Readonly<{ taskId: string }>, prompt?: import('@happier-dev/protocol').MachineSudoPasswordPromptV1) => {
            operation?.operationOwnerUpdate?.update({ domainRef: { kind: 'machineSetup', serverId: target.serverId,
              machineId: target.machineId, setupTask: { id: task.taskId, taskKind: 'machine.setup.apply.v1', ...(prompt ? { prompt } : {}) } } });
          };
          try {
          const task = await tasks.startAdmitted({ run: async taskContext => {
            effect = await reconcile(taskContext);
            return { operationId };
          } }, 'machine.setup.apply.v1', {
            started: task => publishTask(task),
            prompt: (task, question) => {
              const data = question?.data;
              const prompt = question?.kind === 'sudo.password' && data && typeof data === 'object' && !Array.isArray(data)
                && 'machineId' in data && data.machineId === target.machineId
                && 'installationId' in data && data.installationId === target.installationId
                && 'operationId' in data && data.operationId === operationId
                ? MachineSudoPasswordPromptV1Schema.safeParse({ kind: question.kind,
                    adminUsername: 'administratorUsername' in data ? data.administratorUsername : undefined }) : null;
              publishTask(task, prompt?.success ? prompt.data : undefined);
            },
          });
          const cancel = () => { void tasks.cancel(task); };
          context!.signal.addEventListener('abort', cancel, { once: true });
          if (context!.signal.aborted) cancel();
          try { await tasks.wait(task); }
          finally { context!.signal.removeEventListener('abort', cancel); }
          } catch {
            // The desired CAS is already acknowledged. Task/host uncertainty
            // cannot erase it or claim a successful native reconciliation.
            effect ??= { outcome: 'outcome_unknown' };
          }
          effect ??= context!.signal.aborted ? { outcome: 'not_applied', reasonCode: 'cancelled' } : { outcome: 'outcome_unknown' };
          if (effect.outcome === 'outcome_unknown') await options.observer.inspect().catch(() => undefined);
          const observation = options.observer.read();
          return MachineAdminAccessMutationResultV1Schema.parse({ ...result, effect, ...(observation ? { observation } : {}) });
        }
        // No correlation means no owned host operation, not a failed desired write.
        // An issued/acknowledged CAS keeps its settlement even if the caller retires.
        return MachineAdminAccessMutationResultV1Schema.parse(result.status === 'unavailable' && context?.signal.aborted
          ? { status: 'cancelled' } : result);
      }
      const result = await options.observer.inspect().catch(() => ({ status: 'unavailable' as const }));
      context.signal.throwIfAborted();
      return MachineAdminAccessInspectResultV1Schema.parse(result);
      };
      if (actionId !== 'machines.setup.adminAccess.set') return await run(ingress);
      if (!ingress) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
      // A host-private desired-only write has not requested a physical Action.
      // Only original correlation or this same admitted Action may own effects.
      if (!ingress.localActionContext?.actionRequestId && !ingress.transportRequestId
        && ingress.localActionContext?.operationAcceptance?.actionId !== actionId) return await run(ingress);
      const request = MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS[actionId].parse(raw);
      const context = buildActionExecutorContextForRpc({ ...ingress, actionId, serverId: request.serverId,
        localActionContext: { ...ingress.localActionContext,
          actionRequestId: ingress.localActionContext?.actionRequestId ?? ingress.transportRequestId } });
      const result = await options.runActionOperation({ actionId, input: request, context,
        execute: async current => {
          const operation: RpcActionExecutorContext = current;
          return { ok: true, result: await run({ ...ingress, signal: operation.signal
            ? AbortSignal.any([ingress.signal, operation.signal]) : ingress.signal,
            localActionContext: { ...ingress.localActionContext, ...operation } }) };
        } });
      if (!result.ok) throw new RpcError(result.error, result.errorCode);
      return MachineAdminAccessMutationResultV1Schema.parse(result.result);
    });
  }
}
