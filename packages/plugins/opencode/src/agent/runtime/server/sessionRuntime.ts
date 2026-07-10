import type {
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import type {
  RuntimePromptAcceptedCallbackV1,
  RuntimePromptTerminallyRejectedBeforeProviderCallbackV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { normalizeOpenCodeSkills } from './catalog/control.js';
import { readRuntimePromptIdentity, toRuntimePromptCallbackInfo } from './promptIdentity.js';

const OPEN_CODE_COMPLETION_POLL_INTERVAL_MS = 250;

function readRuntimeInputText(input: RuntimeInputPayloadV1): string {
  return normalizeString(asRecord(input)?.text);
}

function readRuntimePromptModelId(options: RuntimeSendOptionsV1 | undefined): string | null {
  const modelId = typeof options?.modelId === 'string' ? options.modelId.trim() : '';
  return modelId.length > 0 ? modelId : null;
}

function accepted(): RuntimeSendResultV1 {
  return { status: 'accepted' };
}

function isTerminalEvent(event: RuntimeEventV1): boolean {
  return event.kind === 'turn-complete'
    || event.kind === 'turn-failed'
    || event.kind === 'turn-cancelled';
}

function isPreProviderFailureEvent(event: RuntimeEventV1): boolean {
  if (event.kind !== 'turn-failed') return false;
  const issue = asRecord(event.issue);
  const code = normalizeString(issue?.code);
  return code === 'opencode_prompt_submission_failed'
    || code === 'opencode_runtime_startup_failed';
}

function isProviderAcceptanceEvidenceEvent(event: RuntimeEventV1): boolean {
  if (event.kind === 'turn-start' || event.kind === 'turn-input-appended') return false;
  if (isPreProviderFailureEvent(event)) return false;
  return event.kind === 'message-delta'
    || event.kind === 'tool-call'
    || event.kind === 'tool-result'
    || event.kind === 'tool-progress'
    || event.kind === 'turn-progress'
    || event.kind === 'turn-complete'
    || event.kind === 'turn-failed'
    || event.kind === 'turn-cancelled'
    || event.kind === 'turn-agent-id-observed'
    || event.kind === 'transcript-agent-message-committed';
}

function readRuntimeEventTurnId(event: RuntimeEventV1): string | null {
  return normalizeString(asRecord(event)?.turnId) || null;
}

function waitForPollInterval(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error('OpenCode send was aborted');
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      timer = null;
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('OpenCode send was aborted'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, OPEN_CODE_COMPLETION_POLL_INTERVAL_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createOpenCodePublicSessionRuntime(
  operations: OpenCodeRuntimeTurnOperations,
): SessionRuntimeV1 & Readonly<{
  isTurnInFlight(): boolean;
  waitForTurnCompletion(): Promise<void>;
  listSkills(options?: Readonly<{ cwd?: string }>): Promise<unknown>;
}> {
  let active = false;
  let activeTurnId: string | null = null;
  let onPromptAcceptedByProvider: RuntimePromptAcceptedCallbackV1 | null = null;
  let onPromptTerminallyRejectedBeforeProvider:
    RuntimePromptTerminallyRejectedBeforeProviderCallbackV1 | null = null;
  let completionPump: Promise<void> | null = null;
  const pendingPromptAcceptances: Array<{
    identity: ReturnType<typeof readRuntimePromptIdentity>;
    providerEvidenceObserved: boolean;
    submitted: boolean;
  }> = [];
  const flushProviderAcceptedPrompts = (): void => {
    const accepted = pendingPromptAcceptances.filter((pending) =>
      pending.submitted && pending.providerEvidenceObserved);
    if (accepted.length === 0) return;
    for (const pending of accepted) {
      const index = pendingPromptAcceptances.indexOf(pending);
      if (index >= 0) pendingPromptAcceptances.splice(index, 1);
      confirmPromptAccepted(pending.identity);
    }
  };
  const observeProviderAcceptanceEvidence = (event: RuntimeEventV1): void => {
    if (!isProviderAcceptanceEvidenceEvent(event)) return;
    for (const pending of pendingPromptAcceptances) {
      if (!pending.submitted) continue;
      pending.providerEvidenceObserved = true;
    }
    flushProviderAcceptedPrompts();
  };
  const enqueuePromptAcceptance = (identity: ReturnType<typeof readRuntimePromptIdentity>) => {
    const pending = {
      identity,
      providerEvidenceObserved: false,
      submitted: false,
    };
    pendingPromptAcceptances.push(pending);
    return pending;
  };
  const resolvePromptSubmitted = (
    pending: ReturnType<typeof enqueuePromptAcceptance>,
  ): void => {
    pending.submitted = true;
    flushProviderAcceptedPrompts();
  };
  const removePendingPromptAcceptance = (
    pending: ReturnType<typeof enqueuePromptAcceptance>,
  ): void => {
    const index = pendingPromptAcceptances.indexOf(pending);
    if (index >= 0) pendingPromptAcceptances.splice(index, 1);
  };
  const rejectPendingPromptAcceptancesBeforeProvider = (): void => {
    const rejected = pendingPromptAcceptances.splice(0);
    for (const pending of rejected) {
      confirmPromptTerminallyRejected(pending.identity);
    }
  };
  const subscribers = new Set<(event: RuntimeEventV1) => void>();
  const unsubscribeOperations = operations.subscribeRuntimeEvents((event) => {
    if (event.kind === 'turn-start') {
      active = true;
      activeTurnId = readRuntimeEventTurnId(event);
    }
    if (isPreProviderFailureEvent(event)) {
      rejectPendingPromptAcceptancesBeforeProvider();
    }
    if (isTerminalEvent(event)) {
      const terminalTurnId = readRuntimeEventTurnId(event);
      if (!terminalTurnId || (activeTurnId !== null && terminalTurnId === activeTurnId)) {
        active = false;
        activeTurnId = null;
      }
    }
    observeProviderAcceptanceEvidence(event);
    for (const subscriber of Array.from(subscribers)) {
      subscriber(event);
    }
  });

  const waitForCompletion = async (signal?: AbortSignal): Promise<void> => {
    while (active) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error('OpenCode send was aborted');
      }
      await operations.waitForTurnCompletion();
      if (active) await waitForPollInterval(signal);
    }
  };
  const startCompletionPump = (signal?: AbortSignal): void => {
    const pump = waitForCompletion(signal).finally(() => {
      if (completionPump === pump) completionPump = null;
    });
    completionPump = pump;
    void pump.catch(() => undefined);
  };
  const waitForCurrentCompletionPump = async (): Promise<void> => {
    const pump = completionPump;
    if (pump) {
      await pump;
      return;
    }
    await waitForCompletion();
  };
  const confirmPromptAccepted = (identity: ReturnType<typeof readRuntimePromptIdentity>): void => {
    onPromptAcceptedByProvider?.(toRuntimePromptCallbackInfo(identity));
  };
  const confirmPromptTerminallyRejected = (identity: ReturnType<typeof readRuntimePromptIdentity>): void => {
    onPromptTerminallyRejectedBeforeProvider?.(toRuntimePromptCallbackInfo(identity));
  };

  return {
    identity: {
      read: () => ({
        providerSessionId: operations.readSessionIdentity().sessionId,
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
    isTurnInFlight: () => active,
    waitForTurnCompletion: waitForCurrentCompletionPump,
    async send(input, options?: RuntimeSendOptionsV1) {
      const text = readRuntimeInputText(input);
      if (!text) {
        return {
          status: 'rejected',
          diagnostic: 'OpenCode runtime input did not include text',
        };
      }
      if (options?.deliverAs === 'followUp') {
        return {
          status: 'unsupported',
          diagnostic: 'OpenCode does not support queued follow-up delivery yet',
        };
      }
      if (options?.deliverAs === 'steer') {
        active = true;
        activeTurnId = null;
        const identity = readRuntimePromptIdentity(options);
        const modelId = readRuntimePromptModelId(options);
        const pendingAcceptance = enqueuePromptAcceptance(identity);
        try {
          await operations.steerInFlightTurn(text, {
            ...(identity.localInputIds[0] ? { localInputId: identity.localInputIds[0] } : {}),
            ...(identity.localInputIds.length === 0 ? {} : { localInputIds: identity.localInputIds }),
            ...(modelId ? { modelId } : {}),
            ...(identity.userMessageSeq === null ? {} : { userMessageSeq: identity.userMessageSeq }),
            ...(identity.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: identity.userMessageSeqs }),
          });
        } catch (error) {
          removePendingPromptAcceptance(pendingAcceptance);
          throw error;
        }
        resolvePromptSubmitted(pendingAcceptance);
        startCompletionPump(options.signal);
        return accepted();
      }
      active = true;
      activeTurnId = null;
      const identity = readRuntimePromptIdentity(options);
      const modelId = readRuntimePromptModelId(options);
      operations.beginTurnLifecycle();
      const pendingAcceptance = enqueuePromptAcceptance(identity);
      try {
        await operations.sendTurnPrompt(text, {
          ...(identity.localInputIds[0] ? { localInputId: identity.localInputIds[0] } : {}),
          ...(identity.localInputIds.length === 0 ? {} : { localInputIds: identity.localInputIds }),
          ...(modelId ? { modelId } : {}),
          ...(identity.userMessageSeq === null ? {} : { userMessageSeq: identity.userMessageSeq }),
          ...(identity.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: identity.userMessageSeqs }),
        });
      } catch (error) {
        removePendingPromptAcceptance(pendingAcceptance);
        throw error;
      }
      resolvePromptSubmitted(pendingAcceptance);
      startCompletionPump(options?.signal);
      return accepted();
    },
    async cancel() {
      await operations.cancelTurn();
      return { status: 'cancelled' };
    },
    async listSkills(options = {}) {
      return {
        supported: true,
        skills: normalizeOpenCodeSkills(await operations.listSkills({ directory: options.cwd })),
      };
    },
    permissions: { capability: 'inline' },
    updateConfig: async (update) => {
      await operations.updateSessionRuntimeConfig(update);
    },
    setOnPromptAcceptedByProvider(handler) {
      onPromptAcceptedByProvider = handler;
    },
    setOnPromptTerminallyRejectedBeforeProvider(handler) {
      onPromptTerminallyRejectedBeforeProvider = handler;
    },
    dispose: async () => {
      unsubscribeOperations();
      subscribers.clear();
      active = false;
      activeTurnId = null;
      pendingPromptAcceptances.length = 0;
      onPromptAcceptedByProvider = null;
      onPromptTerminallyRejectedBeforeProvider = null;
      await operations.resetOrDisposeRuntime();
    },
  };
}
