import axios from '@/api/client/credentialAxios';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import type { CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionPendingEnqueueByMachineResponseV1Schema, SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';

/** Finite requester input admission; the selected Machine need not be connected. */
export function createTemplateHostOnboardingAdmissionTransport(params: Readonly<{
  credentials: Pick<StoredCredentials, 'token'>;
  serverHttpBaseUrl?: string;
  authorization: ExternalActionExecutionAuthorizationV1;
  originalActionEnvelope: ExternalActionRequestEnvelope;
}>): Readonly<{
  transport: CliActionMachineAdmissionTransport;
  onCreationAuthorization: (authorization: ExternalActionExecutionAuthorizationV1) => void;
}> {
  let authorization = params.authorization;
  return {
    onCreationAuthorization: value => { authorization = value; },
    transport: async (request, options) => {
      const body = SessionPendingTemplateOnboardingRequestV1Schema.parse({ authorization,
        originalActionEnvelope: params.originalActionEnvelope, request });
      const path = `/v2/sessions/${encodeURIComponent(body.request.sessionId)}/pending/template-onboarding`;
      const response = await axios.post<unknown>(`${params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${path}`, body, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials.token}` },
        timeout: options?.timeoutMs ?? resolveSessionMessageAdmissionTimeoutMs(),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return SessionPendingEnqueueByMachineResponseV1Schema.parse(response.data).result;
    },
  };
}
