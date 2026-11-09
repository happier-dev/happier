import axios from '@/api/client/credentialAxios';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import type { CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { SessionPendingEnqueueByMachineResponseV1Schema, SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';

/** Finite requester input admission; the selected Machine need not be connected. */
export function createTemplateHostOnboardingAdmissionTransport(params: Readonly<{
  credentials: Pick<StoredCredentials, 'token'>;
  serverHttpBaseUrl?: string;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>>;
}>): CliActionMachineAdmissionTransport {
  return async (request, options) => {
      const body = SessionPendingTemplateOnboardingRequestV1Schema.parse({ request });
      const path = `/v2/sessions/${encodeURIComponent(body.request.sessionId)}/pending/template-onboarding`;
      const response = await axios.post<unknown>(`${params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${path}`, body, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          ...(params.authorizeRequest ? params.authorizeRequest({ method: 'POST', path, body })
            : { Authorization: `Bearer ${params.credentials.token}` }) },
        timeout: options?.timeoutMs ?? resolveSessionMessageAdmissionTimeoutMs(),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return SessionPendingEnqueueByMachineResponseV1Schema.parse(response.data).result;
  };
}
