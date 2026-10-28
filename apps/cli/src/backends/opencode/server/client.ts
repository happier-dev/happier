import { logger } from '@/ui/logger';
import { normalizeOpenCodeCliGeneration } from '@happier-dev/agents';
import { normalizeOpenCodeAppSkills } from '@happier-dev/protocol';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
} from '@/backends/opencode/brokerPlugin';

import { resolveOpenCodeServerAuthHeadersFromEnv } from './openCodeServerAuth';
import { subscribeSseJson } from './openCodeSse';
import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodeSession } from './types';
import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';
import { isOpenCodeServerReadyResponse, OPEN_CODE_AUTO_READINESS_PATHS, OPEN_CODE_V2_READINESS_PATHS } from './openCodeServerReadiness';
import { normalizeOpenCodeV2Event, normalizeOpenCodeV2PermissionRequest } from './openCodeV2EventAdapter';
import {
  buildOpenCodeV2FormAnswer,
  projectOpenCodeV2Form,
  type OpenCodeV2FormProjection,
} from './openCodeV2Forms';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  isLoopbackManagedOpenCodeBaseUrl,
  readSharedManagedOpenCodeServerStateByBaseUrlBestEffort,
  readSharedManagedOpenCodeServerStateBestEffort,
  retainSharedManagedOpenCodeServerClient,
  withSharedManagedOpenCodeServerAccess,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';
import {
  isSameOpenCodeManagedServerGeneration,
  resolveOpenCodeManagedServerIdentity,
  type OpenCodeManagedServerIdentity,
  type OpenCodeManagedServerIdentityChange,
  type OpenCodeManagedServerIdentityChangeReason,
} from './openCodeManagedServerIdentity';
import { applyOpenCodeManagedServerAuthHeaders } from './openCodeManagedServerCredential';
import { resolveOpenCodeAttachTargetAuthHeaders } from '../localControl/openCodeAttachTargetAuth';

type PermissionReply = 'once' | 'always' | 'reject';

function requiresOpenCodeBrokerLoadNonce(env: NodeJS.ProcessEnv): boolean {
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  return OPEN_CODE_BROKER_PROVIDERS.some((provider) => selections[provider]);
}

function applyManagedOpenCodeBrokerLoadNonce(
  env: NodeJS.ProcessEnv,
  state: SharedManagedOpenCodeServerState | null,
): void {
  const nonce = typeof state?.brokerLoadNonce === 'string' ? state.brokerLoadNonce.trim() : '';
  if (nonce) {
    env[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = nonce;
    return;
  }
  if (requiresOpenCodeBrokerLoadNonce(env)) {
    delete env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (typeof v === 'string' && v.length > 0) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

function redactOpenCodeUrlForError(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('directory')) {
      url.searchParams.set('directory', '<redacted>');
    }
    return url.toString();
  } catch {
    // Best-effort redaction for non-URL strings.
    return String(rawUrl ?? '').replace(/([?&]directory=)[^&#]*/gu, '$1<redacted>');
  }
}

function resolveOpenCodeServerHttpTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS;
  const defaultTimeoutMs = 60_000;
  if (typeof raw !== 'string') return defaultTimeoutMs;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTimeoutMs;
  // Pre-session probes pass their remaining deadline, which may be less than one second.
  return Math.min(120_000, Math.trunc(parsed));
}

export function resolveOpenCodeSseReadIdleTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS;
  if (typeof raw !== 'string') return null;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed === 0) return null;
  return Math.max(5_000, Math.min(120_000, Math.trunc(parsed)));
}

async function fetchOpenCodeJson<T>(params: {
  url: string;
  method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}): Promise<T> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? params.timeoutMs : null;
  const ctrl = timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ctrl?.abort();
      }, timeoutMs)
    : null;
  timer?.unref?.();

  let response: Response;
  try {
    response = await fetch(params.url, {
      method: params.method,
      headers: {
        ...params.headers,
        ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      ...(ctrl || params.signal
        ? { signal: ctrl && params.signal ? AbortSignal.any([ctrl.signal, params.signal]) : (ctrl?.signal ?? params.signal) }
        : {}),
    });
  } catch (error) {
    if (timedOut && timeoutMs) {
      throw new Error(`OpenCode HTTP ${params.method} ${redactOpenCodeUrlForError(params.url)} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    // Provider error bodies can echo prompt content or credentials. Keep request diagnostics to
    // method, redacted URL, and HTTP status; do not deserialize or log the response body.
    void response.body?.cancel().catch(() => {});
    throw new Error(
      `OpenCode HTTP ${params.method} ${redactOpenCodeUrlForError(params.url)} failed: ${response.status} ${response.statusText}`
    );
  }
  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}

type ManagedServerTransportFailureKind =
  | 'fetch_failed'
  | 'connection_refused'
  | 'connection_reset'
  | 'socket_hang_up'
  | 'connect_error'
  | 'terminated'
  | 'network_error'
  | 'peer_closed';

type ManagedServerRetryOperation =
  | 'session_messages_list'
  | 'session_update'
  | 'session_todo'
  | 'session_diff'
  | 'session_status_list'
  | 'permission_list'
  | 'question_list';

function classifyRetryableManagedServerTransportError(error: unknown): ManagedServerTransportFailureKind | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized.startsWith('opencode http ')) return null;
  if (normalized.includes('fetch failed')) return 'fetch_failed';
  if (normalized.includes('econnrefused')) return 'connection_refused';
  if (normalized.includes('econnreset')) return 'connection_reset';
  if (normalized.includes('socket hang up')) return 'socket_hang_up';
  if (normalized.includes('connect_error')) return 'connect_error';
  if (normalized.includes('terminated')) return 'terminated';
  if (normalized.includes('networkerror')) return 'network_error';
  if (normalized.includes('other side closed')) return 'peer_closed';
  return null;
}

function isOpenCodeSseReadIdleTimeoutError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'OPENCODE_SSE_READ_IDLE_TIMEOUT',
  );
}

export type OpenCodeGlobalEventDelivery = Readonly<{
  /**
   * OpenCode's directory-scoped `/event` route establishes its own connection boundary. For V2
   * sessions owned by this runtime, Happier establishes the equivalent boundary only after the
   * replay-capable session stream opens. Frames after either boundary are accepted live.
   */
  provenance: 'connection-boundary' | 'accepted-live';
  connectionGeneration: number;
}>;

export type OpenCodeMcpStatus = Readonly<
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth'; error?: string }
  | { status: 'needs_client_registration'; error: string }
>;

/** Reads one entry from a V1 `/mcp` status map, or a released V2 `Mcp.Server` status object. */
function readOpenCodeMcpStatusRecord(rawStatus: unknown, serverName: string): OpenCodeMcpStatus {
  if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
    throw new Error(`OpenCode MCP registration response omitted status for "${serverName}"`);
  }
  const record = rawStatus as Record<string, unknown>;
  const status = record.status;
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  if (status === 'connected' || status === 'disabled' || status === 'pending') {
    return { status };
  }
  if (status === 'needs_auth') {
    // V1 omits the error; released V2 requires it. Accept both and keep whatever detail exists.
    return error ? { status, error } : { status };
  }
  if (status === 'failed' || status === 'needs_client_registration') {
    if (!error) {
      throw new Error(`OpenCode MCP registration returned status "${status}" without an error for "${serverName}"`);
    }
    return { status, error };
  }
  throw new Error(`OpenCode MCP registration returned an unknown status for "${serverName}"`);
}

function readOpenCodeMcpStatus(response: unknown, serverName: string): OpenCodeMcpStatus {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`OpenCode MCP registration returned an invalid status map for "${serverName}"`);
  }
  return readOpenCodeMcpStatusRecord((response as Record<string, unknown>)[serverName], serverName);
}

/**
 * Released V2 `Mcp.LocalConfig`/`Mcp.RemoteConfig` are parsed strictly and express opt-out as
 * `disabled`; Happier's shared MCP config (and V1's `/mcp`) uses `enabled`. Translate at the wire
 * boundary so an unknown key never fails the request.
 */
/**
 * Happier builds its session ruleset in the V1 `{ permission, pattern, action }` shape. Released
 * V2 parses `Permission.Rule` strictly as `{ action, resource, effect }`, so the rename happens at
 * the wire seam and the V1 producer stays untouched. Rules that are already in the released shape
 * pass through, so an upstream-shaped ruleset is never double-renamed.
 */
function toOpenCodeV2PermissionRuleset(permission: readonly unknown[]): unknown[] {
  return permission.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return rule;
    const record = rule as Record<string, unknown>;
    if (typeof record.effect === 'string' && typeof record.resource === 'string') return record;
    const { permission: action, pattern: resource, action: effect, ...rest } = record;
    if (typeof action !== 'string' || typeof effect !== 'string') return record;
    return { ...rest, action, resource: typeof resource === 'string' ? resource : '*', effect };
  });
}

function toOpenCodeV2McpConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const { enabled, ...rest } = config as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return rest;
  return enabled ? rest : { ...rest, disabled: true };
}

export class OpenCodeServerCommandUnsupportedError extends Error {
  readonly code = 'opencode_command_unsupported' as const;
  readonly reason: 'delivery' | 'attachments';

  constructor(reason: 'delivery' | 'attachments') {
    super(reason === 'delivery'
      ? 'OpenCode V1 commands do not support steer or queue delivery'
      : 'OpenCode V1 commands support only file attachments');
    this.name = 'OpenCodeServerCommandUnsupportedError';
    this.reason = reason;
  }
}

export type OpenCodeServerRuntimeClient = Readonly<{
  getApiGeneration: () => Promise<'v1' | 'v2'>;
  supportsInFlightSteer: () => boolean;
  /** Returns true when changing directory restarted the directory-scoped event stream. */
  setDirectoryOverride: (directory: string) => boolean;
  sessionList: () => Promise<unknown[]>;
  sessionCreate: (opts?: { permission?: unknown[] }) => Promise<OpenCodeSession>;
  sessionGet: (opts: { sessionId: string }) => Promise<OpenCodeSession>;
  sessionUpdate: (opts: { sessionId: string; permission?: unknown[]; title?: string; time?: { archived?: number } }) => Promise<OpenCodeSession>;
  /** V2 durably selects the native session model; V1 selection remains frontend-local. */
  sessionSetModel: (opts: { sessionId: string; model?: OpenCodeModelRef; variant?: string }) => Promise<void>;
  /** V2 durably selects the native session agent; V1 keeps its prompt-owned selection. */
  sessionSetAgent: (opts: { sessionId: string; agent: string }) => Promise<void>;
  sessionMessagesList: (opts: { sessionId: string }) => Promise<unknown[]>;
  /** Raw provider envelope reserved for fail-closed authoritative inventory readers. */
  sessionMessagesListRaw?: (opts: { sessionId: string }) => Promise<unknown>;
  sessionTodo: (opts: { sessionId: string }) => Promise<unknown[]>;
  sessionDiff: (opts: { sessionId: string; messageId?: string }) => Promise<unknown[]>;
  sessionStatusList: () => Promise<Record<string, { type?: string }>>;
  globalConfigGet: () => Promise<{ model?: string }>;
  agentsList: () => Promise<ReadonlyArray<{ id?: string; name: string; description?: string }>>;
  appCommands: () => Promise<unknown[]>;
  appSkills: () => Promise<unknown[]>;
  providersList: () => Promise<ReadonlyArray<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>>;
  mcpAdd: (opts: { directory?: string; name: string; config: unknown }) => Promise<OpenCodeMcpStatus>;
  mcpDisconnect: (opts: { directory: string; name: string }) => Promise<void>;
  sessionPromptAsync: (opts: {
    sessionId: string;
    messageId?: string;
    parts: unknown[];
    agent?: string;
    model?: OpenCodeModelRef;
    variant?: string;
    config?: Record<string, unknown>;
    delivery?: 'steer' | 'queue';
  }) => Promise<void>;
  sessionCommand: (opts: {
    sessionId: string;
    command: string;
    arguments: string;
    messageId?: string;
    parts?: readonly unknown[];
    agent?: string;
    model?: OpenCodeModelRef;
    variant?: string;
    delivery?: 'steer' | 'queue';
  }) => Promise<void>;
  sessionSummarize: (opts: {
    sessionId: string;
    model: OpenCodeModelRef;
    auto?: boolean;
  }) => Promise<void>;
  sessionAbort: (opts: { sessionId: string }) => Promise<void>;
  sessionFork: (opts: { sessionId: string; messageId?: string }) => Promise<OpenCodeSession>;
  permissionList: () => Promise<unknown[]>;
  questionList: () => Promise<unknown[]>;
  questionReply: (opts: { requestId: string; answers: string[][] }) => Promise<boolean>;
  questionReject: (opts: { requestId: string }) => Promise<boolean>;
  permissionReply: (opts: { requestId: string; reply: PermissionReply }) => Promise<boolean>;
  subscribeGlobalEvents: (opts: {
    sessionId?: string | null;
    signal: AbortSignal;
    onEvent: (evt: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
  }) => Promise<void>;
  getManagedServerIdentity: () => OpenCodeManagedServerIdentity | null;
  dispose: () => Promise<void>;
}>;

function resolveSseReconnectDelayMs(attempt: number, env: NodeJS.ProcessEnv): number {
  const baseRaw = Number.parseInt(String(env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS ?? ''), 10);
  const maxRaw = Number.parseInt(String(env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS ?? ''), 10);
  const baseMs = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.trunc(baseRaw) : 250;
  const maxMs = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.trunc(maxRaw) : 5_000;

  const clampedBase = Math.max(5, Math.min(30_000, baseMs));
  const clampedMax = Math.max(clampedBase, Math.min(120_000, maxMs));

  const exp = Math.min(20, Math.max(0, Math.trunc(attempt)));
  const rawDelay = Math.min(clampedMax, clampedBase * (2 ** exp));
  // Add a small jitter so multiple sessions don't reconnect in lockstep.
  const jitter = Math.floor(rawDelay * 0.15 * Math.random());
  return Math.min(clampedMax, rawDelay + jitter);
}

function readOpenCodeProviderList(raw: unknown): ReadonlyArray<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }> {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!Array.isArray(record?.all)) throw new Error('Invalid OpenCode provider inventory');
  const all = record.all.filter((provider) => {
    const candidate = provider && typeof provider === 'object' && !Array.isArray(provider)
      ? provider as Record<string, unknown> : null;
    return typeof candidate?.id === 'string' && candidate.id.trim().length > 0;
  }) as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;
  if (record.all.length > 0 && all.length === 0) throw new Error('Invalid OpenCode provider inventory');
  const connectedRaw = Array.isArray(record?.connected) ? record.connected : null;
  if (!connectedRaw) return all as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;

  const connected = new Set(
    connectedRaw
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter((value) => value.length > 0),
  );

  return all.filter((provider) => {
    const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
    return id.length > 0 && connected.has(id);
  }) as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;
}

/**
 * Released V2 serves no V1 surface: it has neither `/global/health` nor `/mcp`. The preview-era
 * "dual surface" flags that let V2 fall back to V1 routes are gone with the routes that needed
 * them, so the generation alone selects the dialect.
 */
type OpenCodeApiGeneration = Readonly<{ kind: 'v1' | 'v2' }>;

function readWrappedOpenCodeV2Data(raw: unknown): unknown {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).data : undefined;
}

function normalizeOpenCodeV2Session(raw: unknown): OpenCodeSession {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const location = record.location && typeof record.location === 'object' && !Array.isArray(record.location)
    ? record.location as Record<string, unknown>
    : null;
  const normalized: Record<string, unknown> = {
    ...record,
    id: typeof record.id === 'string' ? record.id : '',
    ...(typeof location?.directory === 'string' ? { directory: location.directory } : {}),
  };
  delete normalized.location;
  return normalized as OpenCodeSession;
}

/**
 * Released V2 assistant messages carry no `parentID`; Happier's turn-completion inventory anchors
 * an assistant message to the user message that started its turn. The chronological list is the
 * only place that relation exists, so it is inferred once over the fully paged list rather than
 * per page, and never overwrites an id the provider actually supplied.
 */
function anchorOpenCodeV2AssistantMessages(messages: readonly unknown[]): unknown[] {
  let lastUserMessageId = '';
  return messages.map((message) => {
    const record = message && typeof message === 'object' && !Array.isArray(message)
      ? message as Record<string, unknown>
      : null;
    const info = record?.info && typeof record.info === 'object' && !Array.isArray(record.info)
      ? record.info as Record<string, unknown>
      : null;
    if (!record || !info) return message;
    const id = typeof info.id === 'string' ? info.id : '';
    if (info.role === 'user') {
      if (id) lastUserMessageId = id;
      return message;
    }
    if (info.role !== 'assistant') return message;
    if (typeof info.parentID === 'string' && info.parentID.length > 0) return message;
    if (!lastUserMessageId) return message;
    return { ...record, info: { ...info, parentID: lastUserMessageId } };
  });
}

function normalizeOpenCodeV2Message(raw: unknown, sessionId: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const message = raw as Record<string, unknown>;
  const type = typeof message.type === 'string' ? message.type : '';
  const role = type === 'user' || type === 'assistant' ? type : type;
  const info: Record<string, unknown> = { ...message, role, sessionID: sessionId };
  const model = message.model && typeof message.model === 'object' && !Array.isArray(message.model)
    ? message.model as Record<string, unknown>
    : null;
  if (typeof model?.id === 'string' && typeof model.providerID === 'string') {
    const normalizedModel: Record<string, unknown> = { ...model, modelID: model.id };
    delete normalizedModel.id;
    info.model = normalizedModel;
  }
  delete info.type;
  delete info.text;
  delete info.content;
  const parts = Array.isArray(message.content)
    ? message.content.map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const record = part as Record<string, unknown>;
        return {
          ...record,
          sessionID: sessionId,
          messageID: message.id,
          ...(record.type === 'tool' ? { callID: record.id, tool: record.name } : {}),
        };
      })
    : type === 'user' && typeof message.text === 'string'
      ? [{ type: 'text', text: message.text }]
      : [];
  return { info, parts };
}

export class OpenCodeSkillIdentityError extends Error {
  readonly code = 'opencode_skill_identity_missing';
  constructor() {
    super('OpenCode skill selection has no unique native identity');
    this.name = 'OpenCodeSkillIdentityError';
  }
}

function projectOpenCodeV1PromptParts(parts: unknown[]): unknown[] {
  return parts.map((part) => {
    const record = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null;
    return record?.type === 'skill' && typeof record.text === 'string'
      ? { type: 'text', text: record.text, synthetic: true } : part;
  });
}

/**
 * Released V2 `POST /api/session/:id/prompt` takes a flat `PromptInput` body
 * (`{ text, files?, agents?, skills?, metadata? }`); the earlier preview nested it under `prompt`.
 */
function buildOpenCodeV2Prompt(parts: unknown[]): Record<string, unknown> {
  const text: string[] = [];
  const files: unknown[] = [];
  const agents: Array<{ name: string }> = [];
  const skills: Array<{ id: string }> = [];
  for (const part of parts) {
    const record = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null;
    if (record?.type === 'text' && typeof record.text === 'string') text.push(record.text);
    else if (
      record?.type === 'file'
      && typeof record.url === 'string'
      && typeof record.mime === 'string'
    ) {
      files.push({
        uri: record.url,
        ...(typeof record.filename === 'string' ? { name: record.filename } : {}),
      });
    }
    else if (record?.type === 'agent' && typeof record.name === 'string') {
      agents.push({ name: record.name });
    }
    else if (record?.type === 'skill') {
      if (typeof record.id !== 'string' || !record.id.trim()) throw new OpenCodeSkillIdentityError();
      skills.push({ id: record.id });
    }
    else throw new Error('OpenCode V2 prompt contains an unsupported part');
  }
  return {
    text: text.join('\n\n'),
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(skills.length > 0 ? { skills } : {}),
  };
}

async function sleepUntilOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const cleanup = (onAbort: () => void, timer: ReturnType<typeof setTimeout>) => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup(onAbort, timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(onAbort, timer);
      resolve();
    }, ms);
    timer.unref?.();

    signal.addEventListener('abort', onAbort);
  });
}

type OpenCodeServerRuntimeClientParams = Readonly<{
  directory: string;
  messageBuffer: MessageBuffer;
  baseUrlOverride?: string | null;
  managedServerLaunchFingerprint?: string | null;
  env?: NodeJS.ProcessEnv;
  onManagedServerIdentityChanged?: (change: OpenCodeManagedServerIdentityChange) => void;
}>;

export async function createOpenCodeServerRuntimeClient(params: OpenCodeServerRuntimeClientParams): Promise<OpenCodeServerRuntimeClient> {
  const env = params.env ?? process.env;
  const explicitBaseUrl = params.baseUrlOverride?.trim() || env.HAPPIER_OPENCODE_SERVER_URL?.trim();
  return await withSharedManagedOpenCodeServerAccess(async () => {
    const { client, baseUrl } = await createOpenCodeServerRuntimeClientUnderLock({ ...params, env }, explicitBaseUrl);
    let release: () => Promise<void>;
    try {
      release = await retainSharedManagedOpenCodeServerClient(baseUrl, !explicitBaseUrl, params.managedServerLaunchFingerprint);
    } catch (error) {
      await client.dispose();
      throw error;
    }
    const dispose = client.dispose;
    let disposal: Promise<void> | undefined;
    return {
      ...client,
      dispose: () => disposal ??= (async () => {
        await dispose();
        await release().catch(error => logger.warn('[OpenCodeServer] Client release failed; retaining custody', error));
      })(),
    };
  }, explicitBaseUrl, params.managedServerLaunchFingerprint);
}

async function createOpenCodeServerRuntimeClientUnderLock(
  params: OpenCodeServerRuntimeClientParams & { env: NodeJS.ProcessEnv },
  explicitBaseUrl: string | undefined,
): Promise<{
  client: OpenCodeServerRuntimeClient; baseUrl: string;
}> {
  const env = params.env;
  let disposed = false;
  const commandAbort = new AbortController();
  const pendingRequests = new Set<Promise<unknown>>();
  const trackRequest = <T>(promise: Promise<T>): Promise<T> => {
    pendingRequests.add(promise);
    void promise.then(() => pendingRequests.delete(promise), () => pendingRequests.delete(promise));
    return promise;
  };
  const fetchJson = <T>(request: Parameters<typeof fetchOpenCodeJson>[0]): Promise<T> => {
    if (disposed) return Promise.reject(new Error('OpenCode client disposed'));
    return trackRequest(fetchOpenCodeJson<T>({
      ...request,
      signal: request.signal ? AbortSignal.any([request.signal, commandAbort.signal]) : commandAbort.signal,
    }));
  };
  const httpTimeoutMs = resolveOpenCodeServerHttpTimeoutMs(env);
  const readIdleTimeoutMs = resolveOpenCodeSseReadIdleTimeoutMs(env);
  const usingManagedServer = !explicitBaseUrl;

  const headers = resolveOpenCodeServerAuthHeadersFromEnv(env);

  let directoryOverride = '';
  const resolveDirectory = (): string => {
    const normalized = directoryOverride.trim() || params.directory.trim();
    return normalized;
  };

  const probeHealth = async (
    candidateBaseUrl: string,
    apiGeneration: 'auto' | 'v2' = 'auto',
  ): Promise<boolean> => {
    try {
      const probeTimeoutMs = httpTimeoutMs ? Math.min(2_000, httpTimeoutMs) : 900;
      const paths = apiGeneration === 'v2'
          ? OPEN_CODE_V2_READINESS_PATHS
          : OPEN_CODE_AUTO_READINESS_PATHS;
      for (const path of paths) {
        const body = await fetchJson<unknown>({
          url: buildUrl(candidateBaseUrl, path), method: 'GET', headers, timeoutMs: probeTimeoutMs,
        }).catch(() => null);
        if (isOpenCodeServerReadyResponse(path, body)) return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  let baseUrl = normalizeBaseUrl(
    explicitBaseUrl
      || await ensureSharedManagedOpenCodeServerBaseUrl({
        probeHealth,
        requireBrokerLoadNonce: requiresOpenCodeBrokerLoadNonce(env),
      }),
  );
  let apiGeneration: (OpenCodeApiGeneration & { key: string }) | null = null;
  let lastObservedExternalApiGeneration: OpenCodeApiGeneration['kind'] | null = null;
  const permissionSessionByRequestId = new Map<string, string>();
  const questionSessionByRequestId = new Map<string, string>();
  // Released V2 answers a form by field key, so the projected field order, hidden defaults and
  // conditional rules must survive until reply.
  const questionFormProjectionByRequestId = new Map<string, OpenCodeV2FormProjection>();
  const todosBySessionId = new Map<string, unknown[]>();

  const clearGenerationSpecificRequestState = (): void => {
    permissionSessionByRequestId.clear();
    questionSessionByRequestId.clear();
    questionFormProjectionByRequestId.clear();
    todosBySessionId.clear();
  };

  const rememberOpenCodeV2FormProjection = (projection: OpenCodeV2FormProjection): void => {
    questionSessionByRequestId.set(projection.request.id, projection.request.sessionID);
    questionFormProjectionByRequestId.set(projection.request.id, projection);
  };

  // Managed-server generation identity. The runtime uses this to detect mid-turn server replacement
  // (Lane E). It is tracked only in managed mode; explicit URL / override modes never emit changes.
  let managedServerIdentity: OpenCodeManagedServerIdentity | null = null;

  const captureManagedServerIdentityFromState = (
    state: SharedManagedOpenCodeServerState | null,
    reason: OpenCodeManagedServerIdentityChangeReason,
  ): void => {
    if (!usingManagedServer) return;
    if (!state || typeof state.baseUrl !== 'string' || !isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      return;
    }
    const nextIdentity = resolveOpenCodeManagedServerIdentity(state);
    if (isSameOpenCodeManagedServerGeneration(managedServerIdentity, nextIdentity)) {
      // Same process generation: refresh the normalized fields without surfacing a change.
      managedServerIdentity = nextIdentity;
      return;
    }
    const previous = managedServerIdentity;
    managedServerIdentity = nextIdentity;
    apiGeneration = null;
    clearGenerationSpecificRequestState();
    // The initial baseline must not surface as a "change"; only genuine replacements do.
    if (reason === 'initial') return;
    try {
      params.onManagedServerIdentityChanged?.({ previous, current: nextIdentity, reason });
    } catch {
      // Identity-change observers must never destabilize the client transport loop.
    }
  };

  if (params.managedServerLaunchFingerprint != null) {
    delete headers.Authorization;
    Object.assign(headers, await resolveOpenCodeAttachTargetAuthHeaders({
      baseUrl,
      env,
      managedServerLaunchFingerprint: params.managedServerLaunchFingerprint,
    }));
  } else if (usingManagedServer || isLoopbackManagedOpenCodeBaseUrl(baseUrl)) {
    // An internal caller may pass the exact managed loopback endpoint as an override. Consume its
    // retained credential only when the state owner confirms that exact normalized base URL; the
    // credential helper falls back to ambient external auth for any mismatch, so a managed secret
    // is never sent to another loopback or remote endpoint.
    const initialState = await (usingManagedServer
      ? readSharedManagedOpenCodeServerStateBestEffort()
      : readSharedManagedOpenCodeServerStateByBaseUrlBestEffort(baseUrl))
      .catch(() => null);
    applyOpenCodeManagedServerAuthHeaders(headers, { state: initialState, baseUrl, env });
    if (usingManagedServer) {
      // Establish the baseline generation so a later replacement is detectable. Best-effort: a
      // missing state file simply leaves identity null until the first refresh observes a server.
      applyManagedOpenCodeBrokerLoadNonce(env, initialState);
      captureManagedServerIdentityFromState(initialState, 'initial');
    }
  }

  const refreshBaseUrlIfManagedBestEffort = async (opts: Readonly<{
    allowEnsure: boolean;
    reason: OpenCodeManagedServerIdentityChangeReason;
  }>): Promise<void> => {
    if (!usingManagedServer || disposed) return;

    const state = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
    applyManagedOpenCodeBrokerLoadNonce(env, state);
    if (state?.baseUrl && isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      const normalized = normalizeBaseUrl(state.baseUrl);
      if (normalized && normalized !== baseUrl) {
        baseUrl = normalized;
      }
    }
    applyOpenCodeManagedServerAuthHeaders(headers, { state, baseUrl, env });

    if (!opts.allowEnsure) {
      // SSE-reconnect refresh: never ensures/replaces a server. Surface an identity change only if
      // the already-written state points at a new managed-server generation.
      captureManagedServerIdentityFromState(state, opts.reason);
      return;
    }

    // Transport-level request failures can refresh the managed server. SSE disconnects use
    // allowEnsure=false above so a quiet event stream cannot kill or replace a slow server.
    if (!state) {
      const healthy = await probeHealth(baseUrl).catch(() => false);
      if (healthy) return;
    } else {
      const pidAlive = (() => {
        try {
          process.kill(state.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (pidAlive) {
        const healthy = await probeHealth(baseUrl).catch(() => false);
        if (healthy) return;
      }
    }

    if (disposed) return;
    try {
      baseUrl = normalizeBaseUrl(
        await ensureSharedManagedOpenCodeServerBaseUrl({
          probeHealth,
          requireBrokerLoadNonce: requiresOpenCodeBrokerLoadNonce(env),
        }),
      );
    } catch {
      // Ignore (caller will retry with backoff).
    }

    // After an ensure, the managed server may have been replaced on a new port/pid. Re-read the
    // freshly written state and surface a generation change if the process identity differs.
    const stateAfterEnsure = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
    applyManagedOpenCodeBrokerLoadNonce(env, stateAfterEnsure);
    applyOpenCodeManagedServerAuthHeaders(headers, { state: stateAfterEnsure, baseUrl, env });
    captureManagedServerIdentityFromState(stateAfterEnsure, opts.reason);
  };

  const waitForManagedServerHealthAfterRefreshBestEffort = async (): Promise<void> => {
    if (!usingManagedServer || disposed) return;
    try {
      await trackRequest(waitForOpenCodeServerHealth({
        baseUrl,
        timeoutMs: 2_000,
        pollIntervalMs: 100,
        headers,
        signal: commandAbort.signal,
      }));
    } catch {
      // best-effort only; caller will decide whether to propagate the original error
    }
  };

  const ensureApiGeneration = async (): Promise<OpenCodeApiGeneration> => {
    const key = `${baseUrl}:${managedServerIdentity?.generationKey ?? ''}`;
    if (apiGeneration?.key === key) return apiGeneration;
    const rememberDetectedGeneration = (detected: OpenCodeApiGeneration): OpenCodeApiGeneration & { key: string } => {
      if (!usingManagedServer) {
        if (lastObservedExternalApiGeneration !== null && lastObservedExternalApiGeneration !== detected.kind) {
          clearGenerationSpecificRequestState();
        }
        lastObservedExternalApiGeneration = detected.kind;
      }
      apiGeneration = { key, ...detected };
      return apiGeneration;
    };
    const probe = async (path: string): Promise<unknown> => {
      try {
        return await fetchJson<unknown>({
          url: buildUrl(baseUrl, path), method: 'GET', headers,
          timeoutMs: Math.min(2_000, httpTimeoutMs ?? 2_000),
        });
      } catch {
        return null;
      }
    };
    // Persisted readiness hints may come from older clients that mistook stable
    // /api/health for V2. Resolve routes from the authenticated server contract.
    const legacy = await probe('/global/health');
    const legacyRecord = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy as Record<string, unknown> : null;
    if (legacyRecord?.healthy === true
      && typeof legacyRecord.version === 'string'
      && normalizeOpenCodeCliGeneration(env.HAPPIER_OPENCODE_CLI_GENERATION) !== 'v2') {
      return rememberDetectedGeneration({ kind: 'v1' });
    }
    const v2Health = await probe('/api/health');
    const v2Info = isOpenCodeServerReadyResponse('/api/health', v2Health)
      ? null
      : await probe('/api/info');
    if (isOpenCodeServerReadyResponse('/api/health', v2Health)
      || isOpenCodeServerReadyResponse('/api/info', v2Info)) {
      return rememberDetectedGeneration({ kind: 'v2' });
    }
    throw new Error('OpenCode server generation detection failed: neither authenticated V2 nor V1 health contract is available');
  };

  const refreshTransportForSseReconnect = async (): Promise<void> => {
    await refreshBaseUrlIfManagedBestEffort({ allowEnsure: false, reason: 'sse_reconnect_state_refresh' });
    if (!usingManagedServer) {
      apiGeneration = null;
    }
  };

  const fetchJsonWithManagedServerRetry = async <T>(
    diagnostic: Readonly<{
      operation: ManagedServerRetryOperation;
      method: 'GET' | 'PATCH';
    }>,
    request: (currentBaseUrl: string) => Promise<T>,
  ): Promise<T> => {
    try {
      return await request(baseUrl);
    } catch (error) {
      const failureKind = classifyRetryableManagedServerTransportError(error);
      if (!usingManagedServer || !failureKind) {
        throw error;
      }
      logger.debug('[OpenCodeServer] Retrying managed HTTP request after transient transport failure', {
        operation: diagnostic.operation,
        method: diagnostic.method,
        failedAttempt: 1,
        nextAttempt: 2,
        failureKind,
      });
      await refreshBaseUrlIfManagedBestEffort({ allowEnsure: true, reason: 'http_retry_ensure' });
      await waitForManagedServerHealthAfterRefreshBestEffort();
      return await request(baseUrl);
    }
  };

  // Detect once per server generation at the authenticated transport boundary.
  try {
    await ensureApiGeneration();
  } catch (error) {
    logger.debug('[OpenCodeServer] Health probe failed (non-fatal)', error);
  }

  let subscription: Awaited<ReturnType<typeof subscribeSseJson<OpenCodeGlobalEvent>>> | null = null;
  let subscriptionLoop: Promise<void> | null = null;
  let subscriptionLoopAbort: AbortController | null = null;
  let connectionGeneration = 0;

  const rememberRequestSessions = (items: unknown[], target: Map<string, string>): void => {
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id === 'string' && typeof record.sessionID === 'string') {
        target.set(record.id, record.sessionID);
      }
    }
  };

  const fetchSessionMessagesListRaw = async (sessionId: string): Promise<unknown> => (
    await fetchJsonWithManagedServerRetry({ operation: 'session_messages_list', method: 'GET' }, async (currentBaseUrl) => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') {
        return await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/message`, { directory: resolveDirectory() }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
      }

      const messages: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/api/session/${encodeURIComponent(sessionId)}/message`, cursor ? { cursor } : { order: 'asc' }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        const data = readWrappedOpenCodeV2Data(raw);
        if (!Array.isArray(data)) return data;
        messages.push(...data.map((message) => normalizeOpenCodeV2Message(message, sessionId)));

        const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
        const cursorEnvelope = envelope?.cursor && typeof envelope.cursor === 'object' && !Array.isArray(envelope.cursor)
          ? envelope.cursor as Record<string, unknown>
          : null;
        const nextCursor = typeof cursorEnvelope?.next === 'string' ? cursorEnvelope.next : '';
        if (!nextCursor) return anchorOpenCodeV2AssistantMessages(messages);
        if (seenCursors.has(nextCursor)) {
          throw new Error('OpenCode V2 session message pagination returned a repeated cursor');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    })
  );

  async function resolveOpenCodeV2SkillParts(parts: unknown[]): Promise<unknown[]> {
    const unresolved = parts.filter((part) => {
      const record = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null;
      return record?.type === 'skill' && (typeof record.id !== 'string' || !record.id.trim());
    });
    if (unresolved.length === 0) return parts;
    // Released older UI selections carry name/path instead of the native opaque ID. Resolve
    // only at this V2 compatibility seam, using the same catalog reader and canonical parser.
    const catalog = normalizeOpenCodeAppSkills(await client.appSkills());
    return parts.map((part) => {
      if (!unresolved.includes(part)) return part;
      const record = part as Record<string, unknown>;
      const matches = catalog.filter((skill) => skill.name === record.name
        && (record.path === undefined || skill.path === record.path));
      const match = matches.length === 1 ? matches[0] : undefined;
      if (!match?.id || !match.id.trim()) throw new OpenCodeSkillIdentityError();
      return { ...record, id: match.id };
    });
  }

  const readAppCatalog = async (path: '/command' | '/skill'): Promise<unknown[]> => {
    const api = await ensureApiGeneration();
    const directory = resolveDirectory();
    // Activation and inventory must use the same server and credential despite managed refresh.
    const catalogBaseUrl = baseUrl;
    const catalogHeaders = { ...headers };
    const query = api.kind === 'v2' ? { 'location[directory]': directory } : { directory };
    const read = (route: string) => fetchJson<unknown>({
      url: buildUrl(catalogBaseUrl, route, query), method: 'GET', headers: catalogHeaders,
      timeoutMs: httpTimeoutMs, signal: commandAbort.signal,
    });
    if (api.kind === 'v2') {
      // OpenCode 2.0.15/2.0.20 integration.list awaits Plugin.awaitActivation;
      // command.list and skill.list otherwise expose the cold, empty registry.
      await read('/api/integration');
    }
    const raw = await read(api.kind === 'v2' ? `/api${path}` : path);
    const items = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
    return Array.isArray(items) ? items : [];
  };

  const client: OpenCodeServerRuntimeClient = {
    getApiGeneration: async () => (await ensureApiGeneration()).kind,
    supportsInFlightSteer: () => apiGeneration?.kind === 'v2',
    setDirectoryOverride: (directory) => {
      const previousDirectory = resolveDirectory();
      directoryOverride = typeof directory === 'string' ? directory : '';
      if (resolveDirectory() === previousDirectory) return false;
      // `/event` is directory-scoped. Closing the active stream lets the subscription loop reopen
      // it with the new directory before the runtime admits another prompt.
      subscription?.close();
      return true;
    },
    sessionList: async () => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') {
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, '/session', { directory: resolveDirectory() }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        return Array.isArray(raw) ? raw : [];
      }

      // V2 `GET /api/session` pages from the newest 50 sessions; follow `cursor.next` so callers
      // still observe the directory's full inventory.
      const sessions: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, '/api/session', cursor
            ? { cursor }
            : { directory: resolveDirectory(), order: 'asc' }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        const data = readWrappedOpenCodeV2Data(raw);
        if (!Array.isArray(data)) return sessions;
        sessions.push(...data.map(normalizeOpenCodeV2Session));

        const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
        const cursorEnvelope = envelope?.cursor && typeof envelope.cursor === 'object' && !Array.isArray(envelope.cursor)
          ? envelope.cursor as Record<string, unknown>
          : null;
        const nextCursor = typeof cursorEnvelope?.next === 'string' ? cursorEnvelope.next : '';
        if (!nextCursor) return sessions;
        if (seenCursors.has(nextCursor)) {
          throw new Error('OpenCode V2 session pagination returned a repeated cursor');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    },
    sessionCreate: async (opts) => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: api.kind === 'v2' ? {
          location: { directory: resolveDirectory() },
          // Released V2 accepts the session ruleset at creation under `permissions`.
          ...(Array.isArray(opts?.permission) ? { permissions: toOpenCodeV2PermissionRuleset(opts.permission) } : {}),
        } : {
          ...(Array.isArray(opts?.permission) ? { permission: opts?.permission } : {}),
        },
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw)) : raw as OpenCodeSession;
    },
    sessionGet: async ({ sessionId }) => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw)) : raw as OpenCodeSession;
    },
    sessionUpdate: async ({ sessionId, permission, title, time }) => {
      const initialApi = await ensureApiGeneration();
      if (initialApi.kind === 'v2') {
        if (time) {
          // `Session.Info.time.archived` is server-owned in V2; PATCH accepts title/metadata/permissions only.
          throw new Error('OpenCode V2 session update does not support legacy archive-time fields');
        }
        const patch: Record<string, unknown> = {
          ...(typeof title === 'string' ? { title } : {}),
          ...(Array.isArray(permission) ? { permissions: toOpenCodeV2PermissionRuleset(permission) } : {}),
        };
        if (Object.keys(patch).length > 0) {
          await fetchJsonWithManagedServerRetry({ operation: 'session_update', method: 'PATCH' }, async (currentBaseUrl) => (
            // PATCH returns 204; read the session back so callers keep their existing contract.
            await fetchJson<void>({
              url: buildUrl(currentBaseUrl, `/api/session/${encodeURIComponent(sessionId)}`),
              method: 'PATCH', headers, body: patch, timeoutMs: httpTimeoutMs,
            })
          ));
        }
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}`),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw));
      }
      const body: Record<string, unknown> = {};
      if (Array.isArray(permission)) {
        body.permission = permission;
      }
      if (typeof title === 'string') {
        body.title = title;
      }
      if (time && typeof time === 'object') {
        body.time = time;
      }

      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_update', method: 'PATCH' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory: resolveDirectory() }),
          method: 'PATCH', headers, body, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      return api.kind === 'v2' ? normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw)) : raw as OpenCodeSession;
    },
    sessionMessagesList: async ({ sessionId }) => {
      const raw = await fetchSessionMessagesListRaw(sessionId);
      return Array.isArray(raw) ? raw : [];
    },
    sessionMessagesListRaw: async ({ sessionId }) => await fetchSessionMessagesListRaw(sessionId),
    sessionTodo: async ({ sessionId }) => {
      const initialApi = await ensureApiGeneration();
      if (initialApi.kind === 'v2') return todosBySessionId.get(sessionId) ?? [];
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_todo', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/todo`, { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(data) ? data : [];
    },
    sessionDiff: async ({ sessionId, messageId }) => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_diff', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: api.kind === 'v2'
            // Released V2 scopes the diff by the user message whose turn to diff (`from`).
            ? buildUrl(currentBaseUrl, `/api/session/${encodeURIComponent(sessionId)}/diff`, messageId ? { from: messageId } : undefined)
            : buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/diff`, {
              directory: resolveDirectory(),
              ...(messageId ? { messageID: messageId } : {}),
            }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(data) ? data : [];
    },
    sessionStatusList: async () => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_status_list', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, api.kind === 'v2' ? '/api/session/active' : '/session/status', api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      return data as Record<string, { type?: string }>;
    },
    globalConfigGet: async () => {
      const api = await ensureApiGeneration();
      if (api.kind === 'v2') {
        // V2 has no `/global/config`; the default model is its own directory-scoped route.
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, '/api/model/default', { 'location[directory]': resolveDirectory() }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        const model = readWrappedOpenCodeV2Data(raw);
        const record = model && typeof model === 'object' && !Array.isArray(model) ? model as Record<string, unknown> : null;
        const providerID = typeof record?.providerID === 'string' ? record.providerID.trim() : '';
        const modelID = typeof record?.modelID === 'string' ? record.modelID.trim() : '';
        return providerID && modelID ? { model: `${providerID}/${modelID}` } : {};
      }
      return await fetchJson<{ model?: string }>({
        url: buildUrl(baseUrl, '/global/config'),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
    },
    agentsList: async () => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2' ? '/api/agent' : '/agent', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : undefined),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      const agents = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(agents) ? agents as Array<{ id?: string; name: string; description?: string }> : [];
    },
    appCommands: () => readAppCatalog('/command'),
    appSkills: () => readAppCatalog('/skill'),
    providersList: async () => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') {
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, '/provider'), method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return readOpenCodeProviderList(raw);
      }

      const locationQuery = { 'location[directory]': resolveDirectory() };
      const [providersRaw, modelsRaw] = await Promise.all([
        fetchJson<unknown>({
          url: buildUrl(baseUrl, '/api/provider', locationQuery), method: 'GET', headers, timeoutMs: httpTimeoutMs,
        }),
        fetchJson<unknown>({
          url: buildUrl(baseUrl, '/api/model', locationQuery), method: 'GET', headers, timeoutMs: httpTimeoutMs,
        }),
      ]);
      const providers = readWrappedOpenCodeV2Data(providersRaw);
      const models = readWrappedOpenCodeV2Data(modelsRaw);
      if (!Array.isArray(providers) || !Array.isArray(models)) throw new Error('Invalid OpenCode provider inventory');

      const modelsByProvider = new Map<string, Record<string, unknown>>();
      for (const model of models) {
        if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
        const record = model as Record<string, unknown>;
        const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!providerID || !id) continue;
        const providerModels = modelsByProvider.get(providerID) ?? {};
        providerModels[id] = record;
        modelsByProvider.set(providerID, providerModels);
      }

      if (models.length > 0 && modelsByProvider.size === 0) throw new Error('Invalid OpenCode provider inventory');
      const parsedProviders = providers.flatMap((provider) => {
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return [];
        const record = provider as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id) return [];
        return [{ ...record, id, models: modelsByProvider.get(id) ?? {} }];
      }) as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;
      if (providers.length > 0 && parsedProviders.length === 0) throw new Error('Invalid OpenCode provider inventory');
      return parsedProviders;
    },
    mcpAdd: async ({ directory, name, config }) => {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) {
        throw new Error('OpenCode MCP registration requires a server name');
      }
      const api = await ensureApiGeneration();
      if (api.kind === 'v2') {
        const locationQuery = { 'location[directory]': directory ?? resolveDirectory() };
        // `PUT /api/experimental/mcp/:server` returns 204; status lives on `GET /api/mcp`.
        await fetchJson<void>({
          url: buildUrl(baseUrl, `/api/experimental/mcp/${encodeURIComponent(serverName)}`, locationQuery),
          method: 'PUT',
          headers,
          body: { config: toOpenCodeV2McpConfig(config) },
          timeoutMs: httpTimeoutMs,
        });

        const readStatus = async (): Promise<OpenCodeMcpStatus> => {
          const raw = await fetchJson<unknown>({
            url: buildUrl(baseUrl, '/api/mcp', locationQuery),
            method: 'GET', headers, timeoutMs: httpTimeoutMs,
          });
          const data = readWrappedOpenCodeV2Data(raw);
          if (!Array.isArray(data)) {
            throw new Error(`OpenCode MCP registration returned an invalid status map for "${serverName}"`);
          }
          const entry = data.find((server) => {
            const record = server && typeof server === 'object' && !Array.isArray(server) ? server as Record<string, unknown> : null;
            return typeof record?.name === 'string' && record.name === serverName;
          });
          return readOpenCodeMcpStatusRecord(
            entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).status : undefined,
            serverName,
          );
        };

        // The server connects asynchronously, so the first read can still be `pending`. Callers
        // gate prompt admission on this result, so settle it inside the client's own request
        // budget rather than reporting an unresolved status as a failure.
        const deadline = Date.now() + (httpTimeoutMs ?? 0);
        let status = await readStatus();
        while (status.status === 'pending' && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 100);
            timer.unref?.();
          });
          status = await readStatus();
        }
        return status;
      }
      const response = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/mcp', { directory: directory ?? resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          name: serverName,
          config,
        },
        timeoutMs: httpTimeoutMs,
      });
      return readOpenCodeMcpStatus(response, serverName);
    },
    mcpDisconnect: async ({ directory, name }) => {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) throw new Error('OpenCode MCP disconnect requires a server name');
      const api = await ensureApiGeneration();
      if (api.kind === 'v2') {
        await fetchJson<void>({
          url: buildUrl(
            baseUrl,
            `/api/experimental/mcp/${encodeURIComponent(serverName)}`,
            { 'location[directory]': directory },
          ),
          method: 'DELETE',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        return;
      }
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/mcp/${encodeURIComponent(serverName)}/disconnect`, { directory }),
        method: 'POST',
        headers,
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionSetAgent: async ({ sessionId, agent }) => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') return;
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/agent`),
        method: 'POST', headers, body: { agent }, timeoutMs: httpTimeoutMs,
      });
    },
    sessionSetModel: async ({ sessionId, model, variant }) => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') return;
      let selectedModel = model;
      if (!selectedModel) {
        // An effort-only control refines the native session's own current model, not a global
        // default that could replace a user's resumed selection.
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}`),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        const session = readWrappedOpenCodeV2Data(raw);
        const record = session && typeof session === 'object' && !Array.isArray(session)
          ? session as Record<string, unknown> : null;
        const nativeModel = record?.model && typeof record.model === 'object' && !Array.isArray(record.model)
          ? record.model as Record<string, unknown> : null;
        if (typeof nativeModel?.id === 'string' && typeof nativeModel.providerID === 'string') {
          selectedModel = { modelID: nativeModel.id, providerID: nativeModel.providerID };
        }
        if (!selectedModel) {
          throw new Error('OpenCode session model is unavailable for reasoning selection');
        }
      }
      const normalizedVariant = typeof variant === 'string' ? variant.trim() : '';
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/model`),
        method: 'POST', headers, body: {
          model: {
            id: selectedModel.modelID,
            providerID: selectedModel.providerID,
            ...(normalizedVariant ? { variant: normalizedVariant } : {}),
          },
        }, timeoutMs: httpTimeoutMs,
      });
    },
    sessionPromptAsync: async ({ sessionId, messageId, parts, agent, model, variant, config, delivery }) => {
      const api = await ensureApiGeneration();
      const normalizedVariant = typeof variant === 'string' ? variant.trim() : '';
      const prompt = api.kind === 'v2' ? buildOpenCodeV2Prompt(await resolveOpenCodeV2SkillParts(parts)) : null;
      if (api.kind === 'v2') {
        if (config) {
          throw new Error('OpenCode V2 prompt does not support legacy config fields');
        }
        if (normalizedVariant && !model) {
          throw new Error('OpenCode V2 prompt variant requires an explicit model');
        }
        if (agent) {
          await client.sessionSetAgent({ sessionId, agent });
        }
        if (model) {
          await client.sessionSetModel({ sessionId, model, variant: normalizedVariant });
        }
      } else if (delivery) {
        throw new Error('OpenCode V1 prompt delivery does not support steer or queue modes');
      }
      // prompt_async is effectful. Once its POST is attempted, transport loss is ambiguous and
      // must surface to the canonical Pending owner; replaying it can duplicate provider work.
      await fetchJson<void>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/${api.kind === 'v2' ? 'prompt' : 'prompt_async'}`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: api.kind === 'v2' ? {
          ...(messageId ? { id: messageId } : {}),
          ...prompt,
          ...(delivery ? { delivery } : {}),
        } : {
          ...(messageId ? { messageID: messageId } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(normalizedVariant ? { variant: normalizedVariant } : {}),
          ...(config ? { config } : {}),
          parts: projectOpenCodeV1PromptParts(parts),
        },
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionCommand: async ({ sessionId, command, arguments: commandArguments, messageId, parts, agent, model, variant, delivery }) => {
      const api = await ensureApiGeneration();
      const normalizedVariant = typeof variant === 'string' ? variant.trim() : '';
      let body: Record<string, unknown>;
      if (api.kind === 'v2') {
        // Validate the attachments before changing native selections. Unlike session.prompt,
        // session.command has no caller-minted message id or resume field.
        body = {
          name: command,
          ...buildOpenCodeV2Prompt(await resolveOpenCodeV2SkillParts([{ type: 'text', text: commandArguments }, ...(parts ?? [])])),
          ...(delivery ? { delivery } : {}),
        };
        if (normalizedVariant && !model) {
          throw new Error('OpenCode V2 command variant requires an explicit model');
        }
        if (agent) await client.sessionSetAgent({ sessionId, agent });
        if (model) await client.sessionSetModel({ sessionId, model, variant: normalizedVariant });
      } else {
        if (delivery) throw new OpenCodeServerCommandUnsupportedError('delivery');
        if (parts?.some((part) => !part || typeof part !== 'object' || Array.isArray(part)
          || (part as Record<string, unknown>).type !== 'file')) {
          throw new OpenCodeServerCommandUnsupportedError('attachments');
        }
        body = {
          command,
          arguments: commandArguments,
          ...(messageId ? { messageID: messageId } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model: `${model.providerID}/${model.modelID}` } : {}),
          ...(normalizedVariant ? { variant: normalizedVariant } : {}),
          ...(parts && parts.length > 0 ? { parts } : {}),
        };
      }
      // A callback can already have run when transport fails. Surface that ambiguity without
      // replaying the command; the runtime owns completion and native message correlation.
      await fetchJson<void>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/command`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        // V1 waits for inference and V2 waits for its callback; neither is a control read.
        method: 'POST', headers, body, signal: commandAbort.signal,
      });
    },
    sessionSummarize: async ({ sessionId, model, auto }) => {
      const api = await ensureApiGeneration();
      if (api.kind === 'v2') {
        // V2 owns the compaction model itself; the request only chooses inbox delivery. `auto`
        // has no wire field — automatic compaction is server-scheduled, so an explicit call here
        // is always the manual path and is steered ahead of queued prompts.
        await fetchJson<unknown>({
          url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/compact`),
          method: 'POST',
          headers,
          body: { delivery: auto === true ? 'queue' : 'steer' },
          timeoutMs: httpTimeoutMs,
        });
        return;
      }
      // Summarization is effectful. A transport failure after the POST is ambiguous, so replaying
      // it could duplicate provider work just like replaying prompt_async.
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/summarize`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(typeof auto === 'boolean' ? { auto } : {}),
        },
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionAbort: async ({ sessionId }) => {
      const api = await ensureApiGeneration();
      await fetchJson<void>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/${api.kind === 'v2' ? 'interrupt' : 'abort'}`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        // V2 `session.interrupt` declares no payload and parses strictly; V1 `abort` expects one.
        ...(api.kind === 'v2' ? {} : { body: {} }),
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionFork: async ({ sessionId, messageId }) => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') {
        return await fetchJson<OpenCodeSession>({
          url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/fork`, { directory: resolveDirectory() }),
          method: 'POST',
          headers,
          body: messageId ? { messageID: messageId } : {},
          timeoutMs: httpTimeoutMs,
        });
      }
      // `before` is the exclusive message boundary; omitting it copies the full history.
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/fork`),
        method: 'POST',
        headers,
        body: messageId ? { before: messageId } : {},
        timeoutMs: httpTimeoutMs,
      });
      return normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw));
    },
    questionReply: async ({ requestId, answers }) => {
      const api = await ensureApiGeneration();
      const sessionId = questionSessionByRequestId.get(requestId);
      if (api.kind === 'v2') {
        if (!sessionId) throw new Error(`OpenCode V2 question ${requestId} has no known session`);
        const projection = questionFormProjectionByRequestId.get(requestId);
        if (!projection) throw new Error(`OpenCode V2 form ${requestId} has no known fields`);
        await fetchJson<void>({
          url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}/reply`),
          method: 'POST',
          headers,
          body: { answer: buildOpenCodeV2FormAnswer(projection.bindings, answers, projection.hiddenBindings) },
          timeoutMs: httpTimeoutMs,
        });
        return true;
      }
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `/question/${encodeURIComponent(requestId)}/reply`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { answers },
        timeoutMs: httpTimeoutMs,
      });
      return raw === true;
    },
    questionReject: async ({ requestId }) => {
      const api = await ensureApiGeneration();
      const sessionId = questionSessionByRequestId.get(requestId);
      if (api.kind === 'v2') {
        if (!sessionId) throw new Error(`OpenCode V2 question ${requestId} has no known session`);
        // Cancelling the form is the released rejection: there is no separate reject route.
        await fetchJson<void>({
          url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}`),
          method: 'DELETE',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        return true;
      }
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `/question/${encodeURIComponent(requestId)}/reject`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
        timeoutMs: httpTimeoutMs,
      });
      return raw === true;
    },
    permissionReply: async ({ requestId, reply }) => {
      const api = await ensureApiGeneration();
      const sessionId = permissionSessionByRequestId.get(requestId);
      if (api.kind === 'v2' && !sessionId) throw new Error(`OpenCode V2 permission ${requestId} has no known session`);
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2'
          ? `/api/session/${encodeURIComponent(sessionId!)}/permission/${encodeURIComponent(requestId)}/reply`
          : `/permission/${encodeURIComponent(requestId)}/reply`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        // Released V2 names the verdict `decision`; V1 names it `reply`.
        body: api.kind === 'v2' ? { decision: reply } : { reply },
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? true : raw === true;
    },
    permissionList: async () => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'permission_list', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, api.kind === 'v2' ? '/api/permission/request' : '/permission', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      if (!Array.isArray(data)) {
        throw new Error('OpenCode permission list returned invalid data');
      }
      const permissions = api.kind === 'v2' ? data.map(normalizeOpenCodeV2PermissionRequest) : data;
      rememberRequestSessions(permissions, permissionSessionByRequestId);
      return permissions;
    },
    questionList: async () => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'question_list', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          // Released V2 replaced the question inventory with the directory-scoped form inventory.
          url: buildUrl(currentBaseUrl, api.kind === 'v2' ? '/api/form' : '/question', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      if (!Array.isArray(data)) {
        throw new Error('OpenCode question list returned invalid data');
      }
      if (api.kind !== 'v2') {
        rememberRequestSessions(data, questionSessionByRequestId);
        return data;
      }
      const questions = data.flatMap((form) => {
        const projection = projectOpenCodeV2Form(form);
        if (!projection) return [];
        rememberOpenCodeV2FormProjection(projection);
        return [projection.request];
      });
      rememberRequestSessions(questions, questionSessionByRequestId);
      return questions;
    },
    subscribeGlobalEvents: async ({ sessionId: rawSessionId, signal, onEvent }) => {
      if (disposed) return;
      if (subscriptionLoop) return;

      subscriptionLoop = (async () => {
        const localAbort = new AbortController();
        subscriptionLoopAbort = localAbort;

        let attempt = 0;
        // Released V2 serves every session event on the global stream; `sessionId` no longer
        // selects a per-session transport (see the stream comment below).
        void rawSessionId;
        while (!disposed && !signal.aborted && !localAbort.signal.aborted) {
          const currentConnectionGeneration = connectionGeneration + 1;
          connectionGeneration = currentConnectionGeneration;
          let providerConnectionBoundarySeen = false;
          const combinedAbort = new AbortController();
          const onAbort = () => {
            try {
              combinedAbort.abort();
            } catch {
              // ignore
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          localAbort.signal.addEventListener('abort', onAbort, { once: true });

          try {
            const api = await ensureApiGeneration();
            const streamDirectory = resolveDirectory();
            // Released V2 keeps `GET /api/event` as the only stream that actually carries session
            // events. Its durable *definition* metadata does not mean the event was persisted:
            // `Bus` takes `persist = options?.persist ?? false` (packages/core/src/bus.ts) and
            // `opencode serve` never sets `events.persist`, so the durable log
            // (`/api/experimental/session/:id/log`) replays nothing and answers with the bare
            // `log.synced` watermark. Reading it would therefore drop every terminal, text and
            // tool frame. Reconnect catch-up stays with the transcript projection the runtime
            // already runs on `server.connected`.
            const url = buildUrl(
              baseUrl,
              api.kind === 'v2' ? '/api/event' : '/event',
              api.kind === 'v2' ? undefined : { directory: streamDirectory },
            );
            const nextHeaders: Record<string, string> = { ...headers };
            subscription = await subscribeSseJson<unknown>({
              url,
              headers: nextHeaders,
              signal: combinedAbort.signal,
              readIdleTimeoutMs,
              onMessage: (msg) => {
                if (currentConnectionGeneration !== connectionGeneration) return;
                if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
                const rawEvent = msg as Record<string, unknown>;
                const wireEventType = typeof rawEvent.type === 'string' ? rawEvent.type : '';
                if (!wireEventType) return;
                const normalizedEvent = api.kind === 'v2'
                  ? normalizeOpenCodeV2Event(wireEventType, rawEvent.data)
                  : { type: wireEventType, properties: rawEvent.properties };
                const eventType = normalizedEvent.type;
                const eventLocation = rawEvent.location && typeof rawEvent.location === 'object' && !Array.isArray(rawEvent.location)
                  ? rawEvent.location as Record<string, unknown>
                  : null;
                const properties = normalizedEvent.properties;
                if (api.kind === 'v2' && eventType === 'permission.asked') {
                  rememberRequestSessions([properties], permissionSessionByRequestId);
                }
                if (api.kind === 'v2' && 'formProjection' in normalizedEvent && normalizedEvent.formProjection) {
                  rememberOpenCodeV2FormProjection(normalizedEvent.formProjection);
                }
                if (api.kind === 'v2' && eventType === 'todo.updated' && properties && typeof properties === 'object' && !Array.isArray(properties)) {
                  const todoEvent = properties as Record<string, unknown>;
                  if (typeof todoEvent.sessionID === 'string' && Array.isArray(todoEvent.todos)) {
                    todosBySessionId.set(todoEvent.sessionID, todoEvent.todos);
                  }
                }
                const event: OpenCodeGlobalEvent = {
                  directory: api.kind === 'v2' && typeof eventLocation?.directory === 'string'
                    ? eventLocation.directory
                    : streamDirectory,
                  payload: {
                    type: eventType,
                    properties,
                  },
                };
                if (eventType === 'server.connected') {
                  providerConnectionBoundarySeen = true;
                  onEvent(event, {
                    provenance: 'connection-boundary',
                    connectionGeneration: currentConnectionGeneration,
                  });
                  return;
                }
                if (!providerConnectionBoundarySeen) return;
                onEvent(event, {
                  provenance: 'accepted-live',
                  connectionGeneration: currentConnectionGeneration,
                });
              },
            });
            await subscription.done;
            if (!disposed && !signal.aborted && !localAbort.signal.aborted) {
              await refreshTransportForSseReconnect();
            }
            attempt = 0;
          } catch (error) {
            if (disposed || signal.aborted || localAbort.signal.aborted) break;
            logger.debug(
              isOpenCodeSseReadIdleTimeoutError(error)
                ? '[OpenCodeServer] SSE read idle timeout; reconnecting stream (best-effort)'
                : '[OpenCodeServer] SSE stream ended; reconnecting (best-effort)',
              error,
            );
            await refreshTransportForSseReconnect();
            const delayMs = resolveSseReconnectDelayMs(attempt, env);
            attempt += 1;
            await sleepUntilOrAbort(delayMs, combinedAbort.signal);
          } finally {
            if (subscription) {
              try {
                subscription.close();
              } catch {
                // ignore
              }
            }
            subscription = null;
            signal.removeEventListener('abort', onAbort);
            localAbort.signal.removeEventListener('abort', onAbort);
          }
        }
      })();
    },
    getManagedServerIdentity: () => managedServerIdentity,
    dispose: async () => {
      disposed = true;
      commandAbort.abort();
      if (subscriptionLoopAbort) {
        try {
          subscriptionLoopAbort.abort();
        } catch {
          // ignore
        }
      }
      if (subscription) {
        try {
          subscription.close();
          await subscription.done.catch(() => {});
        } catch {
          // ignore
        }
        subscription = null;
      }
      if (subscriptionLoop) {
        try {
          await subscriptionLoop.catch(() => {});
        } catch {
          // ignore
        }
        subscriptionLoop = null;
      }
      subscriptionLoopAbort = null;
      await Promise.allSettled([...pendingRequests]);
    },
  };

  return { client, baseUrl };
}
