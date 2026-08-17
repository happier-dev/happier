import type { HttpService } from '@happier-dev/plugin-sdk/http';

import {
  boundedDiscordRetryAfterMs,
  classifyDiscordDeliveryResponse,
  type DiscordDeliveryResult,
  type DiscordMessageCreatePayload,
} from './discordDelivery.js';
import type { DiscordKnownChannel } from './discordEndpointResolution.js';
import {
  normalizeDiscordGatewayUrl,
  type DiscordGatewaySessionStartLimit,
} from './discordGateway.js';
import type {
  DiscordGuildRolePermissionEvidence,
  DiscordPermissionOverwriteEvidence,
} from './discordSetup.js';

export const DISCORD_API_ORIGIN = 'https://discord.com';
export const DISCORD_API_BASE_URL = `${DISCORD_API_ORIGIN}/api/v10`;
// Discord requires clients to identify their library and version on every
// HTTP API request. The host preserves provider-owned headers unchanged.
export const DISCORD_HTTP_USER_AGENT = 'DiscordBot (https://happier.dev, 0.0.0)';
/** Discord application flags documented for the privileged Message Content intent. */
export const DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_FLAG = 1 << 18;
export const DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG = 1 << 19;

type DiscordHttp = Pick<HttpService, 'request'>;
type DiscordRequestOptions = Readonly<{ signal?: AbortSignal }>;
type JsonRecord = Readonly<Record<string, unknown>>;

export type DiscordBotIdentity = Readonly<{
  applicationId: string;
  botUserId: string;
  botLabel: string;
  applicationMessageContentIntentPermission: DiscordApplicationMessageContentIntentPermission;
}>;

/**
 * Application-object preflight only. This deliberately remains distinct from
 * the strict Channels demand and from a Gateway Identify/current-session fact.
 */
export type DiscordApplicationMessageContentIntentPermission =
  | Readonly<{ kind: 'enabled' | 'disabled'; source: 'flags' | 'flagsNew' | 'flagsAndFlagsNew' }>
  | Readonly<{ kind: 'unknown'; reason: 'missing' | 'malformed' | 'inconsistent' }>;

export type DiscordGatewayBotInfo = Readonly<{
  gatewayUrl: string;
  sessionStartLimit: Omit<DiscordGatewaySessionStartLimit, 'observedAtMs'>;
}>;

/** Immutable role evidence for the authenticated bot's current guild member. */
export type DiscordGuildMemberRoleEvidence = Readonly<{
  roleIds: readonly string[];
}>;

export type DiscordApiFailure = Readonly<{
  kind: 'notReady';
  reason: 'credentialInvalid' | 'permissionMissing' | 'network' | 'rateLimited' | 'invalidConfiguration';
  retryAfterMs?: number;
  diagnostic?: string;
}>;

export type DiscordBotApi = Readonly<{
  getIdentity(options?: DiscordRequestOptions): Promise<DiscordBotIdentity | DiscordApiFailure>;
  getGatewayBot(options?: DiscordRequestOptions): Promise<DiscordGatewayBotInfo | DiscordApiFailure>;
  getChannel(input: Readonly<{ channelId: string }>, options?: DiscordRequestOptions): Promise<DiscordKnownChannel | null | DiscordApiFailure>;
  getGuildMember(
    input: Readonly<{ guildId: string; userId: string }>,
    options?: DiscordRequestOptions,
  ): Promise<DiscordGuildMemberRoleEvidence | null | DiscordApiFailure>;
  getGuildRoles(
    input: Readonly<{ guildId: string }>,
    options?: DiscordRequestOptions,
  ): Promise<readonly DiscordGuildRolePermissionEvidence[] | DiscordApiFailure>;
  sendMessage(
    input: Readonly<{ channelId: string; payload: DiscordMessageCreatePayload; canManageThreads: boolean }>,
    options?: DiscordRequestOptions,
  ): Promise<DiscordDeliveryResult>;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

const MAX_DISCORD_PERMISSION_BITS = (1n << 64n) - 1n;

function permissionBits(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_DISCORD_PERMISSION_BITS ? parsed : null;
  } catch {
    return null;
  }
}

function applicationFlags(value: unknown): bigint | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 0x7fff_ffff
    ? BigInt(value)
    : null;
}

function applicationFlagsNew(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hasMessageContentIntent(bits: bigint): boolean {
  const enabled = (1n << 18n) | (1n << 19n);
  return (bits & enabled) !== 0n;
}

/**
 * Discord serializes current flags in `flags` and, for future high bits, in
 * `flags_new`. The Message Content bits are representable in both, so a
 * disagreement is not permission evidence and fails closed when demand needs
 * the privileged intent.
 */
export function readDiscordApplicationMessageContentIntentPermission(
  application: unknown,
): DiscordApplicationMessageContentIntentPermission {
  if (!isRecord(application)) return { kind: 'unknown', reason: 'malformed' };
  const hasFlags = Object.hasOwn(application, 'flags');
  const hasFlagsNew = Object.hasOwn(application, 'flags_new');
  if (!hasFlags && !hasFlagsNew) return { kind: 'unknown', reason: 'missing' };

  const flags = hasFlags ? applicationFlags(application.flags) : null;
  const flagsNew = hasFlagsNew ? applicationFlagsNew(application.flags_new) : null;
  if ((hasFlags && flags === null) || (hasFlagsNew && flagsNew === null)) {
    return { kind: 'unknown', reason: 'malformed' };
  }

  const flagsPermission = flags === null ? null : hasMessageContentIntent(flags);
  const flagsNewPermission = flagsNew === null ? null : hasMessageContentIntent(flagsNew);
  if (flagsPermission !== null && flagsNewPermission !== null && flagsPermission !== flagsNewPermission) {
    return { kind: 'unknown', reason: 'inconsistent' };
  }
  const enabled = flagsPermission ?? flagsNewPermission;
  if (enabled === null) return { kind: 'unknown', reason: 'missing' };
  return {
    kind: enabled ? 'enabled' : 'disabled',
    source: flagsPermission === null
      ? 'flagsNew'
      : flagsNewPermission === null
        ? 'flags'
        : 'flagsAndFlagsNew',
  };
}

function parseJson(body: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function diagnosticFromBody(body: unknown): string | undefined {
  const message = isRecord(body) ? nonEmptyString(body.message) : null;
  return message ? message.slice(0, 512) : undefined;
}

function failureFromResponse(status: number, body: unknown): DiscordApiFailure {
  const diagnostic = diagnosticFromBody(body);
  if (status === 401) return { kind: 'notReady', reason: 'credentialInvalid', ...(diagnostic ? { diagnostic } : {}) };
  if (status === 403) return { kind: 'notReady', reason: 'permissionMissing', ...(diagnostic ? { diagnostic } : {}) };
  if (status === 429) {
    const retryAfterMs = boundedDiscordRetryAfterMs(body);
    return {
      kind: 'notReady',
      reason: 'rateLimited',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  if (status >= 500 || status === 0) return { kind: 'notReady', reason: 'network', ...(diagnostic ? { diagnostic } : {}) };
  return { kind: 'notReady', reason: 'invalidConfiguration', ...(diagnostic ? { diagnostic } : {}) };
}

function apiPath(path: string): string {
  return `${DISCORD_API_BASE_URL}${path}`;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseGatewayBot(value: unknown): DiscordGatewayBotInfo | null {
  if (!isRecord(value) || !isRecord(value.session_start_limit)) return null;
  const gatewayUrl = normalizeDiscordGatewayUrl(value.url);
  const total = positiveSafeInteger(value.session_start_limit.total);
  const remaining = nonNegativeSafeInteger(value.session_start_limit.remaining);
  const resetAfterMs = positiveSafeInteger(value.session_start_limit.reset_after);
  const maxConcurrency = positiveSafeInteger(value.session_start_limit.max_concurrency);
  if (
    !gatewayUrl
    || total === null
    || remaining === null
    || remaining > total
    || resetAfterMs === null
    || maxConcurrency === null
  ) {
    return null;
  }
  return {
    gatewayUrl,
    sessionStartLimit: { total, remaining, resetAfterMs, maxConcurrency },
  };
}

function parsePermissionOverwrites(value: unknown): readonly DiscordPermissionOverwriteEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const overwrites: DiscordPermissionOverwriteEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const id = nonEmptyString(entry.id);
    const type = nonNegativeSafeInteger(entry.type);
    const allow = permissionBits(entry.allow);
    const deny = permissionBits(entry.deny);
    if (!id || allow === null || deny === null || (type !== 0 && type !== 1)) return null;
    const kind = type === 0 ? 'role' : 'member';
    const key = `${kind}:${id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    overwrites.push({ id, kind, allow, deny });
  }
  return overwrites;
}

function parseKnownChannel(value: unknown, expectedChannelId: string): DiscordKnownChannel | null {
  if (!isRecord(value)) return null;
  const channelId = nonEmptyString(value.id);
  const type = nonNegativeSafeInteger(value.type);
  const label = nonEmptyString(value.name) ?? undefined;
  const guildId = nonEmptyString(value.guild_id) ?? undefined;
  const permissionOverwrites = value.permission_overwrites === undefined
    ? undefined
    : parsePermissionOverwrites(value.permission_overwrites);
  if (permissionOverwrites === null) return null;
  if (!channelId || channelId !== expectedChannelId || type === null) return null;
  if (type === 1) return { channelId, kind: 'direct', ...(label ? { label } : {}) };
  if (type === 0 || type === 5) {
    return {
      channelId,
      kind: 'shared',
      ...(label ? { label } : {}),
      ...(guildId === undefined ? {} : { guildId }),
      ...(permissionOverwrites === undefined ? {} : { permissionOverwrites }),
    };
  }
  if (type === 10 || type === 11 || type === 12) {
    const parentChannelId = nonEmptyString(value.parent_id);
    if (!parentChannelId) return null;
    return {
      channelId,
      kind: 'thread',
      ...(label ? { label } : {}),
      parentChannelId,
      ...(guildId === undefined ? {} : { guildId }),
    };
  }
  return null;
}

function parseGuildMemberRoleEvidence(
  value: unknown,
  expectedUserId: string,
): DiscordGuildMemberRoleEvidence | null {
  if (!isRecord(value)) return null;
  const user = value.user === undefined
    ? expectedUserId
    : isRecord(value.user)
      ? nonEmptyString(value.user.id)
      : null;
  const rawRoles = Array.isArray(value.roles) ? value.roles : null;
  if (user !== expectedUserId || rawRoles === null) return null;
  const roleIds: string[] = [];
  for (const rawRoleId of rawRoles) {
    const roleId = nonEmptyString(rawRoleId);
    if (roleId === null) return null;
    roleIds.push(roleId);
  }
  return { roleIds };
}

function parseGuildRolePermissionEvidence(value: unknown): readonly DiscordGuildRolePermissionEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const roles: DiscordGuildRolePermissionEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const roleId = nonEmptyString(entry.id);
    const permissions = permissionBits(entry.permissions);
    if (!roleId || permissions === null || seen.has(roleId)) return null;
    seen.add(roleId);
    roles.push({ roleId, permissions });
  }
  return roles;
}

/**
 * Provider-local Discord REST codec. It consumes only host-vended HTTP and a
 * materialized bot token; caller-owned Channel state remains outside this leaf.
 */
export function createDiscordBotApi(input: Readonly<{
  token: string;
  http: DiscordHttp;
}>): DiscordBotApi {
  const token = input.token.trim();
  if (!token) throw new Error('Discord bot token is required.');

  const requestJson = async (
    path: string,
    method: 'GET' | 'POST',
    body: unknown | undefined,
    options?: DiscordRequestOptions,
  ): Promise<Readonly<{ status: number; body: unknown | null }> | null> => {
    try {
      const response = await input.http.request({
        url: apiPath(path),
        method,
        headers: {
          authorization: `Bot ${token}`,
          'user-agent': DISCORD_HTTP_USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: encodeJson(body) }),
        redirect: 'error',
        timeoutMs: 15_000,
      }, options);
      return { status: response.status, body: parseJson(response.body) };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return null;
    }
  };

  return {
    async getIdentity(options) {
      const applicationResponse = await requestJson('/oauth2/applications/@me', 'GET', undefined, options);
      if (!applicationResponse) return { kind: 'notReady', reason: 'network' };
      if (applicationResponse.status < 200 || applicationResponse.status >= 300) {
        return failureFromResponse(applicationResponse.status, applicationResponse.body);
      }
      const applicationId = isRecord(applicationResponse.body) ? nonEmptyString(applicationResponse.body.id) : null;
      if (!applicationId) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Discord returned an invalid application identity.' };
      }
      const applicationMessageContentIntentPermission = readDiscordApplicationMessageContentIntentPermission(
        applicationResponse.body,
      );

      const userResponse = await requestJson('/users/@me', 'GET', undefined, options);
      if (!userResponse) return { kind: 'notReady', reason: 'network' };
      if (userResponse.status < 200 || userResponse.status >= 300) {
        return failureFromResponse(userResponse.status, userResponse.body);
      }
      const botUserId = isRecord(userResponse.body) ? nonEmptyString(userResponse.body.id) : null;
      const username = isRecord(userResponse.body) ? nonEmptyString(userResponse.body.username) : null;
      if (!botUserId || !username || !isRecord(userResponse.body) || userResponse.body.bot !== true) {
        return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: 'Discord did not confirm a bot user for this token.' };
      }
      const globalName = nonEmptyString(userResponse.body.global_name);
      return { applicationId, botUserId, botLabel: globalName ?? username, applicationMessageContentIntentPermission };
    },

    async getGatewayBot(options) {
      const response = await requestJson('/gateway/bot', 'GET', undefined, options);
      if (!response) return { kind: 'notReady', reason: 'network' };
      if (response.status < 200 || response.status >= 300) return failureFromResponse(response.status, response.body);
      const gatewayBot = parseGatewayBot(response.body);
      return gatewayBot ?? {
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord returned an invalid Gateway Bot response.',
      };
    },

    async getChannel(inputValue, options) {
      const channelId = inputValue.channelId.trim();
      if (!channelId) return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Discord channel ID is required.' };
      const response = await requestJson(`/channels/${encodeURIComponent(channelId)}`, 'GET', undefined, options);
      if (!response) return { kind: 'notReady', reason: 'network' };
      if (response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) return failureFromResponse(response.status, response.body);
      return parseKnownChannel(response.body, channelId) ?? {
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord returned an invalid channel response.',
      };
    },

    async getGuildMember(inputValue, options) {
      const guildId = inputValue.guildId.trim();
      const userId = inputValue.userId.trim();
      if (!guildId || !userId) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Discord guild and user IDs are required.' };
      }
      const response = await requestJson(
        `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
        'GET',
        undefined,
        options,
      );
      if (!response) return { kind: 'notReady', reason: 'network' };
      if (response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) return failureFromResponse(response.status, response.body);
      return parseGuildMemberRoleEvidence(response.body, userId) ?? {
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord returned invalid current bot-member role evidence.',
      };
    },

    async getGuildRoles(inputValue, options) {
      const guildId = inputValue.guildId.trim();
      if (!guildId) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Discord guild ID is required.' };
      }
      const response = await requestJson(
        `/guilds/${encodeURIComponent(guildId)}/roles`,
        'GET',
        undefined,
        options,
      );
      if (!response) return { kind: 'notReady', reason: 'network' };
      if (response.status < 200 || response.status >= 300) return failureFromResponse(response.status, response.body);
      return parseGuildRolePermissionEvidence(response.body) ?? {
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord returned invalid current guild role permission evidence.',
      };
    },

    async sendMessage(inputValue, options) {
      const channelId = inputValue.channelId.trim();
      if (!channelId) return { kind: 'outcomeUnknown' };
      const response = await requestJson(
        `/channels/${encodeURIComponent(channelId)}/messages`,
        'POST',
        inputValue.payload,
        options,
      );
      if (!response) return { kind: 'outcomeUnknown' };
      return classifyDiscordDeliveryResponse({
        status: response.status,
        body: response.body,
        canManageThreads: inputValue.canManageThreads,
      });
    },
  };
}
