import axios from '@/api/client/credentialAxios';
import type { ApiMachineClient } from '@/api/apiMachine';
import { resolveExternalActionServerRequestHeaders, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineSetupTargetUnavailableFailureV1 } from '@happier-dev/protocol/actions/operations/v1';

/** Setup is Machine administration; these diagnostics contain no native or Account data. */
export function machineSetupTargetUnavailable(branch: MachineSetupTargetUnavailableFailureV1['branch'],
  reason?: MachineSetupTargetUnavailableFailureV1['reason']): ActionExecuteFailure {
  return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    details: { kind: 'machineSetup', failure: { kind: 'target_unavailable',
      phase: 'machine_setup_target', branch, ...(reason ? { reason } : {}) } } };
}

export type MachineSetupInstallation = Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }>;

/** Plan and Apply certify copies at the same Home route and signing boundary. */
export async function requestMachineSetupHome(input: Readonly<{
  runtime: NonNullable<Awaited<ReturnType<ApiMachineClient['resolveMachineSetupRuntime']>>>;
  context: RpcActionExecutorContext;
  installation: MachineSetupInstallation;
  homeId: string;
  actionId: 'machines.setup.plan' | 'machines.setup.apply' | 'machines.setup.remove';
  path: string;
  body: unknown;
  signal?: AbortSignal;
}>): Promise<unknown> {
  if (!await input.runtime.isCustodyCurrent()) throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
  const headers = resolveExternalActionServerRequestHeaders({ context: input.context, effectActionId: input.actionId,
    method: 'POST', path: input.path, body: input.body, daemonToken: input.runtime.credentials.token,
    serverIdentityId: input.homeId, privateKey: input.installation.privateKey, installationId: input.installation.installationId });
  if (!headers.ok) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
  const response = await axios.post<unknown>(`${input.runtime.serverHttpBaseUrl}${input.path}`, input.body, {
    headers: headers.headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('machine_setup_request_failed'), { code: 'machine_setup_request_failed' });
  return response.data;
}
