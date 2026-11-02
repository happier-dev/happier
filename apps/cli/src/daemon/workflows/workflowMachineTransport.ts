import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcLocalActionContext } from '../../api/rpc/types';
import type { StoredCredentials } from '../../persistence';
import type { MachineActionDirectTargetTransport } from '../../session/actions/createCliActionDeps';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { prepareRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import { readRequesterHomeWithinActionLifetime } from '../sessionEncryption/requesterCurrentness';

/** One claimed Workflow retains requester custody through its installed Machine transport. */
export function createWorkflowRunMachineTransport(input: Readonly<{
  runId: string;
  credentials: StoredCredentials;
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  boundary: Readonly<{
    serverId: string;
    serverHttpBaseUrl: string;
    happyHomeDir: string;
    getObservedServerIdentityId(): string | null | Promise<string | null>;
  }>;
  isCurrent(): Promise<boolean>;
  signal?: AbortSignal;
  transport: MachineActionDirectTargetTransport;
}>): Readonly<{ transport: MachineActionDirectTargetTransport; dispose(): Promise<void> }> {
  let requester: ReturnType<typeof prepareRequesterSessionBootstrap> | undefined;
  const prepare = async (local: Pick<RpcLocalActionContext, 'executionRunWorkflowRunId' | 'requesterWorkAttributionV1'>) => {
    const expected = input.requesterWorkAttributionV1;
    const stamp = local.requesterWorkAttributionV1;
    if (!expected || local.executionRunWorkflowRunId !== input.runId
      || stamp?.accountId !== expected.accountId || stamp.serverId !== input.boundary.serverId
      || stamp.machineId !== input.transport.machineId || stamp.installationId !== expected.installationId
      || !await input.isCurrent()) return null;
    requester ??= readRequesterHomeWithinActionLifetime(async () => {
      const homeServerIdentityId = await input.boundary.getObservedServerIdentityId();
      if (!homeServerIdentityId) return null;
      const { prepareRequesterSessionBootstrap } = await import('../sessionEncryption/requesterSessionCredentials');
      return await prepareRequesterSessionBootstrap({
      credentials: input.credentials, attribution: expected, homeServerIdentityId, boundary: input.boundary,
      verifyMachineAdmissionCurrent: input.isCurrent,
      ...(input.signal ? { signal: input.signal } : {}),
      });
    }, input.signal);
    const prepared = await requester;
    return prepared && await prepared.admitted.isCurrent() ? prepared : null;
  };
  return {
    transport: {
      machineId: input.transport.machineId,
      ...(input.transport.machineServiceAction ? { machineServiceAction: async request => {
        if (request.context.executionRunWorkflowRunId && !await prepare(request.context)) {
          return { kind: 'unavailable' as const, reason: 'admission_unavailable' as const };
        }
        return await input.transport.machineServiceAction!(request);
      } } : {}),
      invoke: async (method, request, options) => {
        const local = options?.localActionContext;
        if (!local?.executionRunWorkflowRunId) return await input.transport.invoke(method, request, options);
        const prepared = await prepare(local);
        if (!prepared) return { ok: false, errorCode: 'project_requester_credentials_unavailable',
          error: 'Workflow requester authority unavailable',
          ...(method === SESSION_RPC_METHODS.EXECUTION_RUN_START
            ? { details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') } : {}) };
        return await input.transport.invoke(method, request, { ...options,
          rpcContext: { requesterSessionBootstrap: prepared.admitted, callerAuthority: 'account_automation',
            verifyMachineAdmissionCurrent: input.isCurrent } });
      },
    },
    dispose: async () => { await (await requester)?.cleanupOnFailure(); },
  };
}
