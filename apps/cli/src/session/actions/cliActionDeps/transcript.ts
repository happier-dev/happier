import type { CliActionDepsParams } from './types';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { getSessionEvents } from '@/session/services/getSessionEvents';
import type { getSessionTranscript } from '@/session/services/getSessionTranscript';
export function createCliTranscriptActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'resolveServerFeaturesSnapshot'>,
  { resolveServerRequestHeaders }: Readonly<{
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
  }>,
): Pick<ActionExecutorDeps, 'sessionHistoryGet' | 'sessionInputResultGet' | 'sessionTranscriptGet' | 'sessionEventsGet' | 'sessionRecentMessagesGet'> {
  return {

    sessionHistoryGet: async ({ sessionId, limit, format, includeMeta, includeStructuredPayload }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedLimit =
	        typeof limit === 'number' && Number.isFinite(limit) && limit > 0
	          ? Math.min(1000, Math.floor(limit))
	          : 50;
	      const normalizedFormat = format === 'raw' || format === 'compact' ? format : 'compact';
	      const { getSessionEvents } = await import("@/session/services/getSessionEvents");
	      return await getSessionEvents({
	        credentials: params.credentials,
	        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
	        idOrPrefix: sessionId,
	        limit: normalizedLimit,
	        format: normalizedFormat,
	        includeMeta: includeMeta === true,
	        includeStructuredPayload: includeStructuredPayload === true,
	      });
	    },

    sessionInputResultGet: async ({ context, sessionId, localId, projection, callerPluginId, serverId, signal }) => {
      if (!params.credentials) return { ok: false, code: 'result_read_failed' };
      const { readSessionInputResult } = await import('@/session/services/sendSessionMessage');
      return readSessionInputResult({ credentials: params.credentials, idOrPrefix: sessionId, localId,
        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
        ...(projection ? { projection } : {}),
        ...(callerPluginId ? { callerPluginId } : {}), ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context,
          context?.externalActionExecutionAuthorization?.binding.actionId ?? 'session.input.result.get', request),
      });
    },
    sessionTranscriptGet: async ({
      context,
      sessionId,
      messageId,
      projection,
      callerPluginId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      includeTools,
      includeReasoning,
      includeEvents,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxCharsPerMessage,
      maxRawPayloadChars,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET' | 'POST'; path: string; body?: unknown;
      }>) => resolveServerRequestHeaders(context,
        context?.externalActionExecutionAuthorization?.binding.actionId ?? 'session.transcript.get', request);
      if (!resolveAuthorizationHeaders({
        method: 'GET', path: '/v1/account/encryption/currentness',
      })) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      const { getSessionTranscript } = await import("@/session/services/getSessionTranscript");
      return await getSessionTranscript({
        credentials: params.credentials,
        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
        resolveAuthorizationHeaders,
        idOrPrefix: sessionId,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(projection ? { projection } : {}),
        ...(callerPluginId ? { callerPluginId } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(typeof includeTools === 'boolean' ? { includeTools } : {}),
        ...(typeof includeReasoning === 'boolean' ? { includeReasoning } : {}),
        ...(typeof includeEvents === 'boolean' ? { includeEvents } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage } : {}),
        ...(maxRawPayloadChars !== undefined ? { maxRawPayloadChars } : {}),
        ...(signal ? { signal } : {}),
      });
    },

    sessionEventsGet: async ({
      sessionId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      kinds,
      format,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxTextChars,
      maxPayloadChars,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      const { getSessionEvents } = await import("@/session/services/getSessionEvents");
      return await getSessionEvents({
        credentials: params.credentials,
        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(kinds ? { kinds } : {}),
        ...(format ? { format } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        ...(typeof maxPayloadChars === 'number' ? { maxPayloadChars } : {}),
      });
    },

    sessionRecentMessagesGet: async ({ sessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      const { getSessionTranscript } = await import("@/session/services/getSessionTranscript");
      return await getSessionTranscript({
        credentials: params.credentials,
        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(Object.prototype.hasOwnProperty.call({ cursor }, 'cursor') ? { cursor: cursor ?? null } : {}),
        roles: [
          ...(includeUser === false ? [] : ['user' as const]),
          ...(includeAssistant === false ? [] : ['assistant' as const]),
        ],
        ...(Object.prototype.hasOwnProperty.call({ maxCharsPerMessage }, 'maxCharsPerMessage') ? { maxCharsPerMessage: maxCharsPerMessage ?? null } : {}),
      });
    },
  };
}
