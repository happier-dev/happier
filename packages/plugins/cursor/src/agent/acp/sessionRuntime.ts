import type {
  AcpRuntimeHandleV1,
  AcpSessionRuntimeV1,
  AcpSessionRuntimeConfigUpdateV1,
  RuntimeCancelResultV1,
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeConfigUpdateV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import type {
  RuntimePromptAcceptedCallbackV1,
  RuntimePromptAcceptedInfoV1,
  RuntimePromptTerminallyRejectedBeforeProviderCallbackV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

type CursorRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(): void;
  startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string>;
  sendTurnPrompt(prompt: string): Promise<void>;
  steerInFlightTurn(message: string): Promise<void>;
  waitForTurnCompletion(): Promise<void>;
  subscribeRuntimeEvents(handler: (message: RuntimeEventV1) => void): () => void;
  cancelTurn(): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(update: SessionRuntimeConfigUpdateV1): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;

type PendingPromptAcceptance = {
  info: RuntimePromptAcceptedInfoV1;
  providerEvidenceObserved: boolean;
  submitted: boolean;
};

export type CursorPublicSessionRuntimeParams = Readonly<{
  createHandle(): Promise<AcpRuntimeHandleV1>;
  initialProviderSessionId: string | null;
}>;

function readRuntimeInputText(input: RuntimeInputPayloadV1): string | null {
  return readString(input.text);
}

function readRuntimePromptAcceptedInfo(options: RuntimeSendOptionsV1 | undefined): RuntimePromptAcceptedInfoV1 {
  const localInputIds: string[] = [];
  const appendLocalInputId = (value: unknown): void => {
    const localInputId = readString(value);
    if (!localInputId || localInputIds.includes(localInputId)) return;
    localInputIds.push(localInputId);
  };
  appendLocalInputId(options?.localInputId);
  for (const localInputId of options?.localInputIds ?? []) {
    appendLocalInputId(localInputId);
  }

  const userMessageSeqs: number[] = [];
  const appendUserMessageSeq = (value: unknown): void => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return;
    const userMessageSeq = Math.trunc(value as number);
    if (userMessageSeqs.includes(userMessageSeq)) return;
    userMessageSeqs.push(userMessageSeq);
  };
  appendUserMessageSeq(options?.userMessageSeq);
  for (const userMessageSeq of options?.userMessageSeqs ?? []) {
    appendUserMessageSeq(userMessageSeq);
  }

  const primaryUserMessageSeq = Number.isSafeInteger(options?.userMessageSeq)
    && (options?.userMessageSeq as number) >= 0
    ? Math.trunc(options?.userMessageSeq as number)
    : null;
  return {
    ...(localInputIds[0] ? { localInputId: localInputIds[0] } : {}),
    ...(localInputIds.length === 0 ? {} : { localInputIds }),
    userMessageSeq: primaryUserMessageSeq,
    ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
  };
}

function isProviderAcceptanceEvidenceEvent(event: RuntimeEventV1): boolean {
  return event.kind === 'message-delta'
    || event.kind === 'tool-call'
    || event.kind === 'tool-result'
    || event.kind === 'tool-progress'
    || event.kind === 'turn-agent-id-observed'
    || event.kind === 'turn-progress'
    || event.kind === 'turn-complete';
}

function isProviderAcceptanceTerminalRejectionEvent(event: RuntimeEventV1): boolean {
  return event.kind === 'turn-failed' || event.kind === 'turn-cancelled';
}

function isCursorOutputEvidenceEvent(event: RuntimeEventV1): boolean {
  return event.kind === 'message-delta';
}

function buildCursorEmptyProviderResponseEvent(event: Extract<RuntimeEventV1, { kind: 'turn-complete' }>): RuntimeEventV1 {
  return {
    kind: 'turn-failed',
    sessionId: event.sessionId,
    emittedAtMs: Date.now(),
    turnId: event.turnId,
    ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
    issue: {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'cursor_empty_provider_response',
      source: 'agent_session_error',
      agentId: 'cursor',
      occurredAt: Date.now(),
      sanitizedPreview: 'Cursor completed the turn without returning an assistant message.',
    },
  };
}

function normalizeConfigOption(update: Readonly<{
  configOption?: unknown;
}>): AcpSessionRuntimeConfigUpdateV1['configOption'] {
  const configOption = update.configOption;
  if (!isRecord(configOption)) return undefined;
  const id = readString(configOption.id);
  if (!id) return undefined;
  const rawValue = configOption.value;
  const value =
    typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean' || rawValue === null
      ? rawValue
      : undefined;
  if (value === undefined) return undefined;
  return Object.freeze({ id, value });
}

function normalizeRuntimeConfigUpdate(update: Readonly<{
  modeId?: unknown;
  mode?: unknown;
  modelId?: unknown;
  model?: unknown;
  configOption?: unknown;
}>): AcpSessionRuntimeConfigUpdateV1 {
  const modeId = readString(update.modeId) ?? readString(update.mode);
  const modelId = readString(update.modelId) ?? readString(update.model);
  const configOption = normalizeConfigOption(update);
  return Object.freeze({
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(configOption ? { configOption } : {}),
  });
}

function createCursorHostRuntimeOperations(params: Readonly<{
  handle: AcpRuntimeHandleV1;
  sessionRuntime: AcpSessionRuntimeV1;
  initialProviderSessionId: string | null;
}>): CursorRuntimeTurnOperations {
  let providerSessionId: string | null = params.initialProviderSessionId;
  return Object.freeze({
    beginTurnLifecycle() {
      params.sessionRuntime.beginTurnLifecycle();
    },
    async startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string> {
      const nextProviderSessionId = readRuntimeProviderSessionId(opts, providerSessionId);
      providerSessionId = nextProviderSessionId
        ? await params.sessionRuntime.startOrLoadSession({
            providerSessionId: nextProviderSessionId,
            mcpServers: [],
          })
        : await params.sessionRuntime.startOrLoadSession({ mcpServers: [] });
      return providerSessionId;
    },
    async sendTurnPrompt(prompt: string): Promise<void> {
      await params.sessionRuntime.sendTurnPrompt(prompt);
    },
    async steerInFlightTurn(message: string): Promise<void> {
      await params.sessionRuntime.sendTurnPrompt(message);
    },
    async waitForTurnCompletion(): Promise<void> {
      await params.sessionRuntime.waitForTurnCompletion();
    },
    subscribeRuntimeEvents(handler) {
      return params.sessionRuntime.subscribeRuntimeEvents(handler);
    },
    async cancelTurn(): Promise<void> {
      await params.sessionRuntime.cancelTurn();
    },
    readSessionIdentity() {
      return {
        sessionId: providerSessionId,
      };
    },
    async updateSessionRuntimeConfig(update: SessionRuntimeConfigUpdateV1): Promise<void> {
      await params.sessionRuntime.updateSessionRuntimeConfig(normalizeRuntimeConfigUpdate(update));
    },
    async resetOrDisposeRuntime(): Promise<void> {
      await params.handle.dispose('cursor-session-runtime-disposed');
    },
  });
}

function readRuntimeProviderSessionId(params: unknown, fallback: string | null): string | null {
  if (!isRecord(params)) {
    return fallback;
  }
  return readString(params.providerSessionId)
    ?? readString(params.cursorSessionId)
    ?? fallback;
}

function accepted(): RuntimeSendResultV1 {
  return { status: 'accepted' };
}

function unavailable(diagnostic: string): RuntimeSendResultV1 {
  return { status: 'unavailable', diagnostic };
}

function notRunning(): RuntimeCancelResultV1 {
  return { status: 'not_running' };
}

export function createCursorPublicSessionRuntime(params: CursorPublicSessionRuntimeParams): SessionRuntimeV1 {
  let operationsPromise: Promise<CursorRuntimeTurnOperations> | null = null;
  let operations: CursorRuntimeTurnOperations | null = null;
  let operationsUnsubscribe: (() => void) | null = null;
  let providerSessionStarted = false;
  let providerSessionId = params.initialProviderSessionId;
  let disposed = false;
  let promptAcceptedCallback: RuntimePromptAcceptedCallbackV1 | null = null;
  let promptTerminallyRejectedBeforeProviderCallback:
    RuntimePromptTerminallyRejectedBeforeProviderCallbackV1 | null = null;
  const pendingPromptAcceptances: PendingPromptAcceptance[] = [];
  const subscribers = new Set<(event: RuntimeEventV1) => void>();
  let activeTurnId: string | null = null;
  let activeTurnHasOutputEvidence = false;

  const flushProviderAcceptedPrompts = (): void => {
    const accepted = pendingPromptAcceptances.filter((pending) =>
      pending.submitted && pending.providerEvidenceObserved);
    for (const pending of accepted) {
      const index = pendingPromptAcceptances.indexOf(pending);
      if (index >= 0) pendingPromptAcceptances.splice(index, 1);
      promptAcceptedCallback?.(pending.info);
    }
  };

  const rejectPendingPromptAcceptancesBeforeProvider = (): void => {
    const rejected = pendingPromptAcceptances.filter((pending) => !pending.providerEvidenceObserved);
    for (const pending of rejected) {
      const index = pendingPromptAcceptances.indexOf(pending);
      if (index >= 0) pendingPromptAcceptances.splice(index, 1);
      promptTerminallyRejectedBeforeProviderCallback?.(pending.info);
    }
  };

  const observeProviderAcceptanceEvidence = (event: RuntimeEventV1): void => {
    if (!isProviderAcceptanceEvidenceEvent(event)) return;
    for (const pending of pendingPromptAcceptances) {
      pending.providerEvidenceObserved = true;
    }
    flushProviderAcceptedPrompts();
  };

  const enqueuePromptAcceptance = (info: RuntimePromptAcceptedInfoV1): PendingPromptAcceptance => {
    const pending = {
      info,
      providerEvidenceObserved: false,
      submitted: false,
    };
    pendingPromptAcceptances.push(pending);
    return pending;
  };

  const markPromptSubmitted = (pending: PendingPromptAcceptance): void => {
    pending.submitted = true;
    flushProviderAcceptedPrompts();
  };

  const removePendingPromptAcceptance = (pending: PendingPromptAcceptance): void => {
    const index = pendingPromptAcceptances.indexOf(pending);
    if (index >= 0) pendingPromptAcceptances.splice(index, 1);
  };

  const submitPromptWithAcceptanceTracking = async (
    info: RuntimePromptAcceptedInfoV1,
    submit: () => Promise<void>,
  ): Promise<void> => {
    const pending = enqueuePromptAcceptance(info);
    try {
      await submit();
      markPromptSubmitted(pending);
    } catch (error) {
      removePendingPromptAcceptance(pending);
      throw error;
    }
  };

  const publishEvent = (event: RuntimeEventV1): void => {
    for (const subscriber of Array.from(subscribers)) {
      subscriber(event);
    }
  };

  const getOperations = async (): Promise<CursorRuntimeTurnOperations> => {
    if (disposed) {
      throw new Error('Cursor runtime has been disposed.');
    }
    if (!operationsPromise) {
      operationsPromise = params.createHandle().then((handle) => {
        const createdOperations = createCursorHostRuntimeOperations({
          handle,
          sessionRuntime: handle.sessionRuntime,
          initialProviderSessionId: params.initialProviderSessionId,
        });
        operations = createdOperations;
        operationsUnsubscribe = createdOperations.subscribeRuntimeEvents((event) => {
          const eventTurnId = readString(event.turnId) ?? null;
          if (event.kind === 'turn-start') {
            activeTurnId = eventTurnId;
            activeTurnHasOutputEvidence = false;
          } else if (activeTurnId && isCursorOutputEvidenceEvent(event)) {
            activeTurnHasOutputEvidence = true;
          }

          const shouldPublishEmptyDiagnostic = event.kind === 'turn-complete'
            && activeTurnId !== null
            && !activeTurnHasOutputEvidence;

          const publishedEvent = shouldPublishEmptyDiagnostic
            ? buildCursorEmptyProviderResponseEvent(event)
            : event;

          if (isProviderAcceptanceTerminalRejectionEvent(publishedEvent)) {
            rejectPendingPromptAcceptancesBeforeProvider();
          }
          observeProviderAcceptanceEvidence(publishedEvent);
          publishEvent(publishedEvent);

          if (
            publishedEvent.kind === 'turn-complete'
            || publishedEvent.kind === 'turn-failed'
            || publishedEvent.kind === 'turn-cancelled'
          ) {
            activeTurnId = null;
            activeTurnHasOutputEvidence = false;
          }
        });
        return createdOperations;
      });
    }
    return operationsPromise;
  };

  const ensureProviderSessionStarted = async (
    createdOperations: CursorRuntimeTurnOperations,
  ): Promise<void> => {
    if (providerSessionStarted) return;
    providerSessionId = await createdOperations.startOrLoadSession();
    providerSessionStarted = true;
  };

  const sendText = async (
    text: string,
    options: RuntimeSendOptionsV1 | undefined,
  ): Promise<RuntimeSendResultV1> => {
    if (disposed) {
      return unavailable('Cursor runtime has been disposed.');
    }
    if (options?.signal?.aborted === true) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Cursor send was aborted.');
    }
    if (options?.deliverAs === 'followUp') {
      return {
        status: 'unsupported',
        diagnostic: 'Cursor does not support queued follow-up delivery yet.',
      };
    }
    const createdOperations = await getOperations();
    await ensureProviderSessionStarted(createdOperations);
    const acceptedInfo = readRuntimePromptAcceptedInfo(options);
    if (options?.deliverAs === 'steer') {
      await submitPromptWithAcceptanceTracking(acceptedInfo, async () => {
        await createdOperations.steerInFlightTurn(text);
      });
      return accepted();
    }
    createdOperations.beginTurnLifecycle();
    await submitPromptWithAcceptanceTracking(acceptedInfo, async () => {
      await createdOperations.sendTurnPrompt(text);
    });
    return accepted();
  };

  return {
    identity: {
      read: () => ({
        providerSessionId: operations?.readSessionIdentity().sessionId ?? providerSessionId,
      }),
    },
    events: {
      subscribe: (handler) => {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      },
    },
    async send(input: RuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1> {
      const text = readRuntimeInputText(input);
      if (!text) {
        return {
          status: 'rejected',
          diagnostic: 'Cursor runtime input did not include text.',
        };
      }
      return sendText(text, options);
    },
    async cancel(): Promise<RuntimeCancelResultV1> {
      if (!operationsPromise) return notRunning();
      const createdOperations = await operationsPromise;
      await createdOperations.cancelTurn();
      return { status: 'cancelled' };
    },
    permissions: {
      capability: 'inline',
    },
    updateConfig: async (update: SessionRuntimeConfigUpdateV1) => {
      const createdOperations = await getOperations();
      await createdOperations.updateSessionRuntimeConfig(update);
    },
    setOnPromptAcceptedByProvider: (handler) => {
      promptAcceptedCallback = handler;
    },
    setOnPromptTerminallyRejectedBeforeProvider: (handler) => {
      promptTerminallyRejectedBeforeProviderCallback = handler;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      subscribers.clear();
      pendingPromptAcceptances.length = 0;
      promptAcceptedCallback = null;
      promptTerminallyRejectedBeforeProviderCallback = null;
      if (!operationsPromise) return;
      const createdOperations = await operationsPromise;
      operationsUnsubscribe?.();
      operationsUnsubscribe = null;
      await createdOperations.resetOrDisposeRuntime();
    },
  };
}
