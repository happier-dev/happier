import axios from 'axios';

import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionMachineRpcExecutionV1, ExternalActionRequestEnvelope, ExternalActionTargetV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

export type ExternalActionMachineRequestSigningKey = string | Uint8Array;

/**
 * The device-local profile id routes a request to one Home, while the observed
 * stable identity binds Home-issued authorization. They are deliberately
 * independent because a profile id is not cryptographic identity evidence.
 */
export type ExternalActionHomeBinding = Readonly<{
  serverId?: string;
  serverIdentityId?: string;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
}>;

export function createExternalActionMachineRpcExecution(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  installationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const authorization = input.context?.externalActionExecutionAuthorization;
  const target = input.context?.externalActionTarget;
  if (!authorization || !target || !input.requestId) return null;
  const effectActionId = ExternalActionActionIdV1Schema.parse(input.effectActionId);
  return {
    v: 1,
    authorization,
    effectActionId,
    target,
    installationId: input.installationId,
    machineSignature: signExternalActionMachineRpcRequestV1({
      authorizationToken: authorization.token,
      effectActionId,
      target,
      installationId: input.installationId,
      event: SOCKET_RPC_EVENTS.CALL,
      method: input.method,
      requestId: input.requestId,
      ...(input.params === undefined ? {} : { params: input.params }),
      privateKey: input.privateKey,
    }),
  };
}

type ExternalActionAuthorizationHttpFailure = Readonly<{
  ok: false;
  code: 'invalid_token' | 'auth_unavailable' | 'server_unavailable';
}>;

export type ExternalActionAuthorizationHttpResult =
  | Readonly<{ ok: true; authorization: ExternalActionExecutionAuthorizationV1 }>
  | ExternalActionAuthorizationHttpFailure;

export function createExternalActionAuthorizedRequestHeaders(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  method: string;
  path: string;
  body?: unknown;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): Readonly<Record<string, string>> {
  return {
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorization.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(input.target),
    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
      authorizationToken: input.authorization.token,
      effectActionId: input.effectActionId,
      target: input.target,
      installationId: input.installationId,
      requestId: input.authorization.binding.requestId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      privateKey: input.privateKey,
    }),
  };
}

export function resolveExternalActionServerRequestHeaders(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  method: string;
  path: string;
  body?: unknown;
  daemonToken: string;
  serverIdentityId?: string;
  privateKey?: ExternalActionMachineRequestSigningKey;
  installationId?: string;
}>): Readonly<{ ok: true; headers: Readonly<Record<string, string>> }> | Readonly<{ ok: false }> {
  const authorization = input.context?.externalActionExecutionAuthorization;
  if (!authorization) {
    // Public Action execution never falls through to the daemon credential.
    // A direct PAT request may still complete daemon-local work while its Home
    // is unreachable, but any Home-bound effect remains closed.
    if (input.context?.externalActionCredential) return { ok: false };
    return { ok: true, headers: { Authorization: `Bearer ${input.daemonToken}` } };
  }
  if (
    !input.privateKey
    || !input.installationId
    || !input.context?.externalActionTarget
    || authorization.binding.serverIdentityId !== input.serverIdentityId
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    headers: createExternalActionAuthorizedRequestHeaders({
      authorization,
      effectActionId: input.effectActionId,
      target: input.context.externalActionTarget,
      installationId: input.installationId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      privateKey: input.privateKey,
    }),
  };
}

export async function mintExternalActionExecutionAuthorization(input: Readonly<{
  actionId: string;
  envelope: ExternalActionRequestEnvelope;
  machineId: string;
  pat: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>): Promise<ExternalActionAuthorizationHttpResult> {
  const path = bindExternalActionExecutionAuthorizationHttpPathV1(input.actionId);
  let response;
  try {
    response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}${path}`,
      { v: 1, machineId: input.machineId, envelope: input.envelope },
      {
        headers: { Authorization: `Bearer ${input.pat}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
        ...(input.signal ? { signal: input.signal } : {}),
        validateStatus: () => true,
      },
    );
  } catch {
    return { ok: false, code: 'server_unavailable' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'invalid_token' };
  }
  if ([404, 405, 501].includes(response.status)) {
    return { ok: false, code: 'server_unavailable' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: 'auth_unavailable' };
  }
  const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
  return authorization.success
    ? { ok: true, authorization: authorization.data }
    : { ok: false, code: 'auth_unavailable' };
}

export async function verifyExternalActionExecutionAuthorizationCurrent(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  privateKey: ExternalActionMachineRequestSigningKey;
  installationId: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(
    input.authorization.binding.actionId,
  );
  const body = { v: 1 as const };
  const headers = createExternalActionAuthorizedRequestHeaders({
    authorization: input.authorization,
    effectActionId: input.effectActionId,
    target: input.target,
    installationId: input.installationId,
    method: 'POST',
    path,
    body,
    privateKey: input.privateKey,
  });
  try {
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: 15_000,
      ...(input.signal ? { signal: input.signal } : {}),
      validateStatus: () => true,
    });
    return response.status >= 200
      && response.status < 300
      && ExternalActionExecutionAuthorizationVerifyResponseV1Schema.safeParse(response.data).success;
  } catch {
    return false;
  }
}
