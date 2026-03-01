import { randomUUID } from 'node:crypto';

import type { McpServerConfig } from '@/agent';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import { configuration } from '@/configuration';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from './types';
import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from './client';
import { extractOpenCodeTextHistoryItems, importOpenCodeTextHistoryCommitted } from './openCodeSessionMessageImport';
import { extractOpenCodeTaskChildSessionId, importOpenCodeTaskSidechainBestEffort } from './openCodeTaskSidechainImport';
import {
  createOpenCodeAscendingMessageId,
  resolveOpenCodeUserMessageIdFromMetadata,
  upsertOpenCodeUserMessageIdInMetadata,
} from './openCodeUserMessageIds';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : '')).filter(Boolean);
}

function parseOpenCodeModelId(raw: string): OpenCodeModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { providerID: trimmed.slice(0, idx), modelID: trimmed.slice(idx + 1) };
}

function extractOpenCodeSessionMessageId(raw: unknown): string | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const info = asRecord(rec.info);
  if (!info) return null;
  const id = normalizeString(info.id).trim();
  return id.length > 0 ? id : null;
}

function normalizeEnvVar(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOpenCodeDefaultProviderIdFromModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const idx = trimmed.indexOf('/');
  if (idx <= 0) return '';
  return trimmed.slice(0, idx);
}

function extractOpenCodeErrorText(error: unknown): string | null {
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const rec = error as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message.trim() : '';
    if (message) return message;
    const data = rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data) ? (rec.data as Record<string, unknown>) : null;
    const dataMessage = typeof data?.message === 'string' ? String(data.message).trim() : '';
    if (dataMessage) return dataMessage;
    const detail = typeof rec.detail === 'string' ? rec.detail.trim() : '';
    if (detail) return detail;
    const errorText = typeof rec.error === 'string' ? rec.error.trim() : '';
    if (errorText) return errorText;
  }
  return null;
}

function modelSupportsToolCalls(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return false;
  const status = normalizeString(rec.status);
  if (status && status !== 'active') return false;
  const capabilities = asRecord(rec.capabilities);
  if (!capabilities) return false;
  if (capabilities.toolcall !== true) return false;
  const input = asRecord(capabilities.input);
  if (input && input.text === false) return false;
  return true;
}

function splitCommaSeparatedLabels(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function hasAnyMeaningfulInputFields(rawInput: unknown): boolean {
  if (rawInput == null) return false;
  if (typeof rawInput === 'string') return rawInput.trim().length > 0;
  if (Array.isArray(rawInput)) return rawInput.length > 0;
  const rec = asRecord(rawInput);
  if (!rec) return false;
  return Object.keys(rec).length > 0;
}

function extractBashCommandHint(rawInput: unknown): string {
  const rec = asRecord(rawInput);
  if (!rec) return '';
  const command = normalizeString(rec.command);
  if (command) return command;
  const cmd = normalizeString(rec.cmd);
  if (cmd) return cmd;
  const argv = Array.isArray(rec.argv) ? rec.argv : Array.isArray(rec.items) ? rec.items : null;
  if (Array.isArray(argv) && argv.every((v) => typeof v === 'string')) {
    const joined = (argv as string[]).join(' ').trim();
    if (joined) return joined;
  }
  return '';
}

function buildQuestionAnswersArray(params: {
  questions: ReadonlyArray<Record<string, unknown>>;
  answersByQuestionKey: Record<string, string>;
}): string[][] {
  const out: string[][] = [];
  for (const q of params.questions) {
    const question = normalizeString(q.question);
    const header = normalizeString(q.header);
    const key = question.trim().length > 0 ? question : header;
    const raw = typeof params.answersByQuestionKey[key] === 'string' ? params.answersByQuestionKey[key]! : '';
    out.push(splitCommaSeparatedLabels(raw));
  }
  return out;
}

function looksLikeFreeformQuestionHintLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  // OpenCode sometimes encodes freeform questions as a single “type/enter your answer” option.
  // Treat these as typed answers rather than a real selection.
  return normalized.includes('type') || normalized.includes('enter') || normalized.includes('your own answer');
}

function parseQuestionRequest(raw: unknown): OpenCodeQuestionRequest | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = normalizeString(rec.id);
  const sessionID = normalizeString(rec.sessionID);
  if (!id || !sessionID) return null;
  const questionsRaw = rec.questions;
  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];
  const toolRec = asRecord(rec.tool);
  const tool = toolRec
    ? { messageID: normalizeString(toolRec.messageID), callID: normalizeString(toolRec.callID) }
    : undefined;
  return { id, sessionID, questions, ...(tool?.messageID && tool.callID ? { tool } : {}) };
}

function parsePermissionRequest(raw: unknown): OpenCodePermissionRequest | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = normalizeString(rec.id);
  const sessionID = normalizeString(rec.sessionID);
  const permission = normalizeString(rec.permission);
  if (!id || !sessionID || !permission) return null;
  const patterns = normalizeStringArray(rec.patterns);
  const always = normalizeStringArray(rec.always);
  const metadata = (asRecord(rec.metadata) ?? {}) as Record<string, unknown>;
  const toolRec = asRecord(rec.tool);
  const tool = toolRec
    ? { messageID: normalizeString(toolRec.messageID), callID: normalizeString(toolRec.callID) }
    : undefined;
  return { id, sessionID, permission, patterns, metadata, always, ...(tool?.messageID && tool.callID ? { tool } : {}) };
}

function parseOpenCodeToolPart(raw: unknown): {
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  state: Record<string, unknown>;
} | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (normalizeString(rec.type) !== 'tool') return null;
  const sessionID = normalizeString(rec.sessionID);
  const messageID = normalizeString(rec.messageID);
  const callID = normalizeString(rec.callID);
  const tool = normalizeString(rec.tool);
  const state = asRecord(rec.state);
  if (!sessionID || !messageID || !callID || !tool || !state) return null;
  return { sessionID, messageID, callID, tool, state };
}

export type OpenCodeServerRuntimeDeps = Readonly<{
  createClient?: typeof createOpenCodeServerRuntimeClient;
}>;

export function createOpenCodeServerRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: ProviderEnforcedPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
}, deps: OpenCodeServerRuntimeDeps = {}) {
  const provider: ACPProvider = 'opencode';
  const createClient = deps.createClient ?? createOpenCodeServerRuntimeClient;

  let client: OpenCodeServerRuntimeClient | null = null;
  let sessionId: string | null = null;
  let subscriptionAbort: AbortController | null = null;

  let selectedAgent: string | null = null;
  let selectedModel: OpenCodeModelRef | null = null;
  const configOverrides: Record<string, unknown> = {};

  let turnDeferred: Deferred<void> | null = null;
  let turnInFlight = false;
  let turnPromptActive = false;
  let turnActivitySeen = false;
  let turnUserMessageId: string | null = null;
  let turnPreexistingMessageIds: ReadonlySet<string> | null = null;
  let idleSignalSeen = false;
  let resolveOnIdleInFlight = false;
  let turnControlAbort: AbortController | null = null;
  let handledPermissionIds: Set<string> | null = null;
  let handledQuestionIds: Set<string> | null = null;
  let inFlightPermissionIds: Set<string> | null = null;
  let inFlightQuestionIds: Set<string> | null = null;
  let userMessageIdLastTimestampMs = 0;
  let userMessageIdCounter = 0;

  let turnStreamKey: string | null = null;
  const accumulatedTextByPartKey = new Map<string, string>();

  const sessionPermissionRuleset = [
    // Default policy: ask for outside-worktree edits (relative paths beginning with ../), then allow in-worktree edits.
    // OpenCode applies the first matching rule, so ordering is important here.
    { permission: 'edit', pattern: '../*', action: 'ask' },
    { permission: 'edit', pattern: '*', action: 'allow' },
  ] as const;

  const partTypeByPartId = new Map<string, string>();
  const toolCallSentByCallId = new Set<string>();
  const toolCallHadMeaningfulInputByCallId = new Map<string, boolean>();
  const bashCommandHintByCallId = new Map<string, string>();
  const toolResultSentByCallId = new Set<string>();

  const ensureClient = async (): Promise<OpenCodeServerRuntimeClient> => {
    if (client) return client;
    client = await createClient({
      directory: params.directory,
      messageBuffer: params.messageBuffer,
    });
    return client;
  };

  const publishDynamicSessionOptionsBestEffort = () => {
    void (async () => {
      if (!sessionId) return;
      const c = await ensureClient();

      const [config, agents, providers] = await Promise.all([
        c.globalConfigGet().catch(() => ({})),
        c.agentsList().catch(() => []),
        c.providersList().catch(() => []),
      ]);

      const defaultModelId = typeof (config as any)?.model === 'string' ? String((config as any).model).trim() : '';
      const defaultProviderId = defaultModelId ? resolveOpenCodeDefaultProviderIdFromModelId(defaultModelId) : '';

      const includedProviders = (Array.isArray(providers) ? providers : []).filter((p) => {
        const id = normalizeString((p as any)?.id);
        if (!id) return false;
        if (defaultProviderId && id === defaultProviderId) return true;
        const env = Array.isArray((p as any)?.env) ? (p as any).env : [];
        if (!Array.isArray(env) || env.length === 0) return false;
        return env.some((k: unknown) => {
          const key = normalizeString(k);
          if (!key) return false;
          return normalizeEnvVar(process.env[key]) !== '';
        });
      });

      const availableModels: Array<{ id: string; name: string; description?: string }> = [];
      for (const p of includedProviders) {
        const providerId = normalizeString((p as any)?.id);
        if (!providerId) continue;
        const modelsRec = asRecord((p as any)?.models);
        if (!modelsRec) continue;
        const keys = Object.keys(modelsRec).sort();
        for (const key of keys) {
          const modelRec = modelsRec[key];
          if (!modelSupportsToolCalls(modelRec)) continue;
          const modelId = normalizeString(asRecord(modelRec)?.id) || key;
          const fullId = `${providerId}/${modelId}`;
          const name = normalizeString(asRecord(modelRec)?.name) || modelId;
          const description = normalizeString(asRecord(modelRec)?.family) || '';
          availableModels.push({ id: fullId, name, ...(description ? { description } : {}) });
        }
      }

      const availableModes = (Array.isArray(agents) ? agents : [])
        .map((a) => ({ id: normalizeString((a as any)?.name), name: normalizeString((a as any)?.name), description: normalizeString((a as any)?.description) }))
        .filter((a) => a.id && a.name)
        .map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) }));

      const currentModeId = selectedAgent
        ?? (availableModes.find((m) => m.id === 'build')?.id ?? availableModes[0]?.id ?? 'build');
      const currentModelId = selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : (defaultModelId || 'default');

      const snapshot = await params.session.ensureMetadataSnapshot({ timeoutMs: 60_000 }).catch(() => null);
      if (!snapshot) return;

      const updatedAt = Date.now();
      await params.session.updateMetadata((prev) => ({
        ...prev,
        acpSessionModesV1: {
          v: 1,
          provider,
          updatedAt,
          currentModeId,
          availableModes,
        },
        acpSessionModelsV1: {
          v: 1,
          provider,
          updatedAt,
          currentModelId,
          availableModels,
        },
      }));
    })().catch((error) => {
      logger.debug('[OpenCodeServer] Failed publishing session options metadata (non-fatal)', error);
    });
  };

  const attachSubscriptionIfNeeded = async (): Promise<void> => {
    if (subscriptionAbort) return;
    const c = await ensureClient();
    const controller = new AbortController();
    subscriptionAbort = controller;

    void c.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (evt) => {
        try {
          handleEvent(evt);
        } catch (error) {
          logger.debug('[OpenCodeServer] Failed handling event (non-fatal)', error);
        }
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      logger.debug('[OpenCodeServer] Global event subscription failed (non-fatal)', error);
    });
  };

  const setThinking = (value: boolean) => {
    params.onThinkingChange(value);
    params.session.keepAlive(value, 'remote');
  };

  const resetTurnEventState = () => {
    turnStreamKey = null;
    turnPromptActive = false;
    turnActivitySeen = false;
    turnUserMessageId = null;
    turnPreexistingMessageIds = null;
    idleSignalSeen = false;
    resolveOnIdleInFlight = false;
    accumulatedTextByPartKey.clear();
    partTypeByPartId.clear();
    toolCallSentByCallId.clear();
    toolCallHadMeaningfulInputByCallId.clear();
    bashCommandHintByCallId.clear();
    toolResultSentByCallId.clear();
    if (turnControlAbort) {
      try {
        turnControlAbort.abort();
      } catch {
        // ignore
      }
    }
    turnControlAbort = null;
    handledPermissionIds = null;
    handledQuestionIds = null;
    inFlightPermissionIds = null;
    inFlightQuestionIds = null;
  };

  const resolveTurn = () => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    resetTurnEventState();
    d.resolve();
  };

  const rejectTurn = (error: unknown) => {
    if (!turnDeferred) return;
    const d = turnDeferred;
    turnDeferred = null;
    resetTurnEventState();
    d.reject(error);
  };

  const pollSleepMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 25 ? Math.trunc(raw) : configuration.pendingQueueIdleWakePollIntervalMs;
    // Clamp to keep control-plane polling responsive without excessive churn.
    return Math.max(25, Math.min(2_000, configured));
  })();

  const turnPreexistingSnapshotLimit = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_TURN_PREEXISTING_SNAPSHOT_LIMIT ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
    return Math.max(10, Math.min(2_000, configured));
  })();

  const abortTimeoutMs = (() => {
    const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_500;
    // Keep abort responsive but allow slow local servers a moment to drain.
    return Math.max(25, Math.min(30_000, configured));
  })();

  const statusPollEnabled = (() => {
    const raw = normalizeEnvVar(process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED);
    if (!raw) return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
  })();

  const shouldTreatMessageIdAsTurnActivity = (messageID: string): boolean => {
    if (!turnPromptActive) return false;
    if (!messageID) return false;
    if (turnUserMessageId && messageID === turnUserMessageId) return false;
    if (turnPreexistingMessageIds && turnPreexistingMessageIds.has(messageID)) return false;
    return true;
  };

  const listPendingPermissionRequests = async (): Promise<OpenCodePermissionRequest[]> => {
    const c = await ensureClient();
    const raw = await c.permissionList().catch(() => []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => parsePermissionRequest(item))
      .filter((item): item is OpenCodePermissionRequest => Boolean(item))
      .filter((item) => item.sessionID === sessionId);
  };

  const listPendingQuestionRequests = async (): Promise<OpenCodeQuestionRequest[]> => {
    const c = await ensureClient();
    const raw = await c.questionList().catch(() => []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => parseQuestionRequest(item))
      .filter((item): item is OpenCodeQuestionRequest => Boolean(item))
      .filter((item) => item.sessionID === sessionId);
  };

  const pollIdleStatusFromControlPlaneBestEffort = async (): Promise<void> => {
    if (!statusPollEnabled) return;
    if (!sessionId) return;
    if (!turnPromptActive) return;
    if (idleSignalSeen) return;
    const c = await ensureClient();
    const statuses = await c.sessionStatusList().catch(() => ({}));
    const rec = statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? (statuses as any)[sessionId] : null;
    const statusType = normalizeString(asRecord(rec)?.type);
    if (statusType !== 'idle') return;
    setThinking(false);
    idleSignalSeen = true;
  };

  const maybeResolveTurnOnIdleSignal = async () => {
    if (!turnDeferred) return;
    if (!turnPromptActive) return;
    if (!idleSignalSeen) return;
    if (!turnActivitySeen) return;
    if (resolveOnIdleInFlight) return;
    resolveOnIdleInFlight = true;
    try {
      const permissions = await listPendingPermissionRequests();
      const questions = await listPendingQuestionRequests();
      const handledPerms = handledPermissionIds ?? new Set<string>();
      const handledQs = handledQuestionIds ?? new Set<string>();
      const inFlightPerms = inFlightPermissionIds ?? new Set<string>();
      const inFlightQs = inFlightQuestionIds ?? new Set<string>();
      const hasUnhandled =
        permissions.some((p) => !handledPerms.has(p.id) || inFlightPerms.has(p.id)) ||
        questions.some((q) => !handledQs.has(q.id) || inFlightQs.has(q.id));
      if (hasUnhandled) return;
      if (!turnDeferred) return;
      params.session.sendAgentMessage(provider, { type: 'task_complete', id: randomUUID() });
      resolveTurn();
    } finally {
      resolveOnIdleInFlight = false;
    }
  };

  const ensureTurnStreamKey = (): string => {
    if (!turnStreamKey) {
      turnStreamKey = `opencode:turn:${randomUUID()}`;
    }
    return turnStreamKey;
  };

  const resolveOrCreateUserMessageId = async (localIdRaw: string | null | undefined): Promise<string | null> => {
    const localId = typeof localIdRaw === 'string' ? localIdRaw.trim() : '';
    if (!localId) return null;
    const snapshot = params.session.getMetadataSnapshot();
    const existing = resolveOpenCodeUserMessageIdFromMetadata(snapshot, localId);
    if (existing) return existing;

    const nowMs = Date.now();
    if (nowMs !== userMessageIdLastTimestampMs) {
      userMessageIdLastTimestampMs = nowMs;
      userMessageIdCounter = 0;
    }
    userMessageIdCounter += 1;
    if (userMessageIdCounter > 0xfff) {
      userMessageIdLastTimestampMs = nowMs + 1;
      userMessageIdCounter = 1;
    }

    const created = createOpenCodeAscendingMessageId({
      nowMs: userMessageIdLastTimestampMs,
      counter: userMessageIdCounter,
      entropySeed: localId,
    });

    try {
      await params.session.updateMetadata((prev) => {
        const base = prev && typeof prev === 'object' ? (prev as any as Record<string, unknown>) : {};
        return upsertOpenCodeUserMessageIdInMetadata({ metadata: base, localId, messageId: created }) as any;
      });
    } catch {
      // Best-effort: do not block prompt sending on metadata persistence.
    }

    return resolveOpenCodeUserMessageIdFromMetadata(params.session.getMetadataSnapshot(), localId) ?? created;
  };

  const getStreamKeyForMessage = (messageID: string): string => {
    const normalized = typeof messageID === 'string' ? messageID.trim() : '';
    if (!normalized) return ensureTurnStreamKey();
    return `${ensureTurnStreamKey()}:msg:${normalized}`;
  };

  const getThinkingStreamKeyForMessage = (messageID: string): string => {
    return `${getStreamKeyForMessage(messageID)}:thinking`;
  };

  const sendDelta = (delta: string, messageID: string) => {
    if (shouldTreatMessageIdAsTurnActivity(messageID)) {
      turnActivitySeen = true;
    }
    const streamKey = getStreamKeyForMessage(messageID);
    params.session.sendAgentMessage(
      provider,
      { type: 'message', message: delta },
      { meta: { happierStreamKey: streamKey, opencodeMessageId: messageID } },
    );
  };

  const sendThinkingDelta = (delta: string, messageID: string) => {
    if (!delta) return;
    if (!shouldTreatMessageIdAsTurnActivity(messageID)) return;
    turnActivitySeen = true;
    const streamKey = getThinkingStreamKeyForMessage(messageID);
    params.session.sendAgentMessage(
      provider,
      { type: 'thinking', text: delta },
      { meta: { happierStreamKey: streamKey, opencodeMessageId: messageID } },
    );
  };

  const sendToolFromPart = (part: ReturnType<typeof parseOpenCodeToolPart>) => {
    if (!part) return;
    if (part.sessionID !== sessionId) return;
    if (!shouldTreatMessageIdAsTurnActivity(part.messageID)) return;
    turnActivitySeen = true;

    const status = normalizeString(part.state.status);
    const callId = part.callID;
    const messageID = part.messageID;
    const toolRaw = normalizeString(part.tool).trim();
    const toolLower = toolRaw.toLowerCase();
    // OpenCode server surfaces search operations via the tool `grep`, but Happier's ACP dialect (and
    // provider contract tests) treat this as the provider raw tool `search` (canonical CodeSearch/Grep).
    // Alias here so downstream tool normalization attaches `_happier.rawToolName="search"` consistently.
    const toolNameForAcp = toolLower === 'grep' ? 'search' : toolRaw;
    const meta = { opencodeMessageId: messageID };
    const rawInput = (part.state as any).input ?? {};
    const hasMeaningfulInput = hasAnyMeaningfulInputFields(rawInput);
    const isBashLike = part.tool === 'bash' || part.tool === 'Bash' || part.tool === 'execute' || part.tool === 'Terminal';
    const commandHint = isBashLike ? extractBashCommandHint(rawInput) : '';
    const prevHadMeaningfulInput = toolCallHadMeaningfulInputByCallId.get(callId) ?? false;
    const prevCommandHint = bashCommandHintByCallId.get(callId) ?? '';
    const shouldEmitToolCallUpdate =
      toolCallSentByCallId.has(callId) &&
      ((!prevHadMeaningfulInput && hasMeaningfulInput) || (!prevCommandHint && Boolean(commandHint)));

    if (!toolCallSentByCallId.has(callId) || shouldEmitToolCallUpdate) {
      toolCallSentByCallId.add(callId);
      if (hasMeaningfulInput) toolCallHadMeaningfulInputByCallId.set(callId, true);
      if (commandHint) bashCommandHintByCallId.set(callId, commandHint);
      params.session.sendAgentMessage(
        provider,
        { type: 'tool-call', callId, name: toolNameForAcp, input: rawInput, id: randomUUID() },
        { meta },
      );
    }

    if ((status === 'completed' || status === 'error') && !toolResultSentByCallId.has(callId)) {
      toolResultSentByCallId.add(callId);
      if (status === 'completed') {
        const output = {
          output: normalizeString(part.state.output),
          title: normalizeString(part.state.title),
          metadata: asRecord(part.state.metadata) ?? {},
          attachments: Array.isArray((part.state as any).attachments) ? (part.state as any).attachments : undefined,
        };
        params.session.sendAgentMessage(provider, { type: 'tool-result', callId, output, id: randomUUID() }, { meta });

        if (toolLower === 'task') {
          const remoteSessionId = extractOpenCodeTaskChildSessionId({ output: output.output, metadata: output.metadata });
          if (remoteSessionId) {
            void (async () => {
              const c = await ensureClient();
              const imported = await importOpenCodeTaskSidechainBestEffort({
                client: c,
                session: params.session,
                provider,
                remoteSessionId,
                sidechainId: callId,
              });
              if (imported) return;
              const fallback = output.output.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, '').trim();
              if (!fallback) return;
              await params.session.sendAgentMessageCommitted(
                provider,
                { type: 'message', message: fallback, sidechainId: callId },
                { localId: randomUUID(), meta: { importedFrom: 'acp-sidechain', remoteSessionId, sidechainId: callId } },
              );
            })().catch((error) => {
              logger.debug('[OpenCodeServer] Failed to import Task sidechain (non-fatal)', error);
            });
          }
        }
      } else {
        const metadata = asRecord(part.state.metadata);
        const output = {
          status: 'failed',
          error: normalizeString(part.state.error),
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : null),
        };
        params.session.sendAgentMessage(provider, { type: 'tool-result', callId, output, id: randomUUID(), isError: true }, { meta });
      }
    }
  };

  const handleQuestionAsked = async (req: OpenCodeQuestionRequest) => {
    if (req.sessionID !== sessionId) return;

    setThinking(false);
    idleSignalSeen = false;
    if (turnPromptActive) turnActivitySeen = true;
    params.session.sendAgentMessage(provider, { type: 'task_started', id: randomUUID() });

    const questions = req.questions
      .map((q) => (asRecord(q) ?? null))
      .filter(Boolean) as Array<Record<string, unknown>>;

    const askUserQuestionInput = {
      questions: questions.map((q) => ({
        question: normalizeString(q.question),
        header: normalizeString(q.header),
        ...(() => {
          const rawOptions = Array.isArray(q.options) ? q.options : [];
          const options = rawOptions
            .map((opt) => (asRecord(opt) ?? null))
            .filter((opt): opt is Record<string, unknown> => Boolean(opt))
            .map((opt) => ({
              label: normalizeString(opt.label),
              description: normalizeString(opt.description),
            }))
            .filter((opt) => opt.label.trim().length > 0);

          // OpenCode represents some freeform prompts as a single “type now” option with a `locations` field,
          // but Happier’s AskUserQuestion should treat these as typed answers (not a real selection).
          const hasLocations = Array.isArray((q as any).locations);
          const isSingleOptionHint = options.length === 1 && looksLikeFreeformQuestionHintLabel(options[0]!.label);
          const isFreeform = hasLocations || options.length === 0 || (q.multiple !== true && isSingleOptionHint);
          if (!isFreeform) return { options };

          const hint = options[0];
          const placeholder = hint?.label?.trim() ?? '';
          const description = hint?.description?.trim() ?? '';
          return {
            options: [],
            ...(placeholder || description
              ? { freeform: { ...(placeholder ? { placeholder } : null), ...(description ? { description } : null) } }
              : null),
          };
        })(),
        multiSelect: q.multiple === true,
      })),
    };

    const decision = await params.permissionHandler.handleToolCall(req.id, 'AskUserQuestion', askUserQuestionInput);
    const c = await ensureClient();

    if (decision.decision === 'approved' || decision.decision === 'approved_for_session' || decision.decision === 'approved_execpolicy_amendment') {
      const answersByKey = (decision as any).answers as Record<string, string> | undefined;
      const answers = answersByKey && typeof answersByKey === 'object' && !Array.isArray(answersByKey) ? answersByKey : {};
      const answerArray = buildQuestionAnswersArray({ questions, answersByQuestionKey: answers });
      await c.questionReply({ requestId: req.id, answers: answerArray });
      params.session.sendAgentMessage(provider, {
        type: 'tool-result',
        callId: req.id,
        output: { answers },
        id: randomUUID(),
      });
      return;
    }

    if (decision.decision === 'abort') {
      await c.questionReject({ requestId: req.id });
      return;
    }

    await c.questionReject({ requestId: req.id });
  };

  const handlePermissionAsked = async (req: OpenCodePermissionRequest) => {
    if (req.sessionID !== sessionId) return;
    setThinking(false);
    idleSignalSeen = false;
    if (turnPromptActive) turnActivitySeen = true;

    const decision = await params.permissionHandler.handleToolCall(req.id, req.permission, {
      permission: req.permission,
      patterns: req.patterns,
      always: req.always,
      metadata: req.metadata,
    });

    const c = await ensureClient();

    if (decision.decision === 'approved_for_session') {
      // Happier owns "always allow" persistence and scope. Always reply "once" to OpenCode so
      // vendor-side approvals never leak across sessions via a shared server process.
      await c.permissionReply({ requestId: req.id, reply: 'once' });
      return;
    }
    if (decision.decision === 'approved' || decision.decision === 'approved_execpolicy_amendment') {
      await c.permissionReply({ requestId: req.id, reply: 'once' });
      return;
    }
    await c.permissionReply({ requestId: req.id, reply: 'reject' });
  };

  const ensureHandledPermissionIds = (): Set<string> => {
    if (!handledPermissionIds) handledPermissionIds = new Set<string>();
    return handledPermissionIds;
  };

  const ensureHandledQuestionIds = (): Set<string> => {
    if (!handledQuestionIds) handledQuestionIds = new Set<string>();
    return handledQuestionIds;
  };

  const ensureInFlightPermissionIds = (): Set<string> => {
    if (!inFlightPermissionIds) inFlightPermissionIds = new Set<string>();
    return inFlightPermissionIds;
  };

  const ensureInFlightQuestionIds = (): Set<string> => {
    if (!inFlightQuestionIds) inFlightQuestionIds = new Set<string>();
    return inFlightQuestionIds;
  };

  const handleQuestionAskedBestEffort = (req: OpenCodeQuestionRequest) => {
    if (req.sessionID !== sessionId) return;
    const handled = ensureHandledQuestionIds();
    const inFlight = ensureInFlightQuestionIds();
    if (handled.has(req.id) || inFlight.has(req.id)) return;
    inFlight.add(req.id);
    void handleQuestionAsked(req)
      .then(() => {
        handled.add(req.id);
      })
      .catch((error) => {
        logger.debug('[OpenCodeServer] question handler failed (non-fatal)', error);
      })
      .finally(() => {
        inFlight.delete(req.id);
      });
  };

  const handlePermissionAskedBestEffort = (req: OpenCodePermissionRequest) => {
    if (req.sessionID !== sessionId) return;
    const handled = ensureHandledPermissionIds();
    const inFlight = ensureInFlightPermissionIds();
    if (handled.has(req.id) || inFlight.has(req.id)) return;
    inFlight.add(req.id);
    void handlePermissionAsked(req)
      .then(() => {
        handled.add(req.id);
      })
      .catch((error) => {
        logger.debug('[OpenCodeServer] permission handler failed (non-fatal)', error);
      })
      .finally(() => {
        inFlight.delete(req.id);
      });
  };

  const handleEvent = (evt: OpenCodeGlobalEvent) => {
    const payload = evt.payload;
    const type = normalizeString(payload.type);
    const props = payload.properties;

    if (type === 'message.part.updated') {
      const part = asRecord(asRecord(props)?.part);
      if (!part) return;
      const sessionID = normalizeString(part.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      const partID = normalizeString(part.id);
      const partType = normalizeString(part.type);
      if (partID && partType) partTypeByPartId.set(partID, partType);

      const maybeTool = parseOpenCodeToolPart(part);
      if (maybeTool) sendToolFromPart(maybeTool);
      return;
    }

    if (type === 'message.part.delta') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      const messageID = normalizeString(rec.messageID);
      const partID = normalizeString(rec.partID);
      const delta = normalizeString(rec.delta);
      if (!messageID || !partID || !delta) return;
      if (!shouldTreatMessageIdAsTurnActivity(messageID)) return;
      const partType = partTypeByPartId.get(partID) ?? '';
      const accumulationKey = `${messageID}:${partType === 'reasoning' ? 'reasoning' : 'text'}`;
      const accumulated = accumulatedTextByPartKey.get(accumulationKey) ?? '';
      const deltaOut = delta.startsWith(accumulated) ? delta.slice(accumulated.length) : delta;
      accumulatedTextByPartKey.set(
        accumulationKey,
        delta.startsWith(accumulated) ? delta : accumulated + delta,
      );
      if (!deltaOut) return;
      if (partType === 'reasoning') {
        sendThinkingDelta(deltaOut, messageID);
      } else {
        sendDelta(deltaOut, messageID);
      }
      return;
    }

    if (type === 'question.asked') {
      const req = parseQuestionRequest(props);
      if (!req) return;
      handleQuestionAskedBestEffort(req);
      return;
    }

    if (type === 'permission.asked') {
      const req = parsePermissionRequest(props);
      if (!req) return;
      handlePermissionAskedBestEffort(req);
      return;
    }

    if (type === 'session.status') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      const statusRec = asRecord(rec.status);
      const statusType = normalizeString(statusRec?.type);
      if (statusType === 'busy') {
        setThinking(true);
      }
      if (statusType === 'idle') {
        setThinking(false);
        if (turnPromptActive) {
          idleSignalSeen = true;
          void maybeResolveTurnOnIdleSignal();
        }
      }
      return;
    }

    if (type === 'session.idle') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      setThinking(false);
      if (turnPromptActive) {
        idleSignalSeen = true;
        void maybeResolveTurnOnIdleSignal();
      }
      return;
    }

    if (type === 'session.error') {
      const rec = asRecord(props);
      if (!rec) return;
      const sessionID = normalizeString(rec.sessionID);
      if (!sessionID || sessionID !== sessionId) return;
      setThinking(false);
      const detail = extractOpenCodeErrorText(rec.error);
      if (detail) {
        params.session.sendAgentMessage(provider, { type: 'message', message: detail });
      }
      params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
      rejectTurn(rec.error ?? new Error('OpenCode session error'));
      return;
    }
  };

  const resetRuntimeState = () => {
    turnDeferred = null;
    turnInFlight = false;
    resetTurnEventState();
  };

  return {
    getSessionId: () => sessionId,
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => turnInFlight,

    beginTurn(): void {
      turnInFlight = true;
      turnPromptActive = false;
      turnActivitySeen = false;
      idleSignalSeen = false;
      params.session.sendAgentMessage(provider, { type: 'task_started', id: randomUUID() });
      setThinking(true);
    },

    async startOrLoad(opts: { resumeId?: string | null } = {}): Promise<string> {
      await attachSubscriptionIfNeeded();
      const c = await ensureClient();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (resumeId) {
        const existing = await c.sessionGet({ sessionId: resumeId });
        sessionId = existing.id ?? resumeId;
        const sessionDirectory = normalizeString((existing as any)?.directory).trim();
        if (sessionDirectory) {
          try {
            c.setDirectoryOverride(sessionDirectory);
          } catch {
            // non-fatal
          }
        }
        publishDynamicSessionOptionsBestEffort();

        // Best-effort: import remote history into a fresh Happier session when resuming. This powers
        // the provider contract scenario `acp_resume_fresh_session_imports_history`.
        void (async () => {
          try {
            const snapshot = params.session.getMetadataSnapshot();
            const existingVendorSessionId = typeof (snapshot as any)?.opencodeSessionId === 'string'
              ? String((snapshot as any).opencodeSessionId).trim()
              : '';
            // If we're resuming inside an existing Happier session that already has an OpenCode sessionId,
            // do not import remote history again (avoids transcript duplication and resume flakiness).
            if (existingVendorSessionId && existingVendorSessionId === resumeId) {
              return;
            }
            const marker = snapshot && typeof snapshot === 'object' ? (snapshot as any).opencodeResumeHistoryImportV1 : null;
            if (marker && typeof marker === 'object' && (marker as any).v === 1 && String((marker as any).remoteSessionId ?? '') === resumeId) {
              return;
            }

            const raw = await c.sessionMessagesList({ sessionId: resumeId });
            const items = extractOpenCodeTextHistoryItems(raw);
            if (items.length === 0) return;
            await importOpenCodeTextHistoryCommitted({
              session: params.session,
              provider,
              remoteSessionId: resumeId,
              items,
              importedFrom: 'acp-history',
            });
            await params.session.updateMetadata((prev) => ({
              ...(prev as any),
              opencodeResumeHistoryImportV1: { v: 1, remoteSessionId: resumeId, importedAtMs: Date.now() },
            }));
          } catch (error) {
            logger.debug('[OpenCodeServer] Failed to import resume history (non-fatal)', error);
          }
        })();

        return sessionId!;
      }

      const created: OpenCodeSession = await c.sessionCreate({ permission: [...sessionPermissionRuleset] as unknown[] });
      sessionId = created.id;
      const createdDirectory = normalizeString((created as any)?.directory).trim();
      if (createdDirectory) {
        try {
          c.setDirectoryOverride(createdDirectory);
        } catch {
          // non-fatal
        }
      }
      publishDynamicSessionOptionsBestEffort();
      return sessionId!;
    },

    async sendPrompt(prompt: string): Promise<void> {
      await this.sendPromptWithMeta?.({ text: prompt, localId: null });
    },

    async sendPromptWithMeta(paramsWithMeta: { text: string; localId?: string | null }): Promise<void> {
      if (!sessionId) throw new Error('OpenCode server session was not started');
      const c = await ensureClient();

      const messageID = (await resolveOrCreateUserMessageId(paramsWithMeta.localId ?? null)) ?? undefined;
      const agent = selectedAgent ?? undefined;
      const model = selectedModel ?? undefined;
      const config = Object.keys(configOverrides).length > 0 ? { ...configOverrides } : undefined;
      turnDeferred = createDeferred<void>();
      const thisTurnDeferred = turnDeferred;
      turnPromptActive = true;
      turnActivitySeen = false;
      idleSignalSeen = false;
      turnUserMessageId = messageID ?? null;
      turnPreexistingMessageIds = null;
      handledPermissionIds = new Set<string>();
      handledQuestionIds = new Set<string>();
      inFlightPermissionIds = new Set<string>();
      inFlightQuestionIds = new Set<string>();
      const controlAbort = new AbortController();
      turnControlAbort = controlAbort;

      try {
        const raw = await c.sessionMessagesList({ sessionId });
        const items = Array.isArray(raw) ? raw : [];
        const ids: string[] = [];
        for (const row of items) {
          const id = extractOpenCodeSessionMessageId(row);
          if (id) ids.push(id);
        }
        if (ids.length > 0) {
          const tail = ids.length > turnPreexistingSnapshotLimit ? ids.slice(ids.length - turnPreexistingSnapshotLimit) : ids;
          turnPreexistingMessageIds = new Set<string>(tail);
        }
      } catch {
        // Best-effort: fall back to turnPromptActive-only gating.
        turnPreexistingMessageIds = null;
      }

      try {
        await c.sessionPromptAsync({
          sessionId,
          messageId: messageID,
          agent,
          model,
          config,
          parts: [{ type: 'text', text: paramsWithMeta.text }],
        });
      } catch (error) {
        setThinking(false);
        const detail = extractOpenCodeErrorText(error);
        if (detail) {
          params.session.sendAgentMessage(provider, { type: 'message', message: detail });
        }
        params.session.sendAgentMessage(provider, { type: 'turn_aborted', id: randomUUID() });
        rejectTurn(error);
        throw error;
      }

      const pollControlPlaneOnce = async () => {
        if (controlAbort.signal.aborted) return;
        const perms = await listPendingPermissionRequests();
        const qs = await listPendingQuestionRequests();
        await pollIdleStatusFromControlPlaneBestEffort();
        const permIds = handledPermissionIds ?? new Set<string>();
        const qIds = handledQuestionIds ?? new Set<string>();
        const permInFlight = inFlightPermissionIds ?? new Set<string>();
        const qInFlight = inFlightQuestionIds ?? new Set<string>();
        for (const req of perms) {
          if (permIds.has(req.id) || permInFlight.has(req.id)) continue;
          permInFlight.add(req.id);
          try {
            await handlePermissionAsked(req);
            permIds.add(req.id);
          } catch (error) {
            logger.debug('[OpenCodeServer] permission handler failed (non-fatal)', error);
          } finally {
            permInFlight.delete(req.id);
          }
        }
        for (const req of qs) {
          if (qIds.has(req.id) || qInFlight.has(req.id)) continue;
          qInFlight.add(req.id);
          try {
            await handleQuestionAsked(req);
            qIds.add(req.id);
          } catch (error) {
            logger.debug('[OpenCodeServer] question handler failed (non-fatal)', error);
          } finally {
            qInFlight.delete(req.id);
          }
        }
        void maybeResolveTurnOnIdleSignal();
      };

      const pollLoop = (async () => {
        await pollControlPlaneOnce();
        while (!controlAbort.signal.aborted) {
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              cleanup();
              clearTimeout(timer);
              resolve();
            };
            const cleanup = () => {
              controlAbort.signal.removeEventListener('abort', onAbort);
            };

            const timer = setTimeout(() => {
              cleanup();
              resolve();
            }, pollSleepMs);
            timer.unref?.();

            controlAbort.signal.addEventListener('abort', onAbort, { once: true });
            if (controlAbort.signal.aborted) {
              cleanup();
              clearTimeout(timer);
              resolve();
            }
          });
          await pollControlPlaneOnce();
        }
      })().catch((error) => {
        logger.debug('[OpenCodeServer] control-plane polling loop failed (non-fatal)', error);
      });

      try {
        await thisTurnDeferred.promise;
      } finally {
        try {
          controlAbort.abort();
        } catch {
          // ignore
        }
        await pollLoop.catch(() => {});
      }
    },

    flushTurn(): void {
      turnInFlight = false;
      setThinking(false);
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      const c = await ensureClient();
      const abortPromise = c.sessionAbort({ sessionId });

      const outcome = await Promise.race([
        abortPromise.then(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), abortTimeoutMs);
          timer.unref?.();
        }),
      ]).catch(() => 'done' as const);

      if (outcome === 'timeout') {
        void abortPromise.catch(() => {});
      }

      setThinking(false);
      rejectTurn(new Error('OpenCode session aborted'));
      resetRuntimeState();
    },

    async reset(): Promise<void> {
      resetRuntimeState();
      setThinking(false);
      sessionId = null;
      selectedAgent = null;
      selectedModel = null;
      for (const key of Object.keys(configOverrides)) delete configOverrides[key];
      if (subscriptionAbort) {
        try {
          subscriptionAbort.abort();
        } catch {
          // ignore
        }
        subscriptionAbort = null;
      }
      if (client) {
        try {
          await client.dispose();
        } catch (e) {
          logger.debug('[OpenCodeServer] Failed to dispose client (non-fatal)', e);
        }
        client = null;
      }
    },

    async setSessionMode(modeId: string): Promise<void> {
      const trimmed = typeof modeId === 'string' ? modeId.trim() : '';
      selectedAgent = trimmed.length > 0 ? trimmed : null;
      publishDynamicSessionOptionsBestEffort();
    },

    async setSessionConfigOption(configId: string, value: string | number | boolean | null): Promise<void> {
      const normalizedId = typeof configId === 'string' ? configId.trim() : '';
      if (!normalizedId) return;
      if (value === null) {
        delete configOverrides[normalizedId];
        return;
      }
      configOverrides[normalizedId] = value;
    },

    async setSessionModel(modelId: string): Promise<void> {
      const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
      if (!trimmed) {
        selectedModel = null;
        publishDynamicSessionOptionsBestEffort();
        return;
      }
      const parsed = parseOpenCodeModelId(trimmed);
      if (!parsed) throw new Error(`Invalid OpenCode model id: ${modelId}`);
      selectedModel = parsed;
      publishDynamicSessionOptionsBestEffort();
    },
  };
}
