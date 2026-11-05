import { homedir } from 'node:os';
import {
  checkMachineSetupEffectPlan, createMachineSetupNativeBackend, createNativeUpdatesSteps,
  observeNativeUpdates, readMachineSetupEffectPlanV1, runMachineSetupNativeCommand,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult,
} from '@happier-dev/cli-common/machineSetup';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { MachineSetupUpdatesApplyInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupObservationV1 } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectNativeInvocationCustody, type ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { logger } from '@/ui/logger';
import { resolveInstalledMachineEffectCli } from '../adminAccess/runElevatedEffect';
import { applyMachineSetupUpdates } from './applyMachineSetup';
import { machineSetupTargetUnavailable, type MachineSetupInstallation } from './machineSetupHomeRequest';

/** Exact candidate versions use the incumbent package checker and plan digest. */
export async function prepareMachineSetupUpdatesPlanV1(params: Readonly<{
  machineId: string;
  scope: 'security' | 'all';
  runNative?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
}>): Promise<Readonly<{
  observation: NonNullable<MachineSetupObservationV1['updates']>;
  plan?: MachineSetupEffectPlanV1;
}>> {
  const run = (command: MachineSetupNativeCommand) => (params.runNative ?? runMachineSetupNativeCommand)({
    ...command, ...(params.signal ? { signal: params.signal } : {}),
  });
  const observed = await observeNativeUpdates({
    run: (executable, args, env) => run({ executable, args, ...(env ? { env } : {}) }),
    ...(params.platform ? { platform: params.platform } : {}),
  });
  if (!observed.candidates) return { observation: observed.observation };
  const steps = [...createNativeUpdatesSteps({ scope: params.scope, candidates: observed.candidates })];
  const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'updates', machineId: params.machineId, scope: params.scope },
    steps, backend: createMachineSetupNativeBackend({ run, ...(params.signal ? { signal: params.signal } : {}),
      ...(params.platform ? { platform: params.platform } : {}) }),
  });
  return { observation: observed.observation, plan };
}

/** Updates change installed packages, never the Machine's desired setup copies. */
export function createMachineSetupUpdatesAction(params: Readonly<{
  apiMachine: ApiMachineClient;
  machineId: string;
  homeId: string;
  installation: MachineSetupInstallation;
  ownerRemainder?: OwnerRemainderPort;
}>): (request: Readonly<{
  input: MachineSetupUpdatesApplyInputV1;
  context: RpcActionExecutorContext;
  signal?: AbortSignal;
}>) => Promise<unknown> {
  return async ({ input, context, signal }) => {
    const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
    const lifetime = signal ?? context.signal ?? new AbortController().signal;
    if (input.machineId !== params.machineId || input.homeId !== params.homeId) return fail('target_mismatch');
    if (lifetime.aborted) return fail('cancelled');
    if (!context.externalActionExecutionAuthorization) return fail('admission_unavailable');
    const admission = context.machineAdmission;
    if (admission && (admission.machineId !== params.machineId || admission.installationId !== params.installation.installationId
      || !context.verifyMachineAdmissionCurrent)) return fail('machine_admission_changed');
    let runtimeRefusal: Parameters<typeof machineSetupTargetUnavailable>[1];
    const runtime = await params.apiMachine.resolveMachineSetupRuntime({ signal: lifetime,
      onUnavailable: reason => { runtimeRefusal = reason; },
      ...(admission ? { machineAdmission: admission } : {}),
      ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}),
    });
    if (!runtime || runtime.machineId !== params.machineId || !runtime.isCurrent || !await runtime.isCurrent())
      return machineSetupTargetUnavailable('installed_runtime', runtimeRefusal);
    const terminalSessions = params.apiMachine.getFiniteTerminalSessions();
    if (!terminalSessions) return machineSetupTargetUnavailable('finite_terminal');
    const custodianAccountId = readAccountIdFromToken(runtime.credentials.token);
    if (!custodianAccountId || admission && admission.custodianAccountId !== custodianAccountId) return fail('credential_unavailable');
    const requesterAccountId = admission?.actorAccountId ?? custodianAccountId;
    const run = async (operation: ProjectSetupOperationContext): Promise<ActionExecuteResult> => {
      const cancellationSignal = AbortSignal.any([operation.signal, lifetime]);
      const custody = createProjectNativeInvocationCustody(operation);
      let nativeStarted = false;
      try {
        const reviewed = readMachineSetupEffectPlanV1(input.plan);
        const planned = await prepareMachineSetupUpdatesPlanV1({ machineId: params.machineId, scope: input.scope, signal: cancellationSignal });
        if (cancellationSignal.aborted) return fail('cancelled');
        if (!planned.plan) return fail(planned.observation.reason ?? planned.observation.status);
        if (!reviewed || reviewed.planDigest !== planned.plan.planDigest) return fail('plan_changed');
        const isActive = async () => !cancellationSignal.aborted;
        const administrator = params.apiMachine.captureMachineAdminAccess();
        const io = createProjectNativeIo({ ownerRemainder: params.ownerRemainder }).environmentIo.createInvocation({
          signal: cancellationSignal, retainCapture: custody.retain,
        });
        nativeStarted = true;
        return await applyMachineSetupUpdates({ homeId: input.homeId, machineId: input.machineId,
          plan: planned.plan, requesterAccountId, userHomeDirectory: homedir(), operation, signal: cancellationSignal,
          terminalSessions, environmentIo: io, settleNative: () => custody.release(), isCurrent: isActive,
          elevation: { ...administrator, installationId: params.installation.installationId,
            installedCli: resolveInstalledMachineEffectCli(), verifyCurrent: isActive },
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : cancellationSignal.aborted ? 'cancelled' : 'machine_setup_apply_failed';
        return { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.setup.updates.apply'), errorCode: code };
      } finally {
        try { await custody.release(); }
        finally {
          custody.dispose();
          if (nativeStarted) {
            try { await params.apiMachine.refreshMachineSetupUpdates(); }
            catch { logger.warn('[machineSetupUpdates] Failed to refresh update facts after native settlement'); }
          }
        }
      }
    };
    const result = context.operationAcceptance && context.operationOwnerUpdate ? await run({ ...context,
      actionRequestId: context.actionRequestId ?? undefined,
      resumeActionRequest: context.resumeActionRequest === true ? true : undefined,
      signal: context.signal ?? lifetime, operationOwnerUpdate: context.operationOwnerUpdate,
      operationProgress: context.operationProgress ?? { update() {} },
    }) : await params.apiMachine.observeActionExecution({ actionId: 'machines.setup.updates.apply', input,
      actionRequestId: context.actionRequestId ?? undefined, rpcContext: context, execute: run,
    });
    return result.ok ? result.result : result;
  };
}
