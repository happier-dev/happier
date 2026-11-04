import axios from '@/api/client/credentialAxios';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionHttpErrorSchema, ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1, type ExternalActionExecutionAuthorizationRequestV1, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { refuseExternalActionPhase, readSessionInputAdmissionDiagnostic } from '@/daemon/externalActions/externalActionPhase';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';

type ExternalActionAuthorizationHttpFailure = Readonly<{
  ok: false;
  code: 'invalid_token' | 'credential_scope_denied' | 'auth_unavailable' | 'server_unavailable' | 'target_unavailable';
  /** Private preparation fact; HTTP adapters still project only their existing code. */
  retryable?: true;
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
  sessionActionSource?: ExternalActionExecutionAuthorizationRequestV1['sessionActionSource'];
  installationProof?: ExternalActionExecutionAuthorizationRequestV1['installationProof'];
  managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
  nativeCredentialSpawnChild?: ExternalActionExecutionAuthorizationRequestV1['nativeCredentialSpawnChild'];
  templateRequesterSetupAdmission?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupAdmission'];
  templateRequesterInitialAccessAdmission?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterInitialAccessAdmission'];
  templateRequesterSetupEnrichment?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupEnrichment'];
  templateRequesterSetupPlanContinuation?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupPlanContinuation'];
  signal?: AbortSignal;
}>): Promise<ExternalActionAuthorizationHttpResult> {
  const path = bindExternalActionExecutionAuthorizationHttpPathV1(input.actionId);
  let response;
  try {
    response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}${path}`,
      { v: 1, machineId: input.machineId, envelope: input.envelope,
        ...(input.nativeCredentialSpawnChild ? { nativeCredentialSpawnChild: input.nativeCredentialSpawnChild } : {}),
        ...(input.sessionActionOrigin ? { sessionActionOrigin: input.sessionActionOrigin } : {}),
        ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin } : {}),
        ...(input.sessionActionSource ? { sessionActionSource: input.sessionActionSource } : {}),
        ...(input.managedContinuation ? { managedContinuation: input.managedContinuation } : {}),
        ...(input.templateRequesterSetupAdmission ? { templateRequesterSetupAdmission: input.templateRequesterSetupAdmission } : {}),
        ...(input.templateRequesterInitialAccessAdmission ? { templateRequesterInitialAccessAdmission: input.templateRequesterInitialAccessAdmission } : {}),
        ...(input.templateRequesterSetupEnrichment ? { templateRequesterSetupEnrichment: input.templateRequesterSetupEnrichment } : {}),
        ...(input.templateRequesterSetupPlanContinuation ? { templateRequesterSetupPlanContinuation: input.templateRequesterSetupPlanContinuation } : {}),
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
  if (response.status < 200 || response.status >= 300) {
    const diagnostic = readSessionInputAdmissionDiagnostic({ actionId: input.actionId, requestId: input.envelope.requestId });
    if (diagnostic) refuseExternalActionPhase('authorization_mint_http_status', input.machineId,
      createHttpStatusError(response.status, 'Home authorization unavailable'), diagnostic);
  }
  if (response.status === 403) {
    const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
    if (refusal.success && refusal.data.error === 'credential_scope_denied') {
      return { ok: false, code: 'credential_scope_denied' };
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'invalid_token' };
  }
  if (response.status === 409) {
    const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
    if (refusal.success && refusal.data.error === 'invalid_request' && refusal.data.code === 'target_unavailable') {
      return { ok: false, code: 'target_unavailable' };
    }
  }
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
