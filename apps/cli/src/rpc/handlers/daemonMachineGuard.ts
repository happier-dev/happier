import { randomUUID } from 'node:crypto';
import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ActivityLog, ActivityLogListInput } from '@/daemon/guard/activityLog';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import type { createGuardWatch, GuardViewRequester } from '@/daemon/guard/view/guardWatch';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import type { RpcActionExecutorContext } from './_actionDispatchAdapter';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { MachineGuardKeepRunningInputV1Schema, MachineGuardKeepRunningResultV1Schema,
  MachineGuardSessionCeilingSetInputV1Schema, MachineGuardSessionCeilingSetResultV1Schema,
  type MachineGuardSessionCeilingSetResultV1 } from '@happier-dev/protocol/actions/specs/machineGuard';
import { MachineGuardActivityListInputV1Schema, MachineGuardActivityUndoInputV1Schema } from '@happier-dev/protocol/actions/specs/machineGuardActivity';
import { isMachineGuardRestorationWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { MachineGuardGetInputV1Schema, MachineGuardViewV1Schema, MachineGuardWatchInputV1Schema, MachineGuardWatchResultV1Schema,
  MachineGuardActivityWatchInputV1Schema, MachineGuardActivityWatchResultV1Schema } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';

export type DaemonMachineGuardRoutes = Readonly<{
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
  guard: Pick<ReturnType<typeof createGuardWatch>, 'readView' | 'watch'>;
  activity: ActivityLog;
  keepRunning: (input: Readonly<{ sessionId?: string; terminalKey?: string }>, requester: GuardViewRequester,
    signal?: AbortSignal, verifyCurrent?: () => Promise<boolean>) => Promise<Readonly<{ status: 'kept' | 'not_pending' }>>;
  /** The existing Session metadata owner and native scope owner apply one override together. */
  setSessionCeiling?: (input: Readonly<{ sessionId: string; bytes: number | null }>, requester: GuardViewRequester,
    signal?: AbortSignal, verifyCurrent?: () => Promise<boolean>) => Promise<MachineGuardSessionCeilingSetResultV1>;
  /** Receiving-host outer Action dispatch; never accepted from transported input. */
  dispatchUndoAction?: (input: unknown, context: RpcHandlerContext) => Promise<ActionExecuteResult>;
  nowMs?: () => number;
}>;
type GuardRestorationExecute = NonNullable<Parameters<NonNullable<ActionExecutorDeps['machineGuardAction']>>[0]['executeCanonicalAction']>;

export function registerDaemonMachineGuardRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineGuardRoutes): NonNullable<ActionExecutorDeps['machineGuardAction']> {
  const bindAdmission = (request: Readonly<{ serverId?: string; machineId: string }>, context: RpcHandlerContext | undefined, manage: boolean) => {
    const target = options.target();
    const admission = context?.machineAdmission;
    const deny = (predicate: RpcAdmissionPredicate) => { context?.reportAdmissionDenial?.(predicate); return false; };
    const matches = () => {
      const current = options.target();
      if (!target || !current || !admission) return deny('machine_admission');
      if (!admission.actorAccountId.trim()) return deny('machine_actor');
      if (current.serverId !== target.serverId) return deny('machine_home');
      if (current.machineId !== target.machineId) return deny('machine_target');
      if (current.installationId !== target.installationId) return deny('machine_installation');
      if (current.custodianAccountId !== target.custodianAccountId) return deny('machine_custodian');
      if (!doesMachineRpcTargetMatchAdmission(request, admission, target, context?.reportAdmissionDenial)) return false;
      if (admission.role !== 'use' && admission.role !== 'manage') return deny('machine_role');
      if (manage && (admission.role !== 'manage' || admission.actorAccountId !== target.custodianAccountId)) return deny('machine_custodian');
      if (context?.signal.aborted) return deny('request_cancelled');
      return true;
    };
    const verify = async () => {
      const verified = async () => context?.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent()
        || deny('machine_currentness');
      return Boolean(matches() && await verified() && matches());
    };
    const assertCurrent = async () => {
      if (!await verify()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
    };
    if (!matches()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
    if (!target || !admission || !context) throw new RpcError('Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
    const requester: GuardViewRequester = { serverId: target.serverId, accountId: admission.actorAccountId,
      machineId: target.machineId, installationId: target.installationId,
      isCustodian: admission.actorAccountId === target.custodianAccountId };
    return { target, context, requester, verify, assertCurrent };
  };
  // Effects keep their entry/effect checks. Passive reads already have the
  // dispatcher's Home admission and verify again only before disclosure.
  const admit = async (request: Readonly<{ serverId?: string; machineId: string }>, context: RpcHandlerContext | undefined, manage: boolean) => {
    const admitted = bindAdmission(request, context, manage);
    await admitted.assertCurrent();
    return admitted;
  };
  rpc.registerHandler(RPC_METHODS.MACHINES_GUARD_GET, async (raw: unknown, context?: RpcHandlerContext) => {
    const admitted = bindAdmission(MachineGuardGetInputV1Schema.parse(raw), context, false);
    try { return MachineGuardViewV1Schema.parse(await options.guard.readView(admitted.requester, context?.signal)); }
    finally { await admitted.assertCurrent(); }
  });
  rpc.registerHandler(RPC_METHODS.DAEMON_GUARD_WATCH, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineGuardWatchInputV1Schema.parse(raw);
    const admitted = bindAdmission(request, context, false);
    try { return MachineGuardWatchResultV1Schema.parse(await options.guard.watch({ ...request, serverId: admitted.target.serverId }, admitted.requester, context?.signal)); }
    finally { await admitted.assertCurrent(); }
  });
  const readActivity = (request: Pick<ActivityLogListInput, 'range' | 'filter'>, requester: GuardViewRequester) => options.activity.list({
    range: request.range, ...(request.filter ? { filter: request.filter } : {}),
    ...(!requester.isCustodian ? { requester: { serverId: requester.serverId, accountId: requester.accountId,
      machineId: requester.machineId, installationId: requester.installationId } } : {}),
  });
  rpc.registerHandler(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineGuardActivityListInputV1Schema.parse(raw);
    const admitted = bindAdmission(request, context, false);
    try {
      return await readActivity(request, admitted.requester);
    } finally { await admitted.assertCurrent(); }
  });
  rpc.registerHandler(RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineGuardActivityWatchInputV1Schema.parse(raw);
    const admitted = bindAdmission(request, context, false);
    try {
      const answer = await parkWatch({ signal: context?.signal,
        isNewer: () => request.since !== options.activity.revision(),
        subscribe: options.activity.subscribe, read: options.activity.revision });
      return MachineGuardActivityWatchResultV1Schema.parse(answer.changed ? {
        changed: true, since: answer.snapshot, list: await readActivity(request, admitted.requester),
      } : { changed: false });
    } finally { await admitted.assertCurrent(); }
  });
  rpc.registerHandler(RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineGuardKeepRunningInputV1Schema.parse(raw);
    const admitted = await admit(request, context, true);
    const result = await options.keepRunning(request, admitted.requester, context?.signal, admitted.verify);
    await admitted.assertCurrent();
    return MachineGuardKeepRunningResultV1Schema.parse(result);
  });
  rpc.registerHandler(RPC_METHODS.MACHINES_GUARD_SESSION_CEILING_SET, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineGuardSessionCeilingSetInputV1Schema.parse(raw);
    const admitted = await admit(request, context, true);
    if (!options.setSessionCeiling) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const result = await options.setSessionCeiling({ sessionId: request.sessionId, bytes: request.bytes }, admitted.requester,
      context?.signal, admitted.verify);
    await admitted.assertCurrent();
    return MachineGuardSessionCeilingSetResultV1Schema.parse(result);
  });
  const undo = async (raw: unknown, context: RpcHandlerContext, executeCanonicalAction: GuardRestorationExecute) => {
    const request = MachineGuardActivityUndoInputV1Schema.parse(raw);
    const admitted = await admit(request, context, true);
    const entry = await options.activity.read(request.entryId);
    await admitted.assertCurrent();
    const wayBack = entry?.undoneAt === undefined ? entry?.wayBack?.find(isMachineGuardRestorationWayBackV1) : undefined;
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    if (!wayBack) return failure('activity_entry_unavailable');
    const spec = getActionSpec(wayBack.actionId);
    const recordedInput = wayBack.input;
    // Activity omits local Home aliases; terminal reopening needs the currently admitted target.
    const boundInput = wayBack.actionId === 'machines.terminal.open'
      && recordedInput !== null && typeof recordedInput === 'object' && !Array.isArray(recordedInput)
      && !('serverId' in recordedInput)
      ? { ...recordedInput, serverId: admitted.target.serverId }
      : recordedInput;
    const input = spec.inputSchema.safeParse(boundInput);
    if (!input.success) return failure('invalid_action_input');
    await admitted.assertCurrent();
    const result = await executeCanonicalAction(wayBack.actionId, input.data);
    await admitted.assertCurrent();
    if (!result.ok) return result;
    const nestedFailure = ActionExecuteFailureSchema.safeParse(result.result);
    if (nestedFailure.success) return nestedFailure.data;
    const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (deferred.success) return deferred.data.actionId === wayBack.actionId
      ? deferred.data : failure('invalid_action_output');
    const output = spec.outputSchema?.safeParse(result.result);
    if (!output?.success) return failure('invalid_action_output');
    // These original owners encode native refusal inside a valid result, not an Action failure envelope.
    if (wayBack.actionId === 'browser.view.open'
      && BrowserCommandDispatchResultV1Schema.parse(output.data).status !== 'dispatched') return output.data;
    if (wayBack.actionId === 'localServices.launcher.start'
      && DaemonLocalServiceLauncherStartResponseV1Schema.parse(output.data).status !== 'succeeded') return output.data;
    await admitted.assertCurrent();
    await options.activity.markUndone({ id: randomUUID(), at: (options.nowMs ?? Date.now)(), ref: entry!.id,
      attribution: { serverId: admitted.target.serverId, accountId: admitted.requester.accountId,
        machineId: admitted.target.machineId, installationId: admitted.target.installationId } });
    await admitted.assertCurrent();
    return output.data;
  };
  rpc.registerHandler(RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineGuardActivityUndoInputV1Schema.parse(raw);
    const admitted = await admit(request, context, true);
    if (!options.dispatchUndoAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const result = await options.dispatchUndoAction(request, admitted.context);
    await admitted.assertCurrent();
    return result.ok ? result.result : result;
  });
  return async args => {
    if (args.actionId !== 'machines.guard.activity.undo' || !args.executeCanonicalAction) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    }
    // The receiving host retains these private ingress facts; domain admission validates them before use.
    const context = args.context as RpcActionExecutorContext;
    return undo(args.input, { ...context, signal: args.signal ?? context.signal ?? new AbortController().signal }, args.executeCanonicalAction);
  };
}
