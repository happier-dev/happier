import { SessionHandoffCapabilityV3Schema, SessionHandoffExistingStateCheckResponseV3Schema,
  type SessionHandoffExistingStateCheckRequestV3 } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { prepareExternalActionHandoffPreflightAuthorization, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';

type Failure = Readonly<{ ok: false; errorCode: string; error: string }>;
type MachineCall = typeof callMachineRpc;

type PreflightMachineRpcInput = Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  method: typeof RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET | typeof RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3;
  request: SessionHandoffExistingStateCheckRequestV3;
  context?: RpcActionExecutorContext;
  signal?: AbortSignal;
}>;

const updateRequired = (): Failure => ({ ok: false, errorCode: 'handoff_existing_state_update_required',
  error: 'Existing session state requires a newer daemon. Turn session data transfer on.' });
const unavailable = (): Failure => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });

/** Read-only handoff transport shared by tracked and direct source admission. */
export function createSessionHandoffPreflightMachineRpc(deps: Readonly<{
  callMachine?: MachineCall;
  authorization?: Readonly<{
    serverHttpBaseUrl: string;
    readSourceInstallation(): Readonly<{ machineId: string; installationId: string; privateKey: ExternalActionMachineRequestSigningKey }> | null;
  }>;
}>) {
  const callMachine = deps.callMachine ?? callMachineRpc;
  return async (input: PreflightMachineRpcInput): Promise<unknown> => {
    const requester = input.context?.requesterSessionBootstrap;
    const execute = async (): Promise<unknown> => {
      const signal = input.signal ?? input.context?.signal;
      signal?.throwIfAborted();
      if (requester && !await requester.isCurrent()) return unavailable();
      const root = input.context?.externalActionExecutionAuthorization;
      if (input.context?.callerInputAuthorization && !root) return unavailable();
      const request = input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3
        ? SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema.parse({
            kind: 'requester_session_handoff_preflight_bootstrap_v1', input: input.request,
            requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(input.credentials) },
          }) : input.request;
      let externalAction: Parameters<MachineCall>[0]['externalAction'];
      if (root) {
        const boundary = deps.authorization;
        const signer = boundary?.readSourceInstallation();
        const admission = root.binding.handoffAdmission;
        if (!boundary || !signer || !admission || admission.sessionId !== input.request.sessionId
          || admission.sourceMachineId !== input.request.sourceMachineId || admission.targetMachineId !== input.request.targetMachineId
          || signer.machineId !== admission.sourceMachineId || signer.installationId !== admission.sourceInstallationId
          || ![admission.sourceMachineId, admission.targetMachineId].includes(input.machineId)
          || input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3 && input.machineId !== admission.targetMachineId) return unavailable();
        const child = await prepareExternalActionHandoffPreflightAuthorization({ authorization: root, input: request,
          machineId: input.machineId, sourceMachineId: signer.machineId, sourceInstallationId: signer.installationId,
          privateKey: signer.privateKey, serverHttpBaseUrl: boundary.serverHttpBaseUrl,
          ...(input.credentials.encryption?.type === 'dataKey' ? { material: input.credentials.encryption } : {}),
          ...(signal ? { signal } : {}),
        });
        const authorization = child && requester
          ? await requester.projectExternalActionAuthorization(child, child.binding.serverIdentityId, signal) : child;
        const currentSigner = boundary.readSourceInstallation();
        if (!authorization || !currentSigner || currentSigner.machineId !== signer.machineId
          || currentSigner.installationId !== signer.installationId || requester && !await requester.isCurrent()) return unavailable();
        externalAction = { context: { ...input.context, authority: 'account_automation',
          defaultSessionMachineId: signer.machineId, externalActionTarget: authorization.binding.target,
          externalActionExecutionAuthorization: authorization }, effectActionId: 'session.handoff',
          installationId: signer.installationId, privateKey: signer.privateKey };
      }
      signal?.throwIfAborted();
      try {
        return await callMachine({ credentials: input.credentials, machineId: input.machineId, method: input.method, request,
          ...(externalAction ? { externalAction, authorityCeiling: 'account_automation' as const } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return updateRequired();
        throw error;
      }
    };
    return requester ? await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, execute) : await execute();
  };
}

/** Both peers and native target state are proven before either source entry point claims custody. */
export async function admitSessionHandoffExistingState(input: Readonly<{
  credentials: StoredCredentials;
  request: SessionHandoffExistingStateCheckRequestV3;
  context?: RpcActionExecutorContext;
  rpc: ReturnType<typeof createSessionHandoffPreflightMachineRpc>;
  signal?: AbortSignal;
}>): Promise<Failure | null> {
  const signal = input.signal ?? input.context?.signal;
  const { rpc, ...transportInput } = input;
  for (const machineId of new Set([input.request.sourceMachineId, input.request.targetMachineId])) {
    signal?.throwIfAborted();
    const raw = await rpc({ ...transportInput, machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET });
    signal?.throwIfAborted();
    const failure = SessionHandoffExistingStateCheckResponseV3Schema.safeParse(raw);
    if (failure.success && !failure.data.ok) return { ok: false, errorCode: failure.data.errorCode, error: failure.data.error ?? failure.data.errorCode };
    const capability = SessionHandoffCapabilityV3Schema.safeParse(raw);
    if (!capability.success || capability.data.existingState !== true) return updateRequired();
  }
  const checked = SessionHandoffExistingStateCheckResponseV3Schema.safeParse(await rpc({ ...transportInput,
    machineId: input.request.targetMachineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3,
  }));
  signal?.throwIfAborted();
  if (!checked.success) return { ok: false, errorCode: 'session_handoff_existing_state_check_invalid',
    error: 'The target could not verify existing session state. Turn session data transfer on.' };
  return checked.data.ok ? null : { ok: false, errorCode: checked.data.errorCode, error: checked.data.error ?? checked.data.errorCode };
}
