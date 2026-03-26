/**
 * Provider-agnostic channel bridge worker.
 *
 * Responsibilities:
 * - Pull inbound channel messages from adapters
 * - Handle slash commands (`/sessions`, `/attach`, `/detach`, `/session`, `/help`, `/start`)
 * - Forward non-command inbound messages into attached Happier sessions
 * - Forward agent output back into the mapped channel conversation
 *
 * Cursor semantics:
 * - `lastForwardedSeq` tracks the highest transcript sequence that has been delivered
 *   to the channel for a given binding.
 * - `fetchAgentMessagesAfterSeq` is treated as an exclusive cursor (`seq > afterSeq`).
 * - `updateLastForwardedSeq` must persist the maximum forwarded sequence.
 */
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';

/**
 * Logical channel conversation reference.
 *
 * For thread-capable providers, `threadId` identifies the topic/thread; for non-threaded
 * conversations it is `null`.
 */
export type ChannelBridgeConversationRef = Readonly<{
  providerId: string;
  conversationId: string;
  threadId: string | null;
}>;

/**
 * Inbound message event produced by an adapter.
 *
 * `messageId` is used for best-effort duplicate suppression in the worker runtime.
 */
export type ChannelBridgeInboundMessage = ChannelBridgeConversationRef & Readonly<{
  senderId?: string | null;
  text: string;
  messageId: string;
}>;

export type ChannelBridgeActorContext = Readonly<{
  providerId: string;
  conversationId: string;
  threadId: string | null;
  senderId: string | null;
}>;

/**
 * Adapter contract for a specific provider (Telegram, Discord, etc.).
 *
 * Expectations:
 * - `pullInboundMessages` should return available inbound items without throwing for
 *   normal empty states (return `[]` instead).
 * - `ackInboundMessages` is optional and, when implemented, will be called after
 *   the worker has fully handled a batch item (including command replies / forward attempts).
 *   Adapters can use this to implement deferred acknowledgment semantics.
 * - `sendMessage` should deliver text into a target conversation/thread.
 * - `sendMessage` should tolerate at-least-once delivery attempts. Timeout races may
 *   trigger retries, so provider adapters should be idempotent when possible.
 * - `stop` is optional and should tear down adapter resources.
 */
export type ChannelBridgeAdapter = Readonly<{
  providerId: string;
  pullInboundMessages: () => Promise<ChannelBridgeInboundMessage[]>;
  ackInboundMessages?: (messages: readonly ChannelBridgeInboundMessage[]) => void | Promise<void>;
  sendMessage: (params: Readonly<{ conversationId: string; threadId: string | null; text: string }>) => Promise<void>;
  stop?: () => void | Promise<void>;
}>;

/**
 * Persisted conversation -> session mapping and agent cursor state.
 */
export type ChannelBridgeInboundMode = 'ownerOnly' | 'anyone';

export type ChannelSessionBinding = ChannelBridgeConversationRef & Readonly<{
  sessionId: string;
  lastForwardedSeq: number;
  ownerSenderId: string | null;
  inboundMode: ChannelBridgeInboundMode;
  allowMissingSenderId: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}>;

/**
 * Resolution result for `/attach <session-id-or-prefix>`.
 */
export type ResolveSessionIdResult =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>;

export type ChannelBridgeAgentMessageRow = Readonly<{
  seq: number;
  text: string;
}>;

export type ChannelBridgeAgentFetchResult = Readonly<{
  messages: readonly ChannelBridgeAgentMessageRow[];
  highestSeenSeq?: number | null;
}>;

/**
 * Bridge dependencies supplied by runtime integration.
 *
 * - `resolveLatestSessionSeq` should return the latest valid non-negative transcript cursor.
 * - `fetchAgentMessagesAfterSeq` should return rows with `seq > afterSeq`.
 *   Results may be unsorted; the worker enforces ascending `seq` delivery before forwarding.
 * - `fetchAgentMessagesAfterSeq` may optionally return `highestSeenSeq` when no agent rows are
 *   present so the worker can advance cursor windows across non-agent transcript pages.
 * - `onWarning` receives non-fatal operational issues; worker continues best-effort.
 */
export type ChannelBridgeDeps = Readonly<{
  listSessions: () => Promise<Array<Readonly<{ sessionId: string; label: string | null }>>>;
  resolveSessionIdOrPrefix: (idOrPrefix: string) => Promise<ResolveSessionIdResult>;
  sendUserMessageToSession: (params: Readonly<{
    sessionId: string;
    text: string;
    sentFrom: string;
    providerId: string;
    conversationId: string;
    threadId: string | null;
    messageId?: string;
  }>) => Promise<void>;
  resolveLatestSessionSeq: (sessionId: string) => Promise<number>;
  fetchAgentMessagesAfterSeq: (params: Readonly<{ sessionId: string; afterSeq: number }>) => Promise<
    readonly ChannelBridgeAgentMessageRow[] | ChannelBridgeAgentFetchResult
  >;
  authorizeCommand?: (params: Readonly<{ commandName: string; actor: ChannelBridgeActorContext }>) => Promise<boolean | Readonly<{ allowed: boolean; message?: string }>>;
  onWarning?: (message: string, error?: unknown) => void;
}>;

/**
 * Binding persistence contract used by the bridge worker.
 *
 * `updateLastForwardedSeq` is monotonic: implementations should keep the highest cursor.
 */
export type ChannelBindingStore = Readonly<{
  listBindings: () => Promise<ChannelSessionBinding[]>;
  getBinding: (ref: ChannelBridgeConversationRef) => Promise<ChannelSessionBinding | null>;
  upsertBinding: (binding: Readonly<{
    providerId: string;
    conversationId: string;
    threadId: string | null;
    sessionId: string;
    lastForwardedSeq: number;
    ownerSenderId: string | null;
    inboundMode: ChannelBridgeInboundMode;
    allowMissingSenderId: boolean;
  }>) => Promise<ChannelSessionBinding>;
  updateLastForwardedSeq: (
    ref: ChannelBridgeConversationRef,
    params: Readonly<{ expectedSessionId: string; seq: number }>,
  ) => Promise<boolean>;
  removeBinding: (ref: ChannelBridgeConversationRef) => Promise<boolean>;
}>;

export type ChannelBridgeWorkerHandle = Readonly<{
  /** Stops the worker. Idempotent; safe to call multiple times. */
  stop: () => Promise<void>;
  /** Requests an immediate tick; no-op once `stop()` has been called. */
  trigger: () => void;
}>;

/**
 * Key encoding for in-memory binding map.
 *
 * Uses JSON array encoding to avoid delimiter collision risks.
 */
function bindingKey(ref: ChannelBridgeConversationRef): string {
  return JSON.stringify([ref.providerId, ref.conversationId, ref.threadId]);
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const parsed = Math.trunc(value);
  if (parsed < 0) return null;
  return parsed;
}

function normalizeSenderId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class ChannelBridgePermanentDeliveryError extends Error {
  readonly code: 'forbidden' | 'conversation_not_found' | 'unknown';

  constructor(params: Readonly<{ code: ChannelBridgePermanentDeliveryError['code']; message: string }>) {
    super(params.message);
    this.name = 'ChannelBridgePermanentDeliveryError';
    this.code = params.code;
  }
}

function isChannelBridgePermanentDeliveryFailure(error: unknown): error is ChannelBridgePermanentDeliveryError {
  return error instanceof ChannelBridgePermanentDeliveryError;
}

const DEFAULT_EXTERNAL_IO_TIMEOUT_MS = 30_000;

function resolveExternalIoTimeoutMs(): number {
  const raw = (process.env.HAPPIER_CHANNEL_BRIDGE_IO_TIMEOUT_MS ?? '').trim();
  if (!raw) {
    return DEFAULT_EXTERNAL_IO_TIMEOUT_MS;
  }

  if (!/^\d+$/.test(raw)) {
    return DEFAULT_EXTERNAL_IO_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_EXTERNAL_IO_TIMEOUT_MS;
  }

  return parsed;
}

const EXTERNAL_IO_TIMEOUT_MS = resolveExternalIoTimeoutMs();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  // Promise.race does not cancel the underlying operation. Attach a no-op rejection
  // handler so late failures do not surface as unhandled rejections after timeout.
  void promise.catch(() => undefined);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

type ChannelBridgeInboundDeduper = Readonly<{
  hasSeen: (message: ChannelBridgeInboundMessage) => boolean;
  markSeen: (message: ChannelBridgeInboundMessage) => void;
}>;

/**
 * Create an inbound deduper for channel messages.
 *
 * Use this to isolate dedupe state across independent bridge instances sharing the same process.
 */
export function createChannelBridgeInboundDeduper(now: () => number = () => Date.now()): ChannelBridgeInboundDeduper {
  const recent = new Map<string, number>();
  const ttlMs = 24 * 60 * 60 * 1000;
  const maxEntries = 100_000;
  // Avoid full TTL scans on every message. If the map exceeds maxEntries,
  // prune still runs immediately even within the minimum interval.
  const minPruneIntervalMs = 1_000;
  let lastPrunedAtMs = 0;

  const prune = (currentNow: number) => {
    if (recent.size <= maxEntries && currentNow - lastPrunedAtMs < minPruneIntervalMs) {
      return;
    }
    lastPrunedAtMs = currentNow;

    for (const [key, seenAtMs] of recent) {
      if (currentNow - seenAtMs > ttlMs) {
        recent.delete(key);
      }
    }
    while (recent.size > maxEntries) {
      const [oldest] = recent.keys();
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
  };

  const dedupeKey = (message: ChannelBridgeInboundMessage): string | null => {
    const normalizedMessageId = String(message.messageId).trim();
    if (normalizedMessageId.length === 0) {
      return null;
    }
    return JSON.stringify([message.providerId, message.conversationId, message.threadId, normalizedMessageId]);
  };

  return {
    hasSeen: (message) => {
      const key = dedupeKey(message);
      if (!key) {
        return false;
      }
      const currentNow = now();
      prune(currentNow);
      return recent.has(key);
    },
    markSeen: (message) => {
      const key = dedupeKey(message);
      if (!key) {
        return;
      }
      const currentNow = now();
      prune(currentNow);
      recent.set(key, currentNow);
    },
  };
}

function normalizeAgentFetchResult(
  fetched: readonly ChannelBridgeAgentMessageRow[] | ChannelBridgeAgentFetchResult,
): Readonly<{ messages: readonly ChannelBridgeAgentMessageRow[]; highestSeenSeq: number | null }> {
  const isMessageRowArray = (
    value: readonly ChannelBridgeAgentMessageRow[] | ChannelBridgeAgentFetchResult,
  ): value is readonly ChannelBridgeAgentMessageRow[] => Array.isArray(value);

  if (isMessageRowArray(fetched)) {
    return {
      messages: fetched,
      highestSeenSeq: null,
    };
  }

  return {
    messages: fetched.messages,
    highestSeenSeq: toNonNegativeInt(fetched.highestSeenSeq ?? null),
  };
}

/**
 * Create an in-memory binding store.
 *
 * `now` is injectable for deterministic tests.
 */
export function createInMemoryChannelBindingStore(now: () => number = () => Date.now()): ChannelBindingStore {
  const byKey = new Map<string, ChannelSessionBinding>();
  const normalizeRef = (ref: Readonly<{
    providerId: string;
    conversationId: string;
    threadId: string | null;
  }>): ChannelBridgeConversationRef => {
    const providerId = ref.providerId.trim();
    const conversationId = ref.conversationId.trim();
    const threadIdRaw = typeof ref.threadId === 'string' ? ref.threadId.trim() : '';
    return {
      providerId,
      conversationId,
      threadId: threadIdRaw.length > 0 ? threadIdRaw : null,
    };
  };

  return {
    listBindings: async () => Array.from(byKey.values()).map((binding) => ({ ...binding })),
    getBinding: async (ref) => {
      const found = byKey.get(bindingKey(normalizeRef(ref)));
      return found ? { ...found } : null;
    },
    upsertBinding: async (binding) => {
      const normalizedRef = normalizeRef(binding);
      const key = bindingKey(normalizedRef);
      const existing = byKey.get(key);
      const normalizedLastForwardedSeq = toNonNegativeInt(binding.lastForwardedSeq) ?? 0;
      const ownerSenderId = normalizeSenderId(binding.ownerSenderId);
      const inboundMode: ChannelBridgeInboundMode = binding.inboundMode === 'anyone' ? 'anyone' : 'ownerOnly';
      const allowMissingSenderId = binding.allowMissingSenderId === true;
      const next: ChannelSessionBinding = {
        ...normalizedRef,
        sessionId: binding.sessionId.trim(),
        lastForwardedSeq: normalizedLastForwardedSeq,
        ownerSenderId,
        inboundMode,
        allowMissingSenderId,
        createdAtMs: existing?.createdAtMs ?? now(),
        updatedAtMs: now(),
      };
      byKey.set(key, { ...next });
      return { ...next };
    },
    updateLastForwardedSeq: async (ref, params) => {
      const key = bindingKey(normalizeRef(ref));
      const existing = byKey.get(key);
      if (!existing) return false;
      if (existing.sessionId !== params.expectedSessionId.trim()) return false;
      const parsedSeq = toNonNegativeInt(params.seq);
      if (parsedSeq === null) return false;
      const nextSeq = Math.max(existing.lastForwardedSeq, parsedSeq);
      if (nextSeq === existing.lastForwardedSeq) {
        return false;
      }
      byKey.set(key, {
        ...existing,
        lastForwardedSeq: nextSeq,
        updatedAtMs: now(),
      });
      return true;
    },
    removeBinding: async (ref) => byKey.delete(bindingKey(normalizeRef(ref))),
  };
}

function parseSlashCommand(text: string): Readonly<{ name: string; args: string[] }> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/g);
  const normalized = String(rawName).trim().toLowerCase();
  if (!normalized) return null;
  const name = normalized.split('@')[0]!.trim();
  if (!name) return null;
  return { name, args };
}

function parseAttachFlags(args: readonly string[]): Readonly<{
  allowAnyone: boolean;
  allowMissingSenderId: boolean;
  unknownFlags: string[];
}> {
  const allowAnyone = args.some((arg) => arg.trim().toLowerCase() === '--anyone');
  const allowMissingSenderId = args.some((arg) => arg.trim().toLowerCase() === '--allow-missing-sender-id');
  const unknownFlags = args
    .map((arg) => arg.trim())
    .filter((arg) => arg.startsWith('--'))
    .filter((arg) => arg.toLowerCase() !== '--anyone' && arg.toLowerCase() !== '--allow-missing-sender-id');
  return {
    allowAnyone,
    allowMissingSenderId,
    unknownFlags,
  };
}

function authorizeBindingControl(params: Readonly<{
  binding: ChannelSessionBinding | null;
  senderId: string | null;
}>): Readonly<{ allowed: boolean; message: string | null }> {
  const { binding, senderId } = params;

  if (!binding) {
    if (!senderId) {
      return {
        allowed: false,
        message: 'This command requires a stable sender identity. Try using it in a DM.',
      };
    }
    return { allowed: true, message: null };
  }

  if (!senderId) {
    if (binding.allowMissingSenderId) {
      return { allowed: true, message: null };
    }
    return {
      allowed: false,
      message: 'This binding does not allow commands without a sender identity.',
    };
  }

  if (!binding.ownerSenderId) {
    return { allowed: true, message: null };
  }

  if (binding.ownerSenderId !== senderId) {
    return {
      allowed: false,
      message: 'You are not authorized to control this binding.',
    };
  }

  return { allowed: true, message: null };
}

function authorizeInboundForwarding(params: Readonly<{
  binding: ChannelSessionBinding;
  senderId: string | null;
}>): Readonly<{ allowed: boolean; message: string | null }> {
  const { binding, senderId } = params;

  if (!senderId) {
    if (binding.allowMissingSenderId) {
      return { allowed: true, message: null };
    }
    return {
      allowed: false,
      message: 'Sender identity is missing; forwarding is disabled for safety.',
    };
  }

  if (binding.inboundMode === 'anyone') {
    return { allowed: true, message: null };
  }

  if (!binding.ownerSenderId) {
    return {
      allowed: false,
      message: 'This binding has no owner identity; reattach to establish one.',
    };
  }

  if (binding.ownerSenderId !== senderId) {
    return {
      allowed: false,
      message: 'You are not authorized to send messages to this session from here.',
    };
  }

  return { allowed: true, message: null };
}

function formatSessionsMessage(rows: Array<Readonly<{ sessionId: string; label: string | null }>>): string {
  if (rows.length === 0) {
    return 'No sessions found.';
  }
  const limit = 20;
  const truncated = rows.length > limit;
  const body = rows
    .slice(0, limit)
    .map((row) => `• ${row.sessionId}${row.label ? ` (${row.label})` : ''}`)
    .join('\n');
  const suffix = truncated ? `\n…and ${rows.length - limit} more.` : '';
  return `Recent sessions:\n${body}${suffix}`;
}

async function replyToConversation(
  adapter: ChannelBridgeAdapter,
  conversation: Readonly<{ conversationId: string; threadId: string | null }>,
  text: string,
): Promise<void> {
  await withTimeout(
    adapter.sendMessage({
      conversationId: conversation.conversationId,
      threadId: conversation.threadId,
      text,
    }),
    EXTERNAL_IO_TIMEOUT_MS,
    `replyToConversation(${adapter.providerId}:${conversation.conversationId})`,
  );
}

async function authorizeCommand(params: Readonly<{
  commandName: string;
  event: ChannelBridgeInboundMessage;
  deps: ChannelBridgeDeps;
}>): Promise<Readonly<{ allowed: boolean; message: string | null }>> {
  const authorize = params.deps.authorizeCommand;
  if (!authorize) {
    return { allowed: true, message: null };
  }

  const senderId = normalizeSenderId(params.event.senderId);
  const actor: ChannelBridgeActorContext = {
    providerId: params.event.providerId,
    conversationId: params.event.conversationId,
    threadId: params.event.threadId,
    senderId,
  };

  try {
    const result = await withTimeout(
      authorize({
        commandName: params.commandName,
        actor,
      }),
      EXTERNAL_IO_TIMEOUT_MS,
      `authorizeCommand(/${params.commandName})`,
    );
    if (typeof result === 'boolean') {
      return {
        allowed: result,
        message: null,
      };
    }

    const allowed = Boolean(result.allowed);
    const message = typeof result.message === 'string' && result.message.trim().length > 0 ? result.message.trim() : null;
    return { allowed, message };
  } catch (error) {
    params.deps.onWarning?.(`Authorization check failed for command /${params.commandName}`, error);
    return {
      allowed: false,
      message: 'Unable to authorize this command right now.',
    };
  }
}

async function handleCommand(params: Readonly<{
  command: Readonly<{ name: string; args: string[] }>;
  event: ChannelBridgeInboundMessage;
  adapter: ChannelBridgeAdapter;
  store: ChannelBindingStore;
  deps: ChannelBridgeDeps;
}>): Promise<void> {
  const { command, event, adapter, store, deps } = params;
  const ref: ChannelBridgeConversationRef = {
    providerId: event.providerId,
    conversationId: event.conversationId,
    threadId: event.threadId,
  };

  const replyForCommand = async (text: string): Promise<void> => {
    try {
      await replyToConversation(adapter, ref, text);
    } catch (error) {
      deps.onWarning?.(
        `Failed to send command reply for /${command.name} (provider=${ref.providerId} conversation=${ref.conversationId} thread=${ref.threadId ?? 'null'})`,
        error,
      );
    }
  };

  if (command.name !== 'help' && command.name !== 'start') {
    const authz = await authorizeCommand({
      commandName: command.name,
      event,
      deps,
    });
    if (!authz.allowed) {
      await replyForCommand(authz.message ?? 'You are not authorized to run this command here.');
      return;
    }
  }

  if (command.name === 'help' || command.name === 'start') {
    await replyForCommand(
      [
        'Happier bridge commands:',
        '/sessions - list recent sessions',
        '/attach <session-id-or-prefix> [--anyone] [--allow-missing-sender-id] - attach this conversation',
        '/detach - unbind this DM/topic',
        '/session - show current binding',
        '/help - show command help',
        '/start - alias for /help',
      ].join('\n'),
    );
    return;
  }

  if (command.name === 'sessions') {
    let sessions: Array<Readonly<{ sessionId: string; label: string | null }>>;
    try {
      sessions = await withTimeout(
        deps.listSessions(),
        EXTERNAL_IO_TIMEOUT_MS,
        'listSessions()',
      );
    } catch (error) {
      deps.onWarning?.('Failed to list sessions for /sessions command', error);
      await replyForCommand('Failed to retrieve sessions. Please try again later.');
      return;
    }
    await replyForCommand(formatSessionsMessage(sessions));
    return;
  }

  if (command.name === 'session') {
    let existing: ChannelSessionBinding | null;
    try {
      existing = await withTimeout(
        store.getBinding(ref),
        EXTERNAL_IO_TIMEOUT_MS,
        `store.getBinding(${ref.providerId}:${ref.conversationId}:${ref.threadId ?? 'null'})`,
      );
    } catch (error) {
      deps.onWarning?.('Failed to read binding for /session command', error);
      await replyForCommand('Failed to read current session binding. Please try again later.');
      return;
    }

    if (!existing) {
      await replyForCommand('No session is attached here. Use /attach <session-id-or-prefix>.');
      return;
    }
    await replyForCommand(`Attached session: ${existing.sessionId}`);
    return;
  }

  if (command.name === 'attach') {
    const rawArgs = command.args.map((arg) => String(arg));
    const idOrPrefix = String(rawArgs[0] ?? '').trim();
    if (!idOrPrefix) {
      await replyForCommand('Usage: /attach <session-id-or-prefix> [--anyone] [--allow-missing-sender-id]');
      return;
    }

    const flags = parseAttachFlags(rawArgs.slice(1));
    if (flags.unknownFlags.length > 0) {
      await replyForCommand(
        `Unknown flags: ${flags.unknownFlags.join(', ')}\nUsage: /attach <session-id-or-prefix> [--anyone] [--allow-missing-sender-id]`,
      );
      return;
    }

    const senderId = normalizeSenderId(event.senderId);
    if (!senderId && !flags.allowMissingSenderId) {
      await replyForCommand(
        'Cannot attach: sender identity is missing. Try attaching from a DM, or pass --allow-missing-sender-id (unsafe).',
      );
      return;
    }

    let resolved: ResolveSessionIdResult;
    try {
      resolved = await withTimeout(
        deps.resolveSessionIdOrPrefix(idOrPrefix),
        EXTERNAL_IO_TIMEOUT_MS,
        `resolveSessionIdOrPrefix(${idOrPrefix})`,
      );
    } catch (error) {
      deps.onWarning?.('Failed to resolve session by id/prefix for attach', error);
      await replyForCommand(
        `Failed to attach to session ${idOrPrefix}: unable to resolve session identifier.`,
      );
      return;
    }

    if (!resolved.ok) {
      if (resolved.code === 'session_id_ambiguous') {
        if (resolved.candidates && resolved.candidates.length > 0) {
          await replyForCommand(
            `Ambiguous session prefix. Candidates:\n${resolved.candidates.map((id) => `• ${id}`).join('\n')}`,
          );
          return;
        }

        await replyForCommand('Ambiguous session prefix. Use /sessions to list active sessions.');
        return;
      }

      if (resolved.code === 'unsupported') {
        await replyForCommand('Attaching by session ID or prefix is not supported in this environment.');
        return;
      }
      await replyForCommand('Session not found. Use /sessions to list recent sessions.');
      return;
    }

    let latestSeq: number;
    try {
      const resolvedSeq = toNonNegativeInt(await withTimeout(
        deps.resolveLatestSessionSeq(resolved.sessionId),
        EXTERNAL_IO_TIMEOUT_MS,
        `resolveLatestSessionSeq(${resolved.sessionId})`,
      ));
      if (resolvedSeq === null) {
        deps.onWarning?.(
          `resolveLatestSessionSeq returned an invalid value for session ${resolved.sessionId}; expected a non-negative integer`,
        );
        await replyForCommand(
          `Failed to attach to session ${resolved.sessionId}: unable to resolve latest sequence cursor.`,
        );
        return;
      }
      latestSeq = resolvedSeq;
    } catch (error) {
      deps.onWarning?.('Failed to resolve latest session sequence for attach', error);
      await replyForCommand(
        `Failed to attach to session ${resolved.sessionId}: unable to resolve latest sequence cursor.`,
      );
      return;
    }

    let previousBinding: ChannelSessionBinding | null;
    try {
      previousBinding = await withTimeout(
        store.getBinding(ref),
        EXTERNAL_IO_TIMEOUT_MS,
        `store.getBinding(${ref.providerId}:${ref.conversationId}:${ref.threadId ?? 'null'})`,
      );
    } catch (error) {
      deps.onWarning?.('Failed to read existing binding during /attach', error);
      await replyForCommand('Failed to read current binding before attach. Please try again later.');
      return;
    }
    const previousSessionId = previousBinding?.sessionId ?? null;

    if (previousBinding) {
      const controlAuthz = authorizeBindingControl({
        binding: previousBinding,
        senderId,
      });
      if (!controlAuthz.allowed) {
        await replyForCommand(controlAuthz.message ?? 'You are not authorized to attach here.');
        return;
      }
    }

    const ownerSenderId = senderId;
    const allowMissingSenderId = flags.allowMissingSenderId === true;
    const requestedInboundMode: ChannelBridgeInboundMode = flags.allowAnyone ? 'anyone' : 'ownerOnly';
    const inboundMode: ChannelBridgeInboundMode =
      ownerSenderId
        ? requestedInboundMode
        : allowMissingSenderId
          ? 'anyone'
          : 'ownerOnly';

    try {
      await withTimeout(
        store.upsertBinding({
          providerId: ref.providerId,
          conversationId: ref.conversationId,
          threadId: ref.threadId,
          sessionId: resolved.sessionId,
          lastForwardedSeq: latestSeq,
          ownerSenderId,
          inboundMode,
          allowMissingSenderId,
        }),
        EXTERNAL_IO_TIMEOUT_MS,
        `store.upsertBinding(${ref.providerId}:${ref.conversationId}:${ref.threadId ?? 'null'})`,
      );
    } catch (error) {
      deps.onWarning?.('Failed to persist binding during /attach', error);
      await replyForCommand(`Failed to attach to session ${resolved.sessionId}: unable to persist binding.`);
      return;
    }

    const switchedFrom =
      previousSessionId && previousSessionId !== resolved.sessionId
        ? ` (replaced previous session ${previousSessionId})`
        : '';
    await replyForCommand(`Attached this conversation to session ${resolved.sessionId}${switchedFrom}.`);
    return;
  }

  if (command.name === 'detach') {
    let existing: ChannelSessionBinding | null;
    try {
      existing = await withTimeout(
        store.getBinding(ref),
        EXTERNAL_IO_TIMEOUT_MS,
        `store.getBinding(${ref.providerId}:${ref.conversationId}:${ref.threadId ?? 'null'})`,
      );
    } catch (error) {
      deps.onWarning?.('Failed to read binding before /detach command', error);
      await replyForCommand('Failed to read current binding. Please try again later.');
      return;
    }

    const senderId = normalizeSenderId(event.senderId);
    const controlAuthz = authorizeBindingControl({
      binding: existing,
      senderId,
    });
    if (!controlAuthz.allowed) {
      await replyForCommand(controlAuthz.message ?? 'You are not authorized to detach here.');
      return;
    }

    let removed = false;
    try {
      removed = await withTimeout(
        store.removeBinding(ref),
        EXTERNAL_IO_TIMEOUT_MS,
        `store.removeBinding(${ref.providerId}:${ref.conversationId}:${ref.threadId ?? 'null'})`,
      );
    } catch (error) {
      deps.onWarning?.('Failed to remove binding for /detach command', error);
      await replyForCommand('Failed to detach current session binding. Please try again later.');
      return;
    }

    if (removed) {
      await replyForCommand('Detached this conversation from Happier session.');
    } else {
      await replyForCommand('No session was attached here.');
    }
    return;
  }

  await replyForCommand(`Unknown command: /${command.name}. Use /help for supported commands.`);
  return;
}

/**
 * Execute one bridge tick.
 *
 * Flow:
 * 1) Pull inbound messages per adapter
 * 2) Handle commands or forward user text to attached session
 * 3) Fetch agent output after each binding cursor and send to channel
 * 4) Advance cursors monotonically
 *
 * Deduper behavior:
 * - `inboundDeduper` is required to make dedupe-state ownership explicit.
 * - Use `createChannelBridgeInboundDeduper()` to construct per-worker dedupe state.
 *
 * Missing-adapter warning deduplication:
 * - `warnedMissingAdapterBindings` is optional. When omitted, missing-adapter
 *   warnings are emitted per binding on each call.
 * - Pass a stable `Set<string>` across calls to dedupe warning spam in
 *   long-running loops (as `startChannelBridgeWorker` does).
 */
export async function executeChannelBridgeTick(params: Readonly<{
  store: ChannelBindingStore;
  adapters: readonly ChannelBridgeAdapter[];
  deps: ChannelBridgeDeps;
  inboundDeduper: ChannelBridgeInboundDeduper;
  warnedMissingAdapterBindings?: Set<string>;
}>): Promise<void> {
  const activeAdapters: ChannelBridgeAdapter[] = [];
  const adapterByProvider = new Map<string, ChannelBridgeAdapter>();
  for (const adapter of params.adapters) {
    if (adapterByProvider.has(adapter.providerId)) {
      params.deps.onWarning?.(`Duplicate adapter providerId detected: ${adapter.providerId}; ignoring later adapter instance.`);
      continue;
    }
    adapterByProvider.set(adapter.providerId, adapter);
    activeAdapters.push(adapter);
  }

  const deduper = params.inboundDeduper;

  for (const adapter of activeAdapters) {
    let inbound: ChannelBridgeInboundMessage[];
    try {
      inbound = await withTimeout(
        adapter.pullInboundMessages(),
        EXTERNAL_IO_TIMEOUT_MS,
        `pullInboundMessages(${adapter.providerId})`,
      );
    } catch (error) {
      params.deps.onWarning?.(`Failed to pull inbound messages for adapter ${adapter.providerId}`, error);
      continue;
    }

    const ackableInbound: ChannelBridgeInboundMessage[] = [];

    for (const rawEvent of inbound) {
      const event: ChannelBridgeInboundMessage =
        rawEvent.providerId === adapter.providerId
          ? rawEvent
          : {
            ...rawEvent,
            providerId: adapter.providerId,
          };

      if (rawEvent.providerId !== adapter.providerId) {
        params.deps.onWarning?.(
          `Inbound provider mismatch; using adapter providerId=${adapter.providerId} instead of event providerId=${rawEvent.providerId}`,
        );
      }

      if (deduper.hasSeen(event)) {
        ackableInbound.push(event);
        continue;
      }

      let processedSuccessfully = false;

      try {
        const command = parseSlashCommand(event.text);
        if (command) {
          await handleCommand({
            command,
            event,
            adapter,
            store: params.store,
            deps: params.deps,
          });
          deduper.markSeen(event);
          ackableInbound.push(event);
          processedSuccessfully = true;
          continue;
        }

        if (event.text.trim().startsWith('/')) {
          try {
            await replyToConversation(adapter, {
              conversationId: event.conversationId,
              threadId: event.threadId,
            }, 'Unknown command. Use /help for supported commands.');
          } catch (replyError) {
            params.deps.onWarning?.(
              `Failed to send unknown-command reply for provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'}`,
              replyError,
            );
          }
          deduper.markSeen(event);
          ackableInbound.push(event);
          processedSuccessfully = true;
          continue;
        }

        const ref: ChannelBridgeConversationRef = {
          providerId: adapter.providerId,
          conversationId: event.conversationId,
          threadId: event.threadId,
        };
        let binding: ChannelSessionBinding | null;
        try {
          binding = await withTimeout(
            params.store.getBinding(ref),
            EXTERNAL_IO_TIMEOUT_MS,
            `store.getBinding(${ref.providerId}:${ref.conversationId}:${ref.threadId ?? 'null'})`,
          );
        } catch (error) {
          params.deps.onWarning?.(
            `Failed to read binding for inbound message forwarding (provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'})`,
            error,
          );
          try {
            await replyToConversation(
              adapter,
              ref,
              'Failed to read current session binding. Please try again later.',
            );
          } catch (replyError) {
            params.deps.onWarning?.(
              `Failed to send binding-read-failure reply for provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'}`,
              replyError,
            );
          }
          deduper.markSeen(event);
          ackableInbound.push(event);
          processedSuccessfully = true;
          continue;
        }

        if (!binding) {
          try {
            await replyToConversation(
              adapter,
              ref,
              'No session is attached here. Use /attach <session-id-or-prefix> first.',
            );
          } catch (replyError) {
            params.deps.onWarning?.(
              `Failed to send no-binding reply for provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'}`,
              replyError,
            );
          }
          deduper.markSeen(event);
          ackableInbound.push(event);
          processedSuccessfully = true;
          continue;
        }

        const senderId = normalizeSenderId(event.senderId);
        const forwardAuthz = authorizeInboundForwarding({
          binding,
          senderId,
        });
        if (!forwardAuthz.allowed) {
          try {
            await replyToConversation(
              adapter,
              ref,
              forwardAuthz.message ?? 'You are not authorized to send messages here.',
            );
          } catch (replyError) {
            params.deps.onWarning?.(
              `Failed to send forwarding-unauthorized reply for provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'}`,
              replyError,
            );
          }
          deduper.markSeen(event);
          ackableInbound.push(event);
          processedSuccessfully = true;
          continue;
        }

        try {
          await withTimeout(
            params.deps.sendUserMessageToSession({
              sessionId: binding.sessionId,
              text: event.text,
              sentFrom: adapter.providerId,
              providerId: adapter.providerId,
              conversationId: event.conversationId,
              threadId: event.threadId,
              messageId: event.messageId,
            }),
            EXTERNAL_IO_TIMEOUT_MS,
            `sendUserMessageToSession(${binding.sessionId})`,
          );
        } catch (error) {
          params.deps.onWarning?.(
            `Failed to forward channel message into session ${binding.sessionId} (provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'} messageId=${event.messageId}); message will not be retried because the user is notified in-channel`,
            error,
          );
          try {
            await replyToConversation(
              adapter,
              ref,
              `Failed to send message to session ${binding.sessionId}.`,
            );
          } catch (replyError) {
            params.deps.onWarning?.(
              `Failed to send session-forward-failure reply for provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'}`,
              replyError,
            );
          }
        }
        processedSuccessfully = true;
      } catch (error) {
        params.deps.onWarning?.(`Failed to process inbound message for adapter ${adapter.providerId}`, error);
      }

      if (processedSuccessfully) {
        deduper.markSeen(event);
        ackableInbound.push(event);
      }
    }

    if (adapter.ackInboundMessages && ackableInbound.length > 0) {
      try {
        await withTimeout(
          Promise.resolve(adapter.ackInboundMessages(ackableInbound)),
          EXTERNAL_IO_TIMEOUT_MS,
          `ackInboundMessages(${adapter.providerId})`,
        );
      } catch (error) {
        params.deps.onWarning?.(`Failed to acknowledge inbound messages for adapter ${adapter.providerId}`, error);
      }
    }
  }

  let bindings: ChannelSessionBinding[];
  try {
    bindings = await withTimeout(
      params.store.listBindings(),
      EXTERNAL_IO_TIMEOUT_MS,
      'store.listBindings()',
    );
  } catch (error) {
    params.deps.onWarning?.('Failed to list bindings for outbound forwarding', error);
    return;
  }

  const warnedMissingAdapterBindings = params.warnedMissingAdapterBindings;
  if (warnedMissingAdapterBindings) {
    const activeBindingKeys = new Set(bindings.map((binding) => bindingKey(binding)));
    for (const warnedKey of warnedMissingAdapterBindings) {
      if (!activeBindingKeys.has(warnedKey)) {
        warnedMissingAdapterBindings.delete(warnedKey);
      }
    }
  }

  for (const binding of bindings) {
    const missingBindingWarningKey = bindingKey(binding);
    const adapter = adapterByProvider.get(binding.providerId);
    if (!adapter) {
      if (!warnedMissingAdapterBindings || !warnedMissingAdapterBindings.has(missingBindingWarningKey)) {
        params.deps.onWarning?.(
          `No adapter registered for binding providerId=${binding.providerId} conversationId=${binding.conversationId}; skipping outbound forwarding`,
        );
        warnedMissingAdapterBindings?.add(missingBindingWarningKey);
      }
      continue;
    }

    warnedMissingAdapterBindings?.delete(missingBindingWarningKey);

    try {
      const fetchedMessages = await withTimeout(
        params.deps.fetchAgentMessagesAfterSeq({
          sessionId: binding.sessionId,
          afterSeq: binding.lastForwardedSeq,
        }),
        EXTERNAL_IO_TIMEOUT_MS,
        `fetchAgentMessagesAfterSeq(${binding.sessionId})`,
      );

      const {
        messages,
        highestSeenSeq,
      } = normalizeAgentFetchResult(fetchedMessages);

      const orderedMessages: Array<Readonly<{ seq: number; text: string }>> = [];
      for (const row of messages) {
        const parsedSeq = toNonNegativeInt(row.seq);
        if (parsedSeq === null) {
          params.deps.onWarning?.(
            `Skipped agent output row with invalid seq for session ${binding.sessionId}`,
          );
          continue;
        }
        orderedMessages.push({
          seq: parsedSeq,
          text: row.text,
        });
      }

      orderedMessages.sort((left, right) => left.seq - right.seq);

      let maxSeq = binding.lastForwardedSeq;
      const persistCursor = async (nextSeq: number): Promise<boolean> => {
        try {
          maxSeq = nextSeq;
          const advanced = await withTimeout(
            params.store.updateLastForwardedSeq(binding, {
              expectedSessionId: binding.sessionId,
              seq: maxSeq,
            }),
            EXTERNAL_IO_TIMEOUT_MS,
            `store.updateLastForwardedSeq(${binding.providerId}:${binding.conversationId}:${binding.threadId ?? 'null'}:${binding.sessionId}:${maxSeq})`,
          );
          if (!advanced) {
            params.deps.onWarning?.(
              `Skipped cursor advance because binding changed or cursor was stale for session=${binding.sessionId} provider=${binding.providerId} conversation=${binding.conversationId} seq=${nextSeq}`,
            );
            return false;
          }
          return true;
        } catch (error) {
          params.deps.onWarning?.(
            `Failed to persist channel bridge cursor for session=${binding.sessionId} provider=${binding.providerId} conversation=${binding.conversationId} seq=${nextSeq}`,
            error,
          );
          return false;
        }
      };

      if (orderedMessages.length === 0 && highestSeenSeq !== null && highestSeenSeq > maxSeq) {
        await persistCursor(highestSeenSeq);
        continue;
      }

      for (const row of orderedMessages) {
        const parsedSeq = row.seq;
        if (parsedSeq <= maxSeq) {
          continue;
        }

        const nextSeq = parsedSeq;
        const text = String(row.text).trim();
        if (!text) {
          const persisted = await persistCursor(nextSeq);
          if (!persisted) {
            break;
          }
          continue;
        }
        try {
          await withTimeout(
            adapter.sendMessage({
              conversationId: binding.conversationId,
              threadId: binding.threadId,
              text,
            }),
            EXTERNAL_IO_TIMEOUT_MS,
            `sendMessage(${adapter.providerId})`,
          );
        } catch (error) {
          if (isChannelBridgePermanentDeliveryFailure(error)) {
            params.deps.onWarning?.(
              `Detected permanent delivery failure; advancing outbound cursor without retry for session=${binding.sessionId} provider=${binding.providerId} conversation=${binding.conversationId} seq=${nextSeq}`,
              error,
            );
          } else {
            throw error;
          }
        }
        const persisted = await persistCursor(nextSeq);
        if (!persisted) {
          break;
        }
      }
    } catch (error) {
      params.deps.onWarning?.(
        `Failed to forward agent output to channel for session=${binding.sessionId} provider=${binding.providerId} conversation=${binding.conversationId}`,
        error,
      );
    }
  }
}

/**
 * Start the bridge worker loop.
 *
 * - `tickMs` is clamped to a minimum of 250ms (default 2500ms)
 * - Uses single-flight scheduling: only one tick runs at a time
 * - `trigger()` requests an immediate tick
 * - `stop()` is idempotent, drains in-flight tick, then stops adapters
 * - Adapter shutdown deduplicates by object identity, not `providerId`
 */
export function startChannelBridgeWorker(params: Readonly<{
  store: ChannelBindingStore;
  adapters: readonly ChannelBridgeAdapter[];
  deps: ChannelBridgeDeps;
  tickMs?: number;
}>): ChannelBridgeWorkerHandle {
  const tickMs =
    typeof params.tickMs === 'number' && Number.isFinite(params.tickMs) && params.tickMs > 0
      ? Math.max(250, Math.trunc(params.tickMs))
      : 2_500;

  const inboundDeduper = createChannelBridgeInboundDeduper();
  const warnedMissingAdapterBindings = new Set<string>();
  let inFlightTick: Promise<void> | null = null;

  const runTick = async (): Promise<void> => {
    const tickRun = executeChannelBridgeTick({
      store: params.store,
      adapters: params.adapters,
      deps: params.deps,
      inboundDeduper,
      warnedMissingAdapterBindings,
    });
    inFlightTick = tickRun;
    try {
      await tickRun;
    } finally {
      if (inFlightTick === tickRun) {
        inFlightTick = null;
      }
    }
  };

  let loop: SingleFlightIntervalLoopHandle | null = startSingleFlightIntervalLoop({
    intervalMs: tickMs,
    task: runTick,
    onError: (error) => {
      params.deps.onWarning?.('Channel bridge tick failed', error);
    },
  });

  loop.trigger();
  let stopPromise: Promise<void> | null = null;

  return {
    stop: async () => {
      if (stopPromise) {
        await stopPromise;
        return;
      }

      stopPromise = (async () => {
        const activeLoop = loop;
        loop = null;
        activeLoop?.stop();

        await Promise.resolve();

        const currentTick = inFlightTick;
        if (currentTick) {
          try {
            await currentTick;
          } catch {
            // Tick failures are already surfaced via loop onError while running.
            // During shutdown we only drain the in-flight tick before adapter stop.
          }
        }

        const adaptersToStop: ChannelBridgeAdapter[] = [];
        const seenAdapters = new Set<ChannelBridgeAdapter>();
        for (const adapter of params.adapters) {
          if (seenAdapters.has(adapter)) {
            continue;
          }
          seenAdapters.add(adapter);
          adaptersToStop.push(adapter);
        }

        const stopResults = await Promise.allSettled(
          adaptersToStop.map(async (adapter) => {
            if (typeof adapter.stop !== 'function') return;
            await withTimeout(
              Promise.resolve(adapter.stop()),
              EXTERNAL_IO_TIMEOUT_MS,
              `adapter.stop(${adapter.providerId})`,
            );
          }),
        );

        stopResults.forEach((result, index) => {
          if (result.status === 'rejected') {
            const providerId = adaptersToStop[index]?.providerId ?? 'unknown';
            params.deps.onWarning?.(`Failed to stop channel adapter ${providerId} during shutdown`, result.reason);
          }
        });
      })();

      await stopPromise;
    },
    trigger: () => loop?.trigger(),
  };
}
