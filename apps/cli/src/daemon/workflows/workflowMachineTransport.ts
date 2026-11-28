import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ScmComparisonCaptureInputSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import type { RpcLocalActionContext } from '../../api/rpc/types';
import type { StoredCredentials } from '../../persistence';
import type { MachineActionDirectTargetTransport } from '../../session/actions/createCliActionDeps';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { prepareRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import { readRequesterHomeWithinActionLifetime } from '../sessionEncryption/requesterCurrentness';
import { requiresWorkflowMachineActionAdmission } from '../../session/actions/cliActionDeps/machineTransport';

function isDetachedComparisonCapture(request: unknown, machineId: string): boolean {
  if (request && typeof request === 'object' && 'kind' in request && request.kind === 'targeted_action_rpc') {
    const envelope = TargetedActionRpcRequestV1Schema.safeParse(request);
    if (!envelope.success || envelope.data.target.kind !== 'machine' || envelope.data.target.machineId !== machineId
      || envelope.data.pluginCaller) return false;
    // defaultSessionId is invoking context (including this Run's origin), not
    // an execution target. The explicit Machine and capture source decide that.
    request = envelope.data.input;
  }
  const capture = ScmComparisonCaptureInputSchema.safeParse(request);
  if (!capture.success || capture.data.sessionId !== undefined) return false;
  const source = capture.data.source;
  return source?.kind !== 'session' && source?.kind !== 'turnCheckpoint';
}

/** One claimed Workflow retains requester custody through its installed Machine transport. */
export function createWorkflowRunMachineTransport(input: Readonly<{
  runId: string;
  credentials: StoredCredentials;
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  machineAdmission?: SocketRpcMachineAdmissionContextV1;
  boundary: Readonly<{
    serverId: string;
    serverHttpBaseUrl: string;
    happyHomeDir: string;
    getObservedServerIdentityId(): string | null | Promise<string | null>;
  }>;
  isCurrent(): Promise<boolean>;
  signal?: AbortSignal;
  transport: MachineActionDirectTargetTransport;
  runActionOperation?: ActionExecutorDeps['runActionOperation'];
}>): Readonly<{
  transport: MachineActionDirectTargetTransport;
  runActionOperation?: ActionExecutorDeps['runActionOperation'];
  resolveSavedSecretOperationContext(): Promise<import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1 | null>;
  resolveActionRequesterContext(): Promise<Pick<import('@happier-dev/protocol').ActionExecutorContext,
    'machineAdmission' | 'verifyMachineAdmissionCurrent'> | null>;
  dispose(): Promise<void>;
}> {
  const { machineAdmission } = input;
  let requester: ReturnType<typeof prepareRequesterSessionBootstrap> | undefined;
  const prepare = async (local: Pick<RpcLocalActionContext, 'executionRunWorkflowRunId' | 'requesterWorkAttributionV1'>) => {
    const expected = input.requesterWorkAttributionV1;
    const stamp = local.requesterWorkAttributionV1;
    if (!expected || local.executionRunWorkflowRunId !== input.runId
      || stamp?.accountId !== expected.accountId || stamp.serverId !== input.boundary.serverId
      || stamp.machineId !== input.transport.machineId || stamp.installationId !== expected.installationId
      || machineAdmission && (machineAdmission.actorAccountId !== expected.accountId
        || machineAdmission.machineId !== expected.machineId || machineAdmission.installationId !== expected.installationId)
      || !await input.isCurrent()) return null;
    requester ??= readRequesterHomeWithinActionLifetime(async () => {
      const { prepareRequesterSessionBootstrap } = await import('../sessionEncryption/requesterSessionCredentials');
      // Null denotes an admitted assignment without a recorded role. The
      // settings bootstrap may not inherit a role from earlier custody.
      return await prepareRequesterSessionBootstrap({
        credentials: input.credentials, attribution: expected, boundary: input.boundary,
        machineAdmission: machineAdmission ?? null,
        verifyMachineAdmissionCurrent: input.isCurrent,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }, input.signal);
    const prepared = await requester;
    return prepared && await prepared.admitted.isCurrent() ? prepared : null;
  };
  return {
    ...(input.runActionOperation ? { runActionOperation: async (request: Parameters<NonNullable<ActionExecutorDeps['runActionOperation']>>[0]) => {
      // The signed receiver owns this child's Operation. Opening it here makes
      // the receiver join the invocation that is waiting for its own response.
      if (requiresWorkflowMachineActionAdmission(request.actionId, request.context)) return request.execute(request.context);
      const prepared = await prepare(request.context);
      if (!prepared) return { ok: false as const, errorCode: 'project_requester_credentials_unavailable' as const,
        error: 'Workflow requester authority unavailable' };
      const context = { ...request.context, requesterSessionBootstrap: prepared.admitted,
        verifyMachineAdmissionCurrent: input.isCurrent };
      return await input.runActionOperation!({ ...request, context });
    } } : {}),
    resolveSavedSecretOperationContext: async () => {
      const prepared = await prepare({ executionRunWorkflowRunId: input.runId,
        requesterWorkAttributionV1: input.requesterWorkAttributionV1 });
      return prepared?.admitted.savedSecretOperationContext ?? null;
    },
    resolveActionRequesterContext: async () => {
      const prepared = await prepare({ executionRunWorkflowRunId: input.runId,
        requesterWorkAttributionV1: input.requesterWorkAttributionV1 });
      return prepared ? { machineAdmission, verifyMachineAdmissionCurrent: input.isCurrent } : null;
    },
    transport: {
      machineId: input.transport.machineId,
      workflowRunId: input.runId,
      ...(input.transport.machineServiceAction ? { machineServiceAction: async request => {
        if (request.context.executionRunWorkflowRunId && !await prepare(request.context)) {
          return { kind: 'unavailable' as const, reason: 'admission_unavailable' as const };
        }
        return await input.transport.machineServiceAction!(request);
      } } : {}),
      // A Restart step reboots its own Machine at the installed lifecycle owner
      // with the Run's captured Home admission, as invoke does. Machine RPC would
      // drop the stamped Run id that excludes this Run's own live work.
      ...(input.transport.machineReboot ? { machineReboot: async request => {
        const prepared = await prepare(request.context);
        if (!prepared || !machineAdmission) return { kind: 'unavailable' as const, reason: 'admission_unavailable' as const };
        return await input.transport.machineReboot!({ ...request, context: { ...request.context,
          machineAdmission, verifyMachineAdmissionCurrent: input.isCurrent } });
      } } : {}),
      invoke: async (method, request, options) => {
        // Startup observation and retained-operation recovery already belong to
        // this captured Run, even when they have no local Action context.
        const local = options?.localActionContext ?? (input.requesterWorkAttributionV1 ? {
          executionRunWorkflowRunId: input.runId, requesterWorkAttributionV1: input.requesterWorkAttributionV1,
        } : undefined);
        const differentRun = options?.executionRunWorkflowRunId !== undefined
          && options.executionRunWorkflowRunId !== input.runId;
        if (!local && !differentRun) return await input.transport.invoke(method, request, options);
        const prepared = differentRun || !local ? null : await prepare(local);
        if (!prepared && method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
          return { ok: false, code: 'project_requester_credentials_unavailable', actionHandlerInvocation: 'notStarted' };
        }
        if (!prepared) return { ok: false, errorCode: 'project_requester_credentials_unavailable',
          error: 'Workflow requester authority unavailable',
          ...(method === SESSION_RPC_METHODS.EXECUTION_RUN_START
            ? { details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') } : {}) };
        const caller = options?.localActionContext?.actionCaller;
        // The claimed host Run already owns this detached read on the custodian's
        // Machine. SCM still owns repository and native execution placement.
        const admittedComparison = method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE
          && caller?.kind === 'workflowRun' && caller.runId === input.runId && caller.authorization.principal.kind === 'host'
          && !options?.rpcContext?.sessionActionOrigin
          && machineAdmission?.role === 'manage'
          && machineAdmission.actorAccountId === machineAdmission.custodianAccountId
          && isDetachedComparisonCapture(request, input.transport.machineId);
        // The Run's captured Home admission is the receiving Machine admission
        // native owners require, as Home's stamp is for the same direct Action.
        return await input.transport.invoke(method, request, { ...options,
          ...(admittedComparison ? { admissionResult: { ok: true as const, admittedHostWorkflowRequester: machineAdmission } } : {}),
          rpcContext: { requesterSessionBootstrap: prepared.admitted, callerAuthority: 'account_automation',
            machineAdmission, verifyMachineAdmissionCurrent: input.isCurrent } });
      },
    },
    dispose: async () => { await (await requester)?.cleanupOnFailure(); },
  };
}
