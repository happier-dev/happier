import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { isSocketRpcMachineAccessLossServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { MachineSudoPasswordPromptV1Schema, type MachineSudoPasswordPromptV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { assertMachineSystemTaskResponseCurrent } from '@/capabilities/service';
import type { AgentIsolationMemberRequester } from './provisioning';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { HostActionOperationRuntime } from '../actionOperations/createHostActionOperationRuntime';
import type { ManagedActivityInventory } from '../lifecycle/managedActivity';
import { waitForRequesterMachineNaturalBoundary } from './naturalBoundary';
import { memberIdentityRetirementInput, supersedeMemberIdentityRetirement } from './supersedeRetirement';
import { readAgentIsolationMemberLaunchIdentity } from './memberBindings';
import { retireAgentIsolationMemberIdentity, readProvisionedRequesterAccounts,
  ensureAgentIsolationMember, applyAgentIsolationMemberEffects, type EnsureAgentIsolationMemberResult,
  type AgentIsolationEffectDependencies, type ApplyAgentIsolationMemberEffectsResult } from './agentIsolationProvisioner';

type RetirementResult = Readonly<{ kind: 'settled' | 'incomplete' }>;
type MemberOperationTarget = Readonly<{
  homeServerIdentityId: string; machineId: string; installationId: string; custodianAccountId: string;
  encryptionMode: NonNullable<RpcHandlerContext['machineAdmission']>['encryptionMode'];
}>;

const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray;

/** Consumes already admitted server-origin access loss. All subsequent guards
 * are local cancellation/installation custody, never per-step Home admission. */
export function createAgentIsolationMemberOperations(options: Readonly<{
  observeExecution: HostActionOperationRuntime['observeExecution'];
  operations: Pick<HostActionOperationRuntime, 'store' | 'runner'>;
  /** Saved Home profile used by existing work attribution, distinct from canonical Home identity. */
  serverId: string;
  readActivityInventory(): Pick<ManagedActivityInventory, 'read' | 'subscribeFacts'> | null;
  target(): MemberOperationTarget | null;
  activeServerDir: string;
  captureMetadataPort(): MachineMetadataFieldPortV1;
  effects: AgentIsolationEffectDependencies;
}>) {
  const captureTarget = (context: RpcHandlerContext): MemberOperationTarget | null => {
    const target = options.target(), admission = context.machineAdmission;
    return target && target.homeServerIdentityId && admission
      && isSocketRpcMachineAccessLossServerOriginAuthorizationContext(context.authorization)
      && admission.actorAccountId === target.custodianAccountId && admission.custodianAccountId === target.custodianAccountId
      && admission.machineId === target.machineId && admission.installationId === target.installationId ? target : null;
  };
  const localCustody = (target: MemberOperationTarget, context: RpcHandlerContext, isCurrentInstallation: () => boolean) => () => {
    const current = options.target();
    return !context.signal.aborted && isCurrentInstallation() && !!current
      && current.homeServerIdentityId === target.homeServerIdentityId && current.machineId === target.machineId
      && current.installationId === target.installationId && current.custodianAccountId === target.custodianAccountId
      && current.encryptionMode === target.encryptionMode;
  };
  type AdmittedTask = Parameters<ReturnType<typeof getLiveSystemTasksRunnerAdapter>['startAdmitted']>[0];
  type TaskContext = Parameters<AdmittedTask['run']>[0];
  const startOwnerSetupTask = (input: Readonly<{
    target: MemberOperationTarget;
    operationId: string;
    ownerUpdate: NonNullable<NonNullable<RpcHandlerContext['localActionContext']>['operationOwnerUpdate']>;
    verifyCurrent(): boolean | Promise<boolean>;
    run(context: TaskContext, elevation: AgentIsolationEffectDependencies['elevation']): ReturnType<AdmittedTask['run']>;
  }>) => {
    const { target, operationId, ownerUpdate } = input;
    const publishTask = (task: Readonly<{ taskId: string }>, prompt?: MachineSudoPasswordPromptV1) =>
      ownerUpdate.update({ domainRef: { kind: 'machineSetup', serverId: target.homeServerIdentityId,
        machineId: target.machineId, setupTask: { id: task.taskId, taskKind: 'machine.setup.apply.v1', ...(prompt ? { prompt } : {}) } } });
    return getLiveSystemTasksRunnerAdapter().startAdmitted({ run: context => input.run(context, {
      ...options.effects.elevation,
      prompt: question => context.prompt({ ...question, validateResponse: async authorization => {
        // Expected custody is not an admission. The response supplies its own
        // independently current present-owner Manage proof and OS password.
        await assertMachineSystemTaskResponseCurrent(authorization, {
          admission: { actorAccountId: target.custodianAccountId, custodianAccountId: target.custodianAccountId,
            machineId: target.machineId, installationId: target.installationId,
            role: 'manage', encryptionMode: target.encryptionMode }, verifyCurrent: async () => input.verifyCurrent(),
        });
        await question.validateResponse?.(authorization);
      } }),
      emit: event => { context.emit(event); options.effects.elevation.emit?.(event); },
    }) }, 'machine.setup.apply.v1', { started: task => publishTask(task), prompt: (task, question) => {
      const data = question?.data;
      const prompt = question?.kind === 'sudo.password' && data && typeof data === 'object' && !isArray(data)
        && data.machineId === target.machineId && data.installationId === target.installationId && data.operationId === operationId
        ? MachineSudoPasswordPromptV1Schema.safeParse({ kind: question.kind, adminUsername: data.administratorUsername }) : null;
      publishTask(task, prompt?.success ? prompt.data : undefined);
    } });
  };
  return Object.freeze({
    /** Native operations consume the admitted binding. Setup/readiness belongs
     * to preparation and explicit own-status, never the per-operation path. */
    async read(input: Readonly<{
      requesterIdentity: AgentIsolationMemberRequester; rpcContext?: RpcHandlerContext; signal?: AbortSignal;
    }>) {
      const target = options.target(), { requesterIdentity, rpcContext } = input;
      const signal = input.signal && rpcContext ? AbortSignal.any([input.signal, rpcContext.signal])
        : input.signal ?? rpcContext?.signal;
      signal?.throwIfAborted();
      const daemonObservation = options.effects.readDaemonObservation?.();
      if (!target || target.homeServerIdentityId !== requesterIdentity.homeServerIdentityId
        || target.machineId !== requesterIdentity.requester.machineId
        || target.installationId !== requesterIdentity.requester.installationId
        || target.installationId !== options.effects.elevation.installationId
        || options.effects.platform !== 'linux' || !daemonObservation || daemonObservation.daemonIdentity !== 'nonRoot'
        || daemonObservation.daemonUid === null || daemonObservation.daemonUid <= 0
        || !daemonObservation.daemonUsername || !daemonObservation.daemonPrimaryGroup) throw new PluginError({
          code: 'agent_isolation_unavailable', message: 'The requester identity binding is unavailable', retryable: false,
          details: { reason: 'requester_authority_unavailable', phase: 'native_identity_binding' },
        });
      const identity = await readAgentIsolationMemberLaunchIdentity({ requesterIdentity,
        activeServerDir: options.activeServerDir, signal }, options.effects.backend);
      signal?.throwIfAborted();
      return { identity, daemonObservation };
    },
    async prepare(input: Readonly<{
      requesterIdentity: AgentIsolationMemberRequester; rpcContext?: RpcHandlerContext; signal?: AbortSignal;
    }>): Promise<EnsureAgentIsolationMemberResult> {
      const target = options.target(), { requesterIdentity, rpcContext } = input;
      const refused = (): EnsureAgentIsolationMemberResult => ({ kind: 'not_ready',
        result: { outcome: 'not_applied', reasonCode: input.signal?.aborted || rpcContext?.signal.aborted ? 'cancelled' : 'denied' } });
      if (!target || target.homeServerIdentityId !== requesterIdentity.homeServerIdentityId
        || target.machineId !== requesterIdentity.requester.machineId
        || target.installationId !== requesterIdentity.requester.installationId) return refused();
      const initialSignal = input.signal && rpcContext ? AbortSignal.any([input.signal, rpcContext.signal])
        : input.signal ?? rpcContext?.signal;
      let signal = initialSignal;
      const current = async () => {
        const value = options.target();
        return !signal?.aborted && !!value && value.homeServerIdentityId === target.homeServerIdentityId
          && value.machineId === target.machineId && value.installationId === target.installationId
          && value.custodianAccountId === target.custodianAccountId && value.encryptionMode === target.encryptionMode;
      };
      try {
        const superseded = await supersedeMemberIdentityRetirement({ target,
          accountId: requesterIdentity.requester.accountId, signal: initialSignal, operations: options.operations,
          admittedOperationId: rpcContext?.localActionContext?.operationAcceptance?.operationId, requesterServerId: options.serverId });
        if (superseded.kind !== 'settled') return refused();
        return await ensureAgentIsolationMember({ requesterIdentity, activeServerDir: options.activeServerDir,
          signal: initialSignal, verifyLocalCustody: current,
          setup: async () => {
            // This effect was admitted by the current owner-reviewed policy.
            // Its child uses the runtime's actual enrolled Account; it never
            // copies or fabricates an owner RPC/admission for the requester.
            rpcContext?.localActionContext?.operationProgress?.update({ phase: 'owner_setup', label: 'Waiting for owner setup' });
            let result: ApplyAgentIsolationMemberEffectsResult = refused();
            const execute = async (operation: Readonly<{
              signal: AbortSignal;
              operationAcceptance?: NonNullable<RpcHandlerContext['localActionContext']>['operationAcceptance'];
              operationOwnerUpdate?: NonNullable<RpcHandlerContext['localActionContext']>['operationOwnerUpdate'];
              operationProgress?: NonNullable<RpcHandlerContext['localActionContext']>['operationProgress'];
            }>) => {
              const operationId = operation.operationAcceptance?.operationId;
              if (!operationId || !operation.operationOwnerUpdate || !operation.operationProgress)
                return { ok: false as const, errorCode: 'machine_setup_operation_unavailable', error: 'machine_setup_operation_unavailable' };
              if (!options.operations.store.get({ accountId: target.custodianAccountId, machineId: target.machineId }, operationId))
                return { ok: false as const, errorCode: 'machine_setup_operation_unavailable', error: 'machine_setup_operation_unavailable' };
              signal = initialSignal ? AbortSignal.any([initialSignal, operation.signal]) : operation.signal;
              const ownerUpdate = operation.operationOwnerUpdate, progress = operation.operationProgress;
              return machineNativeEffectAdmission.run({ operation: { operationId, kind: 'agentIsolation', signal },
                keys: [{ kind: 'machineSetup' }] }, async nativeEffectContext => {
                const owner = getLiveSystemTasksRunnerAdapter();
                const task = await startOwnerSetupTask({ target, operationId, ownerUpdate, verifyCurrent: current,
                  run: async (context, elevation) => {
                    const taskSignal = context.signal ? AbortSignal.any([signal!, context.signal]) : signal;
                    result = await applyAgentIsolationMemberEffects({ machineId: target.machineId, requesterIdentity,
                      activeServerDir: options.activeServerDir, port: options.captureMetadataPort(),
                      operationId, nativeEffectContext, signal: taskSignal, verifyCurrent: current },
                    { ...options.effects, elevation });
                    return { operationId };
                  } });
                progress.update({ phase: 'member_setup', label: 'Preparing private member execution' });
                const cancel = () => { void owner.cancel(task); };
                signal!.addEventListener('abort', cancel, { once: true });
                if (signal!.aborted) cancel();
                try {
                  const settled = await owner.wait(task);
                  return settled.ok && result.kind === 'ready' ? { ok: true as const, result: { kind: 'ready' } }
                    : { ok: false as const, errorCode: signal!.aborted ? 'cancelled' : 'member_setup_required', error: 'Member execution requires owner setup' };
                } finally { signal!.removeEventListener('abort', cancel); }
              });
            };
            await options.observeExecution({ actionId: 'machines.agentIsolation.set',
              input: { kind: 'memberIdentityProvisioning', homeServerIdentityId: target.homeServerIdentityId,
                machineId: target.machineId, installationId: target.installationId,
                accountId: requesterIdentity.requester.accountId },
              execute });
            return result;
          },
        }, options.effects);
      } catch { return refused(); }
    },
    async readProvisionedRequesterAccounts(input: Readonly<{
      rpcContext: RpcHandlerContext;
    }>): Promise<Readonly<{ accountIds: readonly string[]; coverage: 'complete' | 'unknown' }>> {
      const target = captureTarget(input.rpcContext);
      if (!target) return { accountIds: [], coverage: 'unknown' };
      try {
        input.rpcContext.signal.throwIfAborted();
        const result = await readProvisionedRequesterAccounts({ activeServerDir: options.activeServerDir,
          homeServerIdentityId: target.homeServerIdentityId, machineId: target.machineId, installationId: target.installationId }, options.effects.backend);
        input.rpcContext.signal.throwIfAborted();
        return result;
      } catch { return { accountIds: [], coverage: 'unknown' }; }
    },
    async retire(input: Readonly<{
      accountId: string; rpcContext: RpcHandlerContext; isCurrentInstallation(): boolean;
      /** Exact owned socket/material cleanup after launch authority withdrawal. */
      cleanupOwnedWork(): Promise<RetirementResult>;
    }>): Promise<RetirementResult> {
      const { rpcContext } = input, target = captureTarget(rpcContext);
      if (!target || !input.accountId || !rpcContext.transportRequestId) return { kind: 'incomplete' };
      const current = localCustody(target, rpcContext, input.isCurrentInstallation);
      if (!current()) return { kind: 'incomplete' };
      let cleanup: Promise<RetirementResult> | undefined;
      const cleanupOwnedWork = () => cleanup ??= input.cleanupOwnedWork();
      try {
        const outcome = await options.observeExecution({ actionId: 'machines.agentIsolation.set',
          input: memberIdentityRetirementInput(target, input.accountId),
          actionRequestId: `member-retirement:${rpcContext.transportRequestId}`, rpcContext,
          execute: async operation => {
            const operationId = operation.operationAcceptance?.operationId;
            if (!operationId) return { ok: false, errorCode: 'machine_setup_operation_unavailable', error: 'machine_setup_operation_unavailable' };
            operation.operationOwnerUpdate.update({ cancellation: 'supported' });
            const signal = AbortSignal.any([operation.signal, rpcContext.signal]);
            // Waiting for admitted work does not hold the native setup lock or
            // an elevated task. Existing lifecycle events own this settlement.
            const inventory = options.readActivityInventory();
            const boundary: RetirementResult = inventory ? await waitForRequesterMachineNaturalBoundary({ inventory, signal,
              isCurrentInstallation: current, excludeOperationId: operationId,
              requester: { serverId: options.serverId, accountId: input.accountId,
                machineId: target.machineId, installationId: target.installationId } }) : { kind: 'incomplete' };
            if (boundary.kind !== 'settled' || signal.aborted || !current())
              return { ok: false, errorCode: 'member_retirement_incomplete', error: 'Member execution cleanup needs owner setup recovery' };
            return machineNativeEffectAdmission.run({ operation: { operationId, kind: 'agentIsolationRetirement', signal },
              keys: [{ kind: 'machineSetup' }] }, async nativeEffectContext => {
              const owner = getLiveSystemTasksRunnerAdapter();
              let result: RetirementResult = { kind: 'incomplete' };
              const task = await startOwnerSetupTask({ target, operationId, ownerUpdate: operation.operationOwnerUpdate,
                verifyCurrent: current, run: async (context, elevation) => {
                result = await retireAgentIsolationMemberIdentity({
                  scope: { activeServerDir: options.activeServerDir, homeServerIdentityId: target.homeServerIdentityId,
                    machineId: target.machineId, installationId: target.installationId },
                  accountId: input.accountId, operationId, nativeEffectContext,
                  signal: context.signal ? AbortSignal.any([signal, context.signal]) : signal,
                  isCurrentInstallation: current, waitForNaturalBoundary: async () => boundary, cleanupOwnedWork,
                }, { ...options.effects, elevation });
                if (result.kind !== 'settled') throw new SystemTaskExecutionError(signal.aborted ? 'cancelled' : 'member_retirement_incomplete',
                  'Member execution cleanup needs owner setup recovery');
                return { operationId };
              } });
              operation.operationProgress.update({ phase: 'member_retirement', label: 'Retiring member execution' });
              const cancel = () => { void owner.cancel(task); };
              signal.addEventListener('abort', cancel, { once: true });
              if (signal.aborted) cancel();
              try {
                const settled = await owner.wait(task);
                return settled.ok && result.kind === 'settled' && current()
                  ? { ok: true, result: { kind: 'settled' } }
                  : { ok: false, errorCode: signal.aborted ? 'cancelled' : 'member_retirement_incomplete', error: 'Member execution cleanup needs owner setup recovery' };
              } finally { signal.removeEventListener('abort', cancel); }
            });
          },
        });
        return outcome.ok && current() ? { kind: 'settled' } : { kind: 'incomplete' };
      } catch { return { kind: 'incomplete' }; }
    },
  });
}

export type AgentIsolationMemberOperations = ReturnType<typeof createAgentIsolationMemberOperations>;
