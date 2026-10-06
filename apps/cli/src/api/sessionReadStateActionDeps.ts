import axios from 'axios';
import { resolveSessionReadStateActionRequest, projectSessionReadStateActionTransportFailure } from '@happier-dev/protocol/sessions/readState/actionTransport';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from './externalActionExecutionAuthorization';

type SessionReadStateActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

/**
 * One endpoint and credential are captured for the lifetime of this executor.
 *
 * This is the CLI host adapter for the explicit-human read-state Action
 * (Lane 09B §5.3, E1). It calls the existing
 * `POST /v2/sessions/:sessionId/read-state` domain route through the exact-Home
 * binding and projects the canonical Action result. It performs no second
 * persistence write, evaluation, or server execution; the server's
 * `applySessionReadCursorOperation` remains the sole read-state writer.
 */
export function createSessionReadStateActionDeps(input: Readonly<{
  token: string;
  serverHttpBaseUrl?: string;
}> & ExternalActionHomeBinding & SessionReadStateActionFixedHome): Pick<ActionExecutorDeps, 'sessionReadStateAction'> {
  if (
    (input.serverId === undefined) !== (input.serverHttpBaseUrl === undefined)
    || (input.serverId !== undefined && input.serverId.trim().length === 0)
    || (input.serverHttpBaseUrl !== undefined && input.serverHttpBaseUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  const serverHttpBaseUrl = input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const serverId = input.serverId ?? configuration.activeServerId;
  return {
    sessionReadStateAction: async ({ context, actionId, input: actionInput, serverId: requestedServerId, signal }) => {
      if (requestedServerId && requestedServerId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const request = resolveSessionReadStateActionRequest(actionId, actionInput);
      const authorization = resolveExternalActionServerRequestHeaders({
        context,
        effectActionId: actionId,
        method: request.method,
        path: request.path,
        body: request.body,
        daemonToken: input.token,
        serverIdentityId: input.serverIdentityId,
        ...(input.externalActionMachineRequestPrivateKey
          ? { privateKey: input.externalActionMachineRequestPrivateKey }
          : {}),
        ...(input.externalActionMachineInstallationId
          ? { installationId: input.externalActionMachineInstallationId }
          : {}),
      });
      if (!authorization.ok) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const response = await axios.request<unknown>({
        url: `${serverHttpBaseUrl}${request.path}`,
        method: request.method,
        data: request.body,
        headers: { ...authorization.headers, 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) {
        const failure = projectSessionReadStateActionTransportFailure(response.status, response.data);
        if (failure.errorCode === 'unavailable') {
          if (isAuthenticationStatus(response.status)) throw createAuthenticationHttpStatusError(response.status, 'Read-state Action authentication failed');
          throw createHttpStatusError(response.status, 'Read-state Action request failed');
        }
        return { ok: false, errorCode: failure.errorCode, error: failure.errorCode, ...(failure.viewer ? { details: { viewer: failure.viewer } } : {}) };
      }
      // The shared Protocol executor owns the one route-to-Action projection.
      // This exact-Home adapter only transports the canonical route payload.
      return response.data;
    },
  };
}
