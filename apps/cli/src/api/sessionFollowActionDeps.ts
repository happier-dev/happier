import axios from 'axios';
import { resolveSessionFollowActionRequest, parseSessionFollowActionResponse } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { SessionFollowSourcesErrorResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { ReplaceSessionVoiceInclusionsResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { projectSessionFollowSourceKeyPreparationAfterSetV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowSourceKeyPreparationResultV1, ActionExecutorDeps } from '@happier-dev/protocol';
import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from './externalActionExecutionAuthorization';

type SessionFollowActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

/** One endpoint and credential are captured for the lifetime of this executor. */
export function createSessionFollowActionDeps(input: Readonly<{
  token: string;
  serverHttpBaseUrl?: string;
  /** Lane 09 supplies this only after Lane 13 verifies the scoped Machine carrier. */
  prepareSourceKeyAfterSet?: (input: Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    context: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]['context'];
    signal?: AbortSignal;
  }>) => Promise<SessionFollowSourceKeyPreparationResultV1>;
}> & ExternalActionHomeBinding & SessionFollowActionFixedHome): Pick<ActionExecutorDeps, 'sessionFollowAction'> & Readonly<{
  replaceSessionVoiceInclusions: (args: Readonly<{
    context: Parameters<NonNullable<ActionExecutorDeps['sessionTargetTrackedSet']>>[0]['context'];
    sessionIds: readonly string[];
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ ok: boolean }>>;
}> {
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
    replaceSessionVoiceInclusions: async ({ context, sessionIds, signal }) => {
      const path = SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions;
      const body = { sessionIds: [...sessionIds] };
      const authorization = resolveExternalActionServerRequestHeaders({
        context,
        effectActionId: 'session.target.tracked.set',
        method: 'PUT',
        path,
        body,
        daemonToken: input.token,
        serverIdentityId: input.serverIdentityId,
        ...(input.externalActionMachineRequestPrivateKey ? { privateKey: input.externalActionMachineRequestPrivateKey } : {}),
        ...(input.externalActionMachineInstallationId ? { installationId: input.externalActionMachineInstallationId } : {}),
      });
      if (!authorization.ok) return { ok: false };
      const response = await axios.request<unknown>({
        url: `${serverHttpBaseUrl}${path}`,
        method: 'PUT',
        data: body,
        headers: { ...authorization.headers, 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      });
      return response.status >= 200 && response.status < 300
        && ReplaceSessionVoiceInclusionsResponseSchema.safeParse(response.data).success
        ? { ok: true }
        : { ok: false };
    },
    sessionFollowAction: async ({ context, actionId, input: actionInput, serverId: requestedServerId, signal }) => {
      if (requestedServerId && requestedServerId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const request = resolveSessionFollowActionRequest(actionId, actionInput);
      const authorization = resolveExternalActionServerRequestHeaders({
        context,
        effectActionId: actionId,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
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
        ...(request.body === undefined ? {} : { data: request.body }),
        headers: { ...authorization.headers, ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) {
        const failure = SessionFollowSourcesErrorResponseSchema.safeParse(response.data);
        if (failure.success) return { ok: false, errorCode: failure.data.error, error: failure.data.error };
        if ([404, 405, 501].includes(response.status)) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        if (isAuthenticationStatus(response.status)) throw createAuthenticationHttpStatusError(response.status, 'Follow Action authentication failed');
        throw createHttpStatusError(response.status, 'Follow Action request failed');
      }
      if (actionId === 'session.follow.sources.set') {
        const parsed = parseSessionFollowActionResponse(actionId, actionInput, response.data);
        const setInput = actionInput as Readonly<{ sourceSessionId: string; destinationSessionId: string }>;
        const prepare = input.prepareSourceKeyAfterSet;
        if (prepare) {
          let preparation: SessionFollowSourceKeyPreparationResultV1;
          try {
            preparation = await prepare({
              sourceSessionId: setInput.sourceSessionId,
              destinationSessionId: setInput.destinationSessionId,
              context,
              ...(signal ? { signal } : {}),
            });
          } catch {
            preparation = { kind: 'waiting', reason: 'runner_unreachable' };
          }
          return projectSessionFollowSourceKeyPreparationAfterSetV1(parsed, preparation);
        }
        return projectSessionFollowSourceKeyPreparationAfterSetV1(parsed, {
          kind: 'waiting',
          reason: 'source_key_unavailable',
        });
      }
      return parseSessionFollowActionResponse(actionId, actionInput, response.data);
    },
  };
}

/** Released tracked-target adapter. Its Set is attempt-local presentation only;
 * every eligibility write delegates to canonical exact-Home Account Follow. */
export function createSessionTrackedTargetCompatibilityDep(input: Readonly<{
  serverId: string;
  replaceSessionVoiceInclusions: (args: Readonly<{
    context: Parameters<NonNullable<ActionExecutorDeps['sessionTargetTrackedSet']>>[0]['context'];
    sessionIds: readonly string[];
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ ok: boolean }>>;
}>): Pick<ActionExecutorDeps, 'sessionTargetTrackedSet'> {
  return {
    sessionTargetTrackedSet: async (targets) => {
      const requestedAddresses = ('sessionAddresses' in targets
        ? targets.sessionAddresses
        : targets.sessionIds.map((sessionId) => ({ serverId: input.serverId, sessionId })))
        .map((address) => ({ serverId: address.serverId.trim(), sessionId: address.sessionId.trim() }));
      if (requestedAddresses.some((address) => address.serverId !== input.serverId)) {
        return {
          ok: false as const,
          status: 'unavailable' as const,
          error: {
            code: 'session_follow_unavailable' as const,
            message: 'Include in Voice can only be changed on this command\'s Home.',
          },
        };
      }
      const addresses = [...new Map(requestedAddresses.map((address) => [address.sessionId, address] as const)).values()]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      const replaced = await input.replaceSessionVoiceInclusions({
        context: targets.context,
        sessionIds: addresses.map(address => address.sessionId),
        ...(targets.signal ? { signal: targets.signal } : {}),
      });
      if (!replaced.ok) return {
        ok: false as const,
        status: 'unavailable' as const,
        error: { code: 'session_follow_unavailable' as const, message: 'Include in Voice could not be updated.' },
      };
      return {
        ok: true as const,
        status: 'ok' as const,
        sessionIds: addresses.map((address) => address.sessionId),
        sessionAddresses: addresses,
        sessions: [],
      };
    },
  };
}
