import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { parseRetryAfterHeader } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConversationDeliveryResultV1, ConversationProviderFailureV1 } from '@happier-dev/channels-protocol/v1';
import type { SlackMessagePayload } from './slackDelivery.js';

export type SlackCredentials = Readonly<{ botToken: string; appToken: string }>;
export type SlackIdentity = Readonly<{ teamId: string; appId: string; botUserId: string; botId: string; label: string }>;
export type SlackChannel = Readonly<{ id: string; isIm: boolean; isMpim: boolean; isPrivate: boolean; name?: string; isArchived: boolean }>;
export type SlackApiFailure = ConversationProviderFailureV1;
type RequestOptions = Readonly<{ signal?: AbortSignal }>;
type JsonRecord = Readonly<Record<string, unknown>>;
type SlackResponse = Readonly<{
  status: number; headers: Readonly<Record<string, string>>; body: unknown;
}>;
type SlackMessageUpdate = Readonly<{ channel: string; ts: string; text: string; as_user?: true }>;

const INVALID_CONFIGURATION: SlackApiFailure = Object.freeze({ kind: 'notReady', reason: 'invalidConfiguration' });
const CREDENTIAL_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'not_allowed_token_type']);
const PERMISSION_ERRORS = new Set(['missing_scope', 'no_permission', 'not_in_channel', 'access_denied', 'restricted_action', 'ekm_access_denied', 'team_access_not_granted', 'cant_update_message']);
const UNCERTAIN_ERRORS = new Set(['internal_error', 'fatal_error', 'service_unavailable']);

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function slackId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]+$/.test(value);
}

function messageTs(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+\.[0-9]+$/.test(value);
}

function slackUrl(value: unknown, protocol: 'https:' | 'wss:'): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === protocol && url.hostname.endsWith('.slack.com') && !url.username && !url.password
      && (!url.port || url.port === '443') ? url : null;
  } catch {
    return null;
  }
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (header === undefined || !/^[0-9]+(?:\.[0-9]+)?$/.test(header.trim())) return undefined;
  return parseRetryAfterHeader(header, { nowMs: 0 }).retryAfterMs ?? undefined;
}

function failure(response: SlackResponse | null): SlackApiFailure {
  if (response === null) return { kind: 'notReady', reason: 'network' };
  const error = record(response.body) ? response.body.error : undefined;
  if (response.status === 429 || error === 'ratelimited') {
    const delay = retryAfterMs(response.headers);
    return { kind: 'notReady', reason: 'rateLimited', ...(delay === undefined ? {} : { retryAfterMs: delay }) };
  }
  if (response.status === 401 || (typeof error === 'string' && CREDENTIAL_ERRORS.has(error))) {
    return { kind: 'notReady', reason: 'credentialInvalid' };
  }
  if (response.status === 403 || (typeof error === 'string' && PERMISSION_ERRORS.has(error))) {
    return { kind: 'notReady', reason: 'permissionMissing' };
  }
  if (response.status >= 500 || response.status === 0 || (typeof error === 'string' && UNCERTAIN_ERRORS.has(error))) {
    return { kind: 'notReady', reason: 'network' };
  }
  return INVALID_CONFIGURATION;
}

export function createSlackApi(input: Readonly<{ credentials: SlackCredentials; http: Pick<HttpService, 'request'>;
  logger?: Pick<PluginInvocationContext['services']['logger'], 'warn'> }>) {
  async function request(
    method: string, parameters: Readonly<Record<string, unknown>>, options?: RequestOptions,
  ): Promise<SlackResponse | null> {
    if (options?.signal?.aborted) return null;
    const post = method === 'auth.test' || method === 'apps.connections.open' || method === 'chat.postMessage' || method === 'chat.update';
    const url = new URL(`https://slack.com/api/${method}`);
    if (!post) for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    try {
      const response = await input.http.request({
        url: url.href,
        method: post ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${method === 'apps.connections.open' ? input.credentials.appToken : input.credentials.botToken}`,
          ...(post ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        ...(post ? { body: new TextEncoder().encode(JSON.stringify(parameters)) } : {}),
      }, options);
      let body: unknown = null;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); } catch { /* Invalid provider response. */ }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      // Keep the cause without request URLs, tokens or response bytes. A lost
      // response still cannot prove that a send had no effect.
      input.logger?.warn('[Slack] request failed', {
        failureCause: projectActionFailureCauseV1(error, 'slack.request', { allowUnknownErrorCode: false }),
      });
      return null;
    }
  }

  async function read(method: string, parameters: Readonly<Record<string, unknown>>, options?: RequestOptions) {
    const response = await request(method, parameters, options);
    if (options?.signal?.aborted) return { ok: false as const, failure: { kind: 'notReady', reason: 'network' } satisfies SlackApiFailure };
    return response && response.status >= 200 && response.status < 300 && record(response.body) && response.body.ok === true
      ? { ok: true as const, body: response.body }
      : { ok: false as const, failure: failure(response) };
  }

  async function writeMessage(
    method: 'chat.postMessage' | 'chat.update', payload: SlackMessagePayload | SlackMessageUpdate, options?: RequestOptions,
  ): Promise<ConversationDeliveryResultV1> {
    if (options?.signal?.aborted) return { kind: 'notDelivered', retry: 'safe' };
    const response = await request(method, payload, options);
    if (!response) return { kind: 'outcomeUnknown' };
    const body = response.body;
    const error = record(body) ? body.error : undefined;
    if (response.status === 429 || error === 'ratelimited') {
      const delay = retryAfterMs(response.headers);
      return delay === undefined ? { kind: 'notDelivered', retry: 'safe' }
        : { kind: 'notDelivered', retry: 'after', retryAfterMs: delay };
    }
    if (response.status >= 500 || response.status === 0 || (typeof error === 'string' && UNCERTAIN_ERRORS.has(error))) {
      return { kind: 'outcomeUnknown' };
    }
    if (record(body) && body.ok === false) {
      if (error === 'is_archived') return { kind: 'endpointArchived', recovery: 'ownerMustUnarchiveOrRebind' };
      return failure(response);
    }
    if (response.status < 200 || response.status >= 300 || !record(body) || body.ok !== true || body.channel !== payload.channel || !messageTs(body.ts)
      || ('ts' in payload && body.ts !== payload.ts)) {
      return { kind: 'outcomeUnknown' };
    }
    const metadata = record(body.response_metadata) ? body.response_metadata : {};
    const truncated = body.warning === 'message_truncated'
      || (Array.isArray(metadata.warnings) && metadata.warnings.includes('message_truncated'));
    return { kind: truncated ? 'outcomeUnknown' : 'delivered', providerMessageIds: [body.ts] };
  }

  return {
    async getIdentity(options?: RequestOptions): Promise<SlackIdentity | SlackApiFailure> {
      const auth = await read('auth.test', {}, options);
      if (!auth.ok) return auth.failure;
      const { team_id: teamId, user_id: botUserId, bot_id: botId } = auth.body;
      if (!slackId(teamId) || !slackId(botUserId) || !slackId(botId)) return INVALID_CONFIGURATION;
      const result = await read('bots.info', { bot: botId }, options);
      if (!result.ok) return result.failure;
      const bot = result.body.bot;
      if (!record(bot) || bot.id !== botId || bot.user_id !== botUserId || !slackId(bot.app_id) || bot.deleted === true) {
        return INVALID_CONFIGURATION;
      }
      return { teamId, appId: bot.app_id, botUserId, botId, label: text(bot.name) ?? text(auth.body.user) ?? botUserId };
    },
    async openConnection(options?: RequestOptions): Promise<{ url: string } | SlackApiFailure> {
      const result = await read('apps.connections.open', {}, options);
      if (!result.ok) return result.failure;
      const url = slackUrl(result.body.url, 'wss:');
      return url ? { url: url.href } : INVALID_CONFIGURATION;
    },
    async getChannel(id: string, options?: RequestOptions): Promise<SlackChannel | SlackApiFailure> {
      if (!slackId(id)) return INVALID_CONFIGURATION;
      const result = await read('conversations.info', { channel: id }, options);
      if (!result.ok) return result.failure;
      const channel = result.body.channel;
      if (!record(channel) || channel.id !== id || typeof channel.is_im !== 'boolean') return INVALID_CONFIGURATION;
      // Slack's documented IM object omits the shared-channel flags. Only that
      // authenticated direct topology supplies their defaults.
      if (!channel.is_im && (typeof channel.is_mpim !== 'boolean' || typeof channel.is_private !== 'boolean'
        || typeof channel.is_archived !== 'boolean')) return INVALID_CONFIGURATION;
      const name = text(channel.name);
      return {
        id, isIm: channel.is_im, isMpim: channel.is_mpim === true,
        isPrivate: channel.is_im || channel.is_private === true, isArchived: channel.is_archived === true,
        ...(name ? { name } : {}),
      };
    },
    async getThreadRoot(channelId: string, selectedMessageTs: string, options?: RequestOptions): Promise<{ threadTs: string } | SlackApiFailure> {
      if (!slackId(channelId) || !messageTs(selectedMessageTs)) return INVALID_CONFIGURATION;
      const result = await read('chat.getPermalink', { channel: channelId, message_ts: selectedMessageTs }, options);
      if (!result.ok) return result.failure;
      const url = slackUrl(result.body.permalink, 'https:');
      if (result.body.channel !== channelId || !url || url.pathname !== `/archives/${channelId}/p${selectedMessageTs.replace('.', '')}`
        || (url.searchParams.has('cid') && url.searchParams.get('cid') !== channelId)) return INVALID_CONFIGURATION;
      const threadTs = url.searchParams.get('thread_ts') ?? selectedMessageTs;
      return messageTs(threadTs) ? { threadTs } : INVALID_CONFIGURATION;
    },
    async getUser(id: string, options?: RequestOptions): Promise<{ id: string; teamId: string; isBot: boolean; deleted: boolean; label: string } | SlackApiFailure> {
      if (!slackId(id)) return INVALID_CONFIGURATION;
      const result = await read('users.info', { user: id }, options);
      if (!result.ok) return result.failure;
      const user = result.body.user;
      if (!record(user) || user.id !== id || !slackId(user.team_id) || typeof user.is_bot !== 'boolean' || typeof user.deleted !== 'boolean') {
        return INVALID_CONFIGURATION;
      }
      const profile = record(user.profile) ? user.profile : {};
      return { id, teamId: user.team_id, isBot: user.is_bot || user.is_app_user === true, deleted: user.deleted,
        label: text(profile.display_name) ?? text(profile.real_name) ?? text(user.real_name) ?? text(user.name) ?? id };
    },
    async downloadFile(id: string, options?: RequestOptions): Promise<Readonly<{ kind: 'downloaded'; bytes: Uint8Array }> | SlackApiFailure> {
      if (!slackId(id)) return INVALID_CONFIGURATION;
      const result = await read('files.info', { file: id }, options);
      options?.signal?.throwIfAborted();
      if (!result.ok) return result.failure;
      const file = result.body.file;
      if (!record(file) || file.id !== id) return INVALID_CONFIGURATION;
      const url = slackUrl(file.url_private_download ?? file.url_private, 'https:');
      if (!url) return { kind: 'notReady', reason: 'unsupported', diagnostic: 'Slack file has no downloadable private URL.' };
      try {
        const response = await input.http.request({ url: url.href, method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${input.credentials.botToken}` } }, options);
        options?.signal?.throwIfAborted();
        if (response.status < 200 || response.status >= 300) return failure({ ...response, body: null });
        return { kind: 'downloaded', bytes: response.body };
      } catch {
        options?.signal?.throwIfAborted();
        return { kind: 'notReady', reason: 'network' };
      }
    },
    async postMessage(payload: SlackMessagePayload, options?: RequestOptions): Promise<ConversationDeliveryResultV1> {
      return writeMessage('chat.postMessage', payload, options);
    },
    async updateMessage(payload: SlackMessageUpdate, options?: RequestOptions): Promise<ConversationDeliveryResultV1> {
      if (!messageTs(payload.ts)) return { kind: 'notDelivered', retry: 'never' };
      return writeMessage('chat.update', payload, options);
    },
  };
}
