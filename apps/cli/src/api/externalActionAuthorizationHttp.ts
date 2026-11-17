import axios from '@/api/client/credentialAxios';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionHttpErrorSchema, ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1, type ExternalActionExecutionAuthorizationRequestV1, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { refuseExternalActionPhase, readSessionInputAdmissionDiagnostic } from '@/daemon/externalActions/externalActionPhase';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { projectExternalActionHttpFailureV1, type ExternalActionHttpErrorCode } from '@happier-dev/protocol/actions/externalActionHttpError';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

type ExternalActionAuthorizationHttpFailure = Pick<ActionExecuteFailure, 'details' | 'failureCause' | 'requestId'> & Readonly<{
  ok: false;
  code: ExternalActionHttpErrorCode;
  /** Private preparation fact; HTTP adapters still project only their existing code. */
  retryable?: true;
  diagnostic?: MachineAvailabilityDiagnosticV1;
}>;

export type ExternalActionAuthorizationHttpResult =
  | Readonly<{ ok: true; authorization: ExternalActionExecutionAuthorizationV1 }>
  | ExternalActionAuthorizationHttpFailure;

export async function mintExternalActionExecutionAuthorization(input: Readonly<{
  actionId: string;
  envelope: ExternalActionRequestEnvelope;
  machineId: string;
  pat: string;
  serverHttpBaseUrl: string;
  authorityCeiling?: 'account_automation';
  sessionActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  workflowActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['workflowActionOrigin'];
  executionAuthorization?: ExternalActionExecutionAuthorizationRequestV1['executionAuthorization'];
  sessionActionSource?: ExternalActionExecutionAuthorizationRequestV1['sessionActionSource'];
  installationProof?: ExternalActionExecutionAuthorizationRequestV1['installationProof'];
  managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
  nativeCredentialSpawnChild?: ExternalActionExecutionAuthorizationRequestV1['nativeCredentialSpawnChild'];
  signal?: AbortSignal;
}>): Promise<ExternalActionAuthorizationHttpResult> {
  const path = bindExternalActionExecutionAuthorizationHttpPathV1(input.actionId);
  let response;
  try {
    response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}${path}`,
      { v: 1, machineId: input.machineId, envelope: input.envelope,
        ...(input.sessionActionOrigin ? { sessionActionOrigin: input.sessionActionOrigin } : {}),
        ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin } : {}),
        ...(input.executionAuthorization ? { executionAuthorization: input.executionAuthorization } : {}),
        ...(input.sessionActionSource ? { sessionActionSource: input.sessionActionSource } : {}),
        ...(input.managedContinuation ? { managedContinuation: input.managedContinuation } : {}),
        ...(input.nativeCredentialSpawnChild ? { nativeCredentialSpawnChild: input.nativeCredentialSpawnChild } : {}),
        ...(input.installationProof ? { installationProof: input.installationProof } : {}) },
      {
        headers: { Authorization: `Bearer ${input.pat}`, 'Content-Type': 'application/json',
          ...(input.authorityCeiling === 'account_automation'
            || readAuthTokenProvenance(decodeJwtPayload(input.pat), { allowLegacyHome: false })?.provenance.kind === 'terminal'
            ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) },
        // An admitted Action owns cancellation; authorization preparation must
        // not impose a shorter lifetime on that still-current operation.
        timeout: input.signal ? 0 : 15_000,
        ...(input.signal ? { signal: input.signal } : {}),
        validateStatus: () => true,
      },
    );
  } catch (error) {
    refuseExternalActionPhase('authorization_mint_http', input.machineId, error);
    return { ok: false, code: 'server_unavailable',
      ...(!input.signal?.aborted && classifyServerEndpointError(error).retryable ? { retryable: true as const } : {}) };
  }
  const refusal = response.status < 200 || response.status >= 300
    ? ExternalActionHttpErrorSchema.safeParse(response.data) : null;
  if (refusal) {
    const diagnostic = readSessionInputAdmissionDiagnostic({ actionId: input.actionId, requestId: input.envelope.requestId });
    const actionId = ActionIdSchema.safeParse(input.actionId);
    // Mint refusals precede dispatch for every Action family. Only closed
    // protocol codes and registered Action ids enter this local witness; no
    // response carrier, authored identity, credential or exception stack does.
    refuseExternalActionPhase('authorization_mint_http_status', undefined, undefined, {
      ...diagnostic, httpStatus: response.status,
      ...(actionId.success ? { actionId: actionId.data } : {}),
      ...(refusal.success ? { refusalBranch: refusal.data.error === 'invalid_request'
        ? refusal.data.code : refusal.data.error } : {}),
    });
  }
  if (refusal?.success) {
    if ('requestId' in refusal.data && refusal.data.requestId !== undefined
      && refusal.data.requestId !== input.envelope.requestId) {
      // The incumbent code-only availability refusal carries no correlated target evidence.
      if ('code' in refusal.data && refusal.data.code === 'target_unavailable'
        && !('diagnostic' in refusal.data && refusal.data.diagnostic !== undefined)) {
        return { ok: false, code: refusal.data.code };
      }
      return { ok: false, code: 'auth_unavailable' };
    }
    const failure = projectExternalActionHttpFailureV1(refusal.data);
    const permanentlyUnsupported = 'code' in refusal.data && refusal.data.code === 'target_unavailable'
      && failure.failureCause?.phase === 'execution_authorization'
      && failure.failureCause.errorCode === 'unsupported_operation';
    return { ok: false, code: 'code' in refusal.data ? refusal.data.code : refusal.data.error,
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(failure.details === undefined ? {} : { details: failure.details }),
      ...(failure.failureCause === undefined ? {} : { failureCause: failure.failureCause }),
      ...(!permanentlyUnsupported
        && classifyServerEndpointError(createHttpStatusError(response.status, 'Home authorization unavailable')).retryable
        ? { retryable: true as const } : {}),
      ...('code' in refusal.data && refusal.data.code === 'target_unavailable'
        && 'diagnostic' in refusal.data && refusal.data.diagnostic !== undefined
        ? { diagnostic: refusal.data.diagnostic } : {}),
    };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'invalid_token' };
  if ([404, 405, 501].includes(response.status)) {
    return { ok: false, code: 'server_unavailable' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: 'auth_unavailable',
      ...(classifyServerEndpointError(createHttpStatusError(response.status, 'Home authorization unavailable')).retryable
        ? { retryable: true as const } : {}) };
  }
  const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
  return authorization.success
    ? { ok: true, authorization: authorization.data }
    : { ok: false, code: 'auth_unavailable' };
}
