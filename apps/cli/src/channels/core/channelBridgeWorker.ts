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
 * - `sendMessage` should deliver text into a target conversation/thread.
 * - `sendMessage` should tolerate at-least-once delivery attempts. Timeout races may
 *   trigger retries, so provider adapters should be idempotent when possible.
 * - `stop` is optional and should tear down adapter resources.
 */
export type ChannelBridgeAdapter = Readonly<{
  providerId: string;
  pullInboundMessages: () => Promise<ChannelBridgeInboundMessage[]>;
  sendMessage: (params: Readonly<{ conversationId: string; threadId: string | null; text: string }>) => Promise<void>;
  stop?: () => void | Promise<void>;
}>;

/**
 * Persisted conversation -> session mapping and agent cursor state.
 */
export type ChannelSessionBinding = ChannelBridgeConversationRef & Readonly<{
  sessionId: string;
  lastForwardedSeq: number;
  createdAtMs: number;
  updatedAtMs: number;
}>;

/**
 * Resolution result for `/attach <session-id-or-prefix>`.
 */
export type ResolveSessionIdResult =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>;

/**
 * Bridge dependencies supplied by runtime integration.
 *
 * - `resolveLatestSessionSeq` should return the latest valid non-negative transcript cursor.
 * - `fetchAgentMessagesAfterSeq` should return rows with `seq > afterSeq`.
 *   Results may be unsorted; the worker enforces ascending `seq` delivery before forwarding.
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
  }>) => Promise<void>;
  resolveLatestSessionSeq: (sessionId: string) => Promise<number>;
  fetchAgentMessagesAfterSeq: (params: Readonly<{ sessionId: string; afterSeq: number }>) => Promise<Array<Readonly<{ seq: number; text: string }>>>;
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
  }>) => Promise<ChannelSessionBinding>;
  updateLastForwardedSeq: (ref: ChannelBridgeConversationRef, seq: number) => Promise<void>;
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

const DEFAULT_EXTERNAL_IO_TIMEOUT_MS = 30_000;

function resolveExternalIoTimeoutMs(): number {
  const raw = (process.env.HAPPIER_CHANNEL_BRIDGE_IO_TIMEOUT_MS ?? '').trim();
  if (!raw) {
    return DEFAULT_EXTERNAL_IO_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
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
  isDuplicate: (message: ChannelBridgeInboundMessage) => boolean;
}>;

/**
 * Create an inbound deduper for channel messages.
 *
 * Use this to isolate dedupe state across independent bridge instances sharing the same process.
 */
export function createChannelBridgeInboundDeduper(now: () => number = () => Date.now()): ChannelBridgeInboundDeduper {
  const recent = new Map<string, number>();
  const ttlMs = 5 * 60 * 1000;
  const maxEntries = 20_000;
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

  return {
    isDuplicate: (message) => {
      const normalizedMessageId = String(message.messageId).trim();
      if (normalizedMessageId.length === 0) {
        return false;
      }

      const key = JSON.stringify([message.providerId, message.conversationId, message.threadId, normalizedMessageId]);
      const currentNow = now();
      prune(currentNow);
      if (recent.has(key)) return true;
      recent.set(key, currentNow);
      return false;
    },
  };
}

/**
 * Create an in-memory binding store.
 *
 * `now` is injectable for deterministic tests.
 */
export function createInMemoryChannelBindingStore(now: () => number = () => Date.now()): ChannelBindingStore {
  const byKey = new Map<string, ChannelSessionBinding>();

  return {
    listBindings: async () => Array.from(byKey.values()).map((binding) => ({ ...binding })),
    getBinding: async (ref) => {
      const found = byKey.get(bindingKey(ref));
      return found ? { ...found } : null;
    },
    upsertBinding: async (binding) => {
      const key = bindingKey(binding);
      const existing = byKey.get(key);
      const normalizedLastForwardedSeq = toNonNegativeInt(binding.lastForwardedSeq) ?? 0;
      const next: ChannelSessionBinding = {
        providerId: binding.providerId,
        conversationId: binding.conversationId,
        threadId: binding.threadId,
        sessionId: binding.sessionId,
        lastForwardedSeq: normalizedLastForwardedSeq,
        createdAtMs: existing?.createdAtMs ?? now(),
        updatedAtMs: now(),
      };
      byKey.set(key, { ...next });
      return { ...next };
    },
    updateLastForwardedSeq: async (ref, seq) => {
      const key = bindingKey(ref);
      const existing = byKey.get(key);
      if (!existing) return;
      const parsedSeq = toNonNegativeInt(seq);
      if (parsedSeq === null) return;
      const nextSeq = Math.max(existing.lastForwardedSeq, parsedSeq);
      byKey.set(key, {
        ...existing,
        lastForwardedSeq: nextSeq,
        updatedAtMs: now(),
      });
    },
    removeBinding: async (ref) => byKey.delete(bindingKey(ref)),
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
  return `Active sessions:\n${body}${suffix}`;
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

  const senderRaw = params.event.senderId;
  const senderId = typeof senderRaw === 'string' && senderRaw.trim().length > 0 ? senderRaw.trim() : null;
  const actor: ChannelBridgeActorContext = {
    providerId: params.event.providerId,
    conversationId: params.event.conversationId,
    threadId: params.event.threadId,
    senderId,
  };

  try {
    const result = await authorize({
      commandName: params.commandName,
      actor,
    });
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
}>): Promise<true> {
  const { command, event, adapter, store, deps } = params;
  const ref: ChannelBridgeConversationRef = {
    providerId: event.providerId,
    conversationId: event.conversationId,
    threadId: event.threadId,
  };

  if (command.name !== 'help' && command.name !== 'start') {
    const authz = await authorizeCommand({
      commandName: command.name,
      event,
      deps,
    });
    if (!authz.allowed) {
      await replyToConversation(
        adapter,
        ref,
        authz.message ?? 'You are not authorized to run this command here.',
      );
      return true;
    }
  }

  if (command.name === 'help' || command.name === 'start') {
    await replyToConversation(
      adapter,
      ref,
      [
        'Happier bridge commands:',
        '/sessions - list recent sessions',
        '/attach <session-id-or-prefix> - bind this DM/topic',
        '/detach - unbind this DM/topic',
        '/session - show current binding',
        '/help - show command help',
        '/start - alias for /help',
      ].join('\n'),
    );
    return true;
  }

  if (command.name === 'sessions') {
    let sessions: Array<Readonly<{ sessionId: string; label: string | null }>>;
    try {
      sessions = await deps.listSessions();
    } catch (error) {
      deps.onWarning?.('Failed to list sessions for /sessions command', error);
      await replyToConversation(adapter, ref, 'Failed to retrieve sessions. Please try again later.');
      return true;
    }
    await replyToConversation(adapter, ref, formatSessionsMessage(sessions));
    return true;
  }

  if (command.name === 'session') {
    let existing: ChannelSessionBinding | null;
    try {
      existing = await store.getBinding(ref);
    } catch (error) {
      deps.onWarning?.('Failed to read binding for /session command', error);
      await replyToConversation(adapter, ref, 'Failed to read current session binding. Please try again later.');
      return true;
    }

    if (!existing) {
      await replyToConversation(adapter, ref, 'No session is attached here. Use /attach <session-id-or-prefix>.');
      return true;
    }
    await replyToConversation(adapter, ref, `Attached session: ${existing.sessionId}`);
    return true;
  }

  if (command.name === 'attach') {
    const idOrPrefix = String(command.args[0] ?? '').trim();
    if (!idOrPrefix) {
      await replyToConversation(adapter, ref, 'Usage: /attach <session-id-or-prefix>');
      return true;
    }

    let resolved: ResolveSessionIdResult;
    try {
      resolved = await deps.resolveSessionIdOrPrefix(idOrPrefix);
    } catch (error) {
      deps.onWarning?.('Failed to resolve session by id/prefix for attach', error);
      await replyToConversation(
        adapter,
        ref,
        `Failed to attach to session ${idOrPrefix}: unable to resolve session identifier.`,
      );
      return true;
    }

    if (!resolved.ok) {
      if (resolved.code === 'session_id_ambiguous') {
        if (resolved.candidates && resolved.candidates.length > 0) {
          await replyToConversation(
            adapter,
            ref,
            `Ambiguous session prefix. Candidates:\n${resolved.candidates.map((id) => `• ${id}`).join('\n')}`,
          );
          return true;
        }

        await replyToConversation(adapter, ref, 'Ambiguous session prefix. Use /sessions to list active sessions.');
        return true;
      }

      if (resolved.code === 'unsupported') {
        await replyToConversation(adapter, ref, 'Attaching by session ID or prefix is not supported in this environment.');
        return true;
      }
      await replyToConversation(adapter, ref, 'Session not found. Use /sessions to list recent sessions.');
      return true;
    }

    let latestSeq: number;
    try {
      const resolvedSeq = toNonNegativeInt(await deps.resolveLatestSessionSeq(resolved.sessionId));
      if (resolvedSeq === null) {
        deps.onWarning?.(
          `resolveLatestSessionSeq returned an invalid value for session ${resolved.sessionId}; expected a non-negative integer`,
        );
        await replyToConversation(
          adapter,
          ref,
          `Failed to attach to session ${resolved.sessionId}: unable to resolve latest sequence cursor.`,
        );
        return true;
      }
      latestSeq = resolvedSeq;
    } catch (error) {
      deps.onWarning?.('Failed to resolve latest session sequence for attach', error);
      await replyToConversation(
        adapter,
        ref,
        `Failed to attach to session ${resolved.sessionId}: unable to resolve latest sequence cursor.`,
      );
      return true;
    }

    let previousBinding: ChannelSessionBinding | null;
    try {
      previousBinding = await store.getBinding(ref);
    } catch (error) {
      deps.onWarning?.('Failed to read existing binding during /attach', error);
      await replyToConversation(adapter, ref, 'Failed to read current binding before attach. Please try again later.');
      return true;
    }
    const previousSessionId = previousBinding?.sessionId ?? null;

    try {
      await store.upsertBinding({
        providerId: ref.providerId,
        conversationId: ref.conversationId,
        threadId: ref.threadId,
        sessionId: resolved.sessionId,
        lastForwardedSeq: latestSeq,
      });
    } catch (error) {
      deps.onWarning?.('Failed to persist binding during /attach', error);
      await replyToConversation(adapter, ref, `Failed to attach to session ${resolved.sessionId}: unable to persist binding.`);
      return true;
    }

    const switchedFrom =
      previousSessionId && previousSessionId !== resolved.sessionId
        ? ` (replaced previous session ${previousSessionId})`
        : '';
    await replyToConversation(adapter, ref, `Attached this conversation to session ${resolved.sessionId}${switchedFrom}.`);
    return true;
  }

  if (command.name === 'detach') {
    let removed = false;
    try {
      removed = await store.removeBinding(ref);
    } catch (error) {
      deps.onWarning?.('Failed to remove binding for /detach command', error);
      await replyToConversation(adapter, ref, 'Failed to detach current session binding. Please try again later.');
      return true;
    }

    if (removed) {
      await replyToConversation(adapter, ref, 'Detached this conversation from Happier session.');
    } else {
      await replyToConversation(adapter, ref, 'No session was attached here.');
    }
    return true;
  }

  await replyToConversation(adapter, ref, `Unknown command: /${command.name}. Use /help for supported commands.`);
  return true;
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
  inboundDeduper: Readonly<{
    isDuplicate: (message: ChannelBridgeInboundMessage) => boolean;
  }>;
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

      if (deduper.isDuplicate(event)) {
        continue;
      }

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
          continue;
        }

        if (event.text.trim().startsWith('/')) {
          await replyToConversation(adapter, {
            conversationId: event.conversationId,
            threadId: event.threadId,
          }, 'Unknown command. Use /help for supported commands.');
          continue;
        }

        const ref: ChannelBridgeConversationRef = {
          providerId: adapter.providerId,
          conversationId: event.conversationId,
          threadId: event.threadId,
        };
        let binding: ChannelSessionBinding | null;
        try {
          binding = await params.store.getBinding(ref);
        } catch (error) {
          params.deps.onWarning?.(
            `Failed to read binding for inbound message forwarding (provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'})`,
            error,
          );
          await replyToConversation(
            adapter,
            ref,
            'Failed to read current session binding. Please try again later.',
          );
          continue;
        }

        if (!binding) {
          await replyToConversation(
            adapter,
            ref,
            'No session is attached here. Use /attach <session-id-or-prefix> first.',
          );
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
            }),
            EXTERNAL_IO_TIMEOUT_MS,
            `sendUserMessageToSession(${binding.sessionId})`,
          );
        } catch (error) {
          params.deps.onWarning?.(
            `Failed to forward channel message into session ${binding.sessionId} (provider=${adapter.providerId} conversation=${event.conversationId} thread=${event.threadId ?? 'null'} messageId=${event.messageId})`,
            error,
          );
          await replyToConversation(
            adapter,
            ref,
            `Failed to send message to session ${binding.sessionId}.`,
          );
        }
      } catch (error) {
        params.deps.onWarning?.(`Failed to process inbound message for adapter ${adapter.providerId}`, error);
      }
    }
  }

  let bindings: ChannelSessionBinding[];
  try {
    bindings = await params.store.listBindings();
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
      const messages = await withTimeout(
        params.deps.fetchAgentMessagesAfterSeq({
          sessionId: binding.sessionId,
          afterSeq: binding.lastForwardedSeq,
        }),
        EXTERNAL_IO_TIMEOUT_MS,
        `fetchAgentMessagesAfterSeq(${binding.sessionId})`,
      );

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
          await params.store.updateLastForwardedSeq(binding, maxSeq);
          return true;
        } catch (error) {
          params.deps.onWarning?.(
            `Failed to persist channel bridge cursor for session=${binding.sessionId} provider=${binding.providerId} conversation=${binding.conversationId} seq=${nextSeq}`,
            error,
          );
          return false;
        }
      };

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
        await withTimeout(
          adapter.sendMessage({
            conversationId: binding.conversationId,
            threadId: binding.threadId,
            text,
          }),
          EXTERNAL_IO_TIMEOUT_MS,
          `sendMessage(${adapter.providerId})`,
        );
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
            await adapter.stop();
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
