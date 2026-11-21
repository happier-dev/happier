import { decodeBase64 } from '../../crypto/base64.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import { projectExternalActionMachineRuntimeDemandV1 } from '../actionSpecs.js';
import {
  bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionHttpErrorSchema, projectExternalActionHttpFailureV1,
  type ExternalActionExecutionAuthorizationRequestV1, type ExternalActionSignedAuthenticationV1,
} from '../externalActionApi.js';
import { isExternalActionAuthorizationBoundToEnvelope } from '../externalActionExecutionAuthorization.js';
import { openExternalActionResponseV2, sealExternalActionRequestV2 } from '../externalActionEncryption.js';
import { sealManagedControllerActionCodecV1 } from '../../sessions/creation/sessionRequesterBootstrapV1.js';
import { ACTION_OPERATION_CANCEL_ACTION_ID_V1, ACTION_OPERATION_GET_ACTION_ID_V1 } from './actionIdsV1.js';
import { ActionOperationAddressV1Schema } from './addressV1.js';
import { ActionOperationGetActionInputV1Schema } from '../specs/actionOperations.js';

export function readRequesterOperationAddressV1(actionId: string, input: unknown) {
  if (actionId !== ACTION_OPERATION_GET_ACTION_ID_V1) return null;
  const parsed = ActionOperationGetActionInputV1Schema.safeParse(input);
  return parsed.success && !parsed.data.managed && !parsed.data.environmentId ? parsed.data : null;
}

export function readRequesterOperationRequestV1(actionId: string, input: unknown) {
  if (actionId === ACTION_OPERATION_CANCEL_ACTION_ID_V1) {
    const parsed = ActionOperationAddressV1Schema.safeParse(input);
    return parsed.success ? { actionId, input: parsed.data } as const : null;
  }
  const address = readRequesterOperationAddressV1(actionId, input);
  return address ? { actionId: ACTION_OPERATION_GET_ACTION_ID_V1, input: address } as const : null;
}

export type RequesterOperationRequestV1 = NonNullable<ReturnType<typeof readRequesterOperationRequestV1>>;

type RequesterOperationTransport = Readonly<{
  accountId: string;
  serverIdentityId: string;
  tokenEpoch: number;
  authenticationKind?: ExternalActionSignedAuthenticationV1['kind'];
  requestId: string;
  randomBytes(length: number): Uint8Array;
  request(path: string, body: ExternalActionExecutionAuthorizationRequestV1): Promise<Readonly<{ status: number; value: unknown }>>;
  /**
   * The reader's own decode of the executor's E2EE Machine content: its pin, null when that content
   * publishes no key, or undefined when the reader cannot open it (the key then stays Home-vouched).
   */
  readExecutorKeyPin?(machineId: string): Promise<InstallationKeyPinV1 | null | undefined>;
}>;

export function readRequesterActionOperationV1(params: RequesterOperationTransport & Readonly<{
  input: NonNullable<ReturnType<typeof readRequesterOperationAddressV1>>;
}>): Promise<ActionExecuteResult | null> {
  return executeRequesterActionOperationV1({ ...params, actionId: ACTION_OPERATION_GET_ACTION_ID_V1 });
}

/** Reuse the installed carrier and its one-use codec for exact requester operations. */
export async function executeRequesterActionOperationV1(params: RequesterOperationTransport & RequesterOperationRequestV1): Promise<ActionExecuteResult | null> {
  const { actionId } = params;
  const target = { kind: 'machine' as const, machineId: params.input.machineId };
  const authentication = { kind: params.authenticationKind ?? 'account', tokenEpoch: params.tokenEpoch };
  const binding = { actionId, target, accountId: params.accountId, requestId: params.requestId,
    serverIdentityId: params.serverIdentityId, authentication };
  const material = { type: 'dataKey' as const, machineKey: params.randomBytes(32) };
  const envelope = { ...sealExternalActionRequestV2({ binding, material,
    projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
    randomBytes: params.randomBytes, input: projectNativeJsonValueForTransport({ ...params.input, serverId: params.serverIdentityId }) }),
    requesterOperationRead: true as const };
  const body = { v: 1 as const, machineId: target.machineId, envelope };
  const refusal = (value: unknown) => {
    const parsed = ExternalActionHttpErrorSchema.safeParse(value);
    return parsed.success && (!('requestId' in parsed.data) || parsed.data.requestId === undefined || parsed.data.requestId === params.requestId)
      ? projectExternalActionHttpFailureV1(parsed.data) : null;
  };
  const unavailable = { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  const minted = await params.request(bindExternalActionExecutionAuthorizationHttpPathV1(actionId), body);
  if (minted.status !== 200) {
    const failed = refusal(minted.value);
    // The 0.2 Home has no Action authorization endpoint. Keep its exact Machine RPC.
    return minted.status === 404 && !failed ? null : failed ?? unavailable;
  }
  const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(minted.value);
  if (!authorization.success) return unavailable;
  const root = authorization.data.binding;
  const key = authorization.data.requesterOperationReadInstallationPublicKey;
  if (!root.requesterOperationRead || !key || root.accountId !== params.accountId || root.serverIdentityId !== params.serverIdentityId
    || !('authentication' in root) || root.authentication.kind !== authentication.kind
    || root.authentication.tokenEpoch !== authentication.tokenEpoch
    || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId, machineId: target.machineId, envelope })) return unavailable;
  // The installation public key is needed only by the caller. The receiver
  // opens this message with its private key and verifies the signed binding.
  const { requesterOperationReadInstallationPublicKey: _key, ...signed } = authorization.data;
  const executionAuthorization = sealManagedControllerActionCodecV1({ authorization: signed,
    material, installationPublicKey: decodeBase64(key, 'base64url'), randomBytes: params.randomBytes });
  const result = await params.request(`/v1/actions/${actionId}`, { ...body, executionAuthorization });
  if (result.status !== 200) return refusal(result.value) ?? unavailable;
  return openExternalActionResponseV2({ envelope: result.value, request: envelope, binding, material })
    ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}
