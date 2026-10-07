import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentAuthoredSessionRuntimeCapabilities,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionModelsSnapshot,
  AgentSessionModesSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { normalizeOpenCodeSkills } from './skills.js';
import type { OpenCodeRuntimeEvent, OpenCodeRuntimeIssue } from './runtimeEvents.js';
import {
  buildOpenCodePromptParts,
  OpenCodePromptProjectionError,
} from './promptParts.js';
import { projectOpenCodeSessionConfiguration } from './promptConfig.js';
import { projectOpenCodeTurnCancellationCause } from './openCodeRuntimeEvents.js';
import type { OpenCodeActiveSkillsReaderRegistrar } from '../controls.js';
import { OPEN_CODE_TURN_COMPLETION_FALLBACK_INTERVAL_MS } from './timeoutPolicy.js';


type NativeEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type OpenCodeNativeSessionRuntime = AgentSessionRuntime & Readonly<{
  isTurnInFlight(): boolean;
  waitForTurnCompletion(): Promise<void>;
}>;

function diagnostic(code: string, message?: string | null) {
  return {
    code,
    severity: 'error' as const,
    ...(message ? { message } : {}),
  };
}

function toRuntimeJson(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapIssue(issue: OpenCodeRuntimeIssue) {
  return {
    ...diagnostic(issue.code, issue.sanitizedPreview),
    details: {
      v: issue.v,
      source: issue.source,
      agentId: issue.agentId,
    },
  };
}

function mapRuntimeEvent(
  event: Exclude<OpenCodeRuntimeEvent, { kind: 'model-catalog-observed' | 'mode-catalog-observed' }>,
): NativeEventInput | null {
  if (event.kind === 'available-commands') {
    return { kind: 'available-commands', commands: event.commands };
  }
  if (event.kind === 'turn-start') {
    return { kind: 'turn-start', turnId: event.turnId, startedBy: event.startedBy ?? 'host' };
  }
  if (event.kind === 'message-delta') {
    return { kind: 'message-delta', turnId: event.turnId, channel: event.channel, text: event.text,
      ...(event.messageId ? { messageId: event.messageId } : {}) };
  }
  if (event.kind === 'turn-complete') {
    return { kind: 'turn-complete', turnId: event.turnId };
  }
  if (event.kind === 'turn-failed') {
    return {
      kind: 'turn-failed',
      turnId: event.turnId,
      diagnostic: mapIssue(event.issue),
    };
  }
  if (event.kind === 'turn-cancelled') {
    return {
      kind: 'turn-cancelled',
      turnId: event.turnId,
      cause: projectOpenCodeTurnCancellationCause(event.reason),
    };
  }
  if (event.kind === 'tool-call') {
    return {
      kind: 'tool-call',
      turnId: event.turnId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: toRuntimeJson(event.toolInput),
    };
  }
  if (event.kind === 'tool-result') {
    return {
      kind: 'tool-result',
      turnId: event.turnId,
      toolCallId: event.toolCallId,
      output: toRuntimeJson(event.output),
      ...(event.isError === undefined ? {} : { isError: event.isError }),
    };
  }
  if (event.kind === 'transcript-user-text') {
    return {
      kind: 'transcript-message-committed',
      messageId: event.localId,
      role: 'user',
      text: event.text,
    };
  }
  if (event.kind === 'context-compaction') {
    if (event.phase === 'started') {
      return {
        kind: 'context-compaction',
        compactionId: event.compactionId,
        phase: 'started',
        trigger: event.trigger,
      };
    }
    if (event.phase === 'progress') {
      return {
        kind: 'context-compaction',
        compactionId: event.compactionId,
        phase: 'progress',
        trigger: event.trigger,
      };
    }
    if (event.phase === 'completed') {
      return {
        kind: 'context-compaction',
        compactionId: event.compactionId,
        phase: 'completed',
        trigger: event.trigger,
      };
    }
    if (event.phase === 'failed') {
      return {
        kind: 'context-compaction',
        compactionId: event.compactionId,
        phase: 'failed',
        trigger: event.trigger,
        diagnostic: event.diagnostic ?? diagnostic('opencode_compaction_failed'),
      };
    }
    return {
      kind: 'context-compaction',
      compactionId: event.compactionId,
      phase: 'cancelled',
      trigger: event.trigger,
      ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
    };
  }
  const body = asRecord(event.body);
  const message = normalizeString(body?.message);
  if (!message) return null;
  return {
    kind: 'transcript-message-committed',
    messageId: event.localId,
    role: 'assistant',
    text: message,
  };
}

function waitForCompletionEventOrFallback(
  terminalWaiters: Set<() => void>,
  isActive: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error('OpenCode send was aborted');
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      terminalWaiters.delete(wake);
      timer = null;
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('OpenCode send was aborted'));
    };
    terminalWaiters.add(wake);
    timer = setTimeout(wake, OPEN_CODE_TURN_COMPLETION_FALLBACK_INTERVAL_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (!isActive()) wake();
  });
}

export function createOpenCodeSessionRuntime(params: Readonly<{
  operations: OpenCodeRuntimeTurnOperations;
  request: AgentSessionOpenRequest;
  disposeOperations(): Promise<void>;
  models?: AgentSessionRuntimeContext['session']['services']['models'];
  modes?: AgentSessionRuntimeContext['session']['services']['modes'];
  inputFiles?: NonNullable<AgentSessionRuntimeContext['session']['services']['inputFiles']>;
  bindActiveSkillsReader?: OpenCodeActiveSkillsReaderRegistrar;
  runtimeCapabilities: AgentAuthoredSessionRuntimeCapabilities;
  prepareTerminalPresentation?: NonNullable<AgentSessionRuntime['prepareTerminalPresentation']>;
}>): OpenCodeNativeSessionRuntime {
  const launchPermissionIntent = params.request.configuration?.permissionIntent.value ?? null;
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  const terminalWaiters = new Set<() => void>();
  let sequence = 0;
  let disposed = false;
  let active = false;
  let activeTurnId: string | null = null;
  let latestCompletedTurnId: string | null = null;
  let providerSessionId: string | null = null;
  let effectiveModelId: string | null = null;
  let availableCommands: Array<Readonly<{ name: string; description?: string }>> | null = null;
  const canonicalProviderBindingModelId = params.request.providerBinding
    ? params.request.providerBinding.model.id.trim()
    : null;
  const modelListeners = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
  const readModels = () => {
    const catalog = params.operations.readModelCatalog();
    // A configured Provider owns its public membership; OpenCode's private dispatch carrier does not.
    return {
      ...(!params.request.providerBinding && catalog.models !== null
        ? catalog
        : {
            observedAt: 0,
            models: effectiveModelId ? [{ id: effectiveModelId, name: effectiveModelId }] : [],
          }),
      currentModelId: effectiveModelId,
    };
  };
  const modelsBinding = params.models?.bind({
    read: readModels,
    subscribe(listener) {
      modelListeners.add(listener);
      listener(readModels());
      return { dispose: () => { modelListeners.delete(listener); } };
    },
  });
  const modeListeners = new Set<(snapshot: AgentSessionModesSnapshot) => void>();
  const modesBinding = params.modes?.bind({
    read: () => params.operations.readModeCatalog(),
    subscribe(listener) {
      modeListeners.add(listener);
      listener(params.operations.readModeCatalog());
      return { dispose: () => { modeListeners.delete(listener); } };
    },
  });
  const publishEffectiveModel = (dispatchedModelId: string | null | undefined): void => {
    const modelId = params.request.providerBinding
      ? canonicalProviderBindingModelId
      : dispatchedModelId;
    if (!modelId || modelId === effectiveModelId) return;
    effectiveModelId = modelId;
    const snapshot = readModels();
    for (const listener of Array.from(modelListeners)) listener(snapshot);
  };
  type PendingSend = {
    request: AgentSessionSendRequest;
    custody: 'pending' | 'accepted' | 'unknown' | 'rejected';
    providerInvocationStarted: boolean;
    deferredRuntimeEvents: AgentSessionPreAdmissionBuffer<Readonly<{
      input: NativeEventInput;
      emittedAtMs: number;
    }>>;
    deferredRuntimeEventFailure:
      | Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }>
      | null;
  };
  let pendingSend: PendingSend | null = null;

  const publish = (
    input: NativeEventInput,
    emittedAtMs = Date.now(),
  ): void => {
    const event = Object.freeze({
      ...input,
      sequence: ++sequence,
      sessionId: params.request.sessionId,
      emittedAtMs,
    }) as AgentSessionRuntimeEvent;
    for (const listener of Array.from(listeners)) listener(event);
  };
  const publishProviderIdentity = (): void => {
    const next = params.operations.readSessionIdentity().sessionId;
    if (!next || next === providerSessionId) return;
    providerSessionId = next;
    publish({ kind: 'provider-session-id', providerSessionId: next });
  };
  const publishInputCustody = (
    pending: PendingSend,
    custody: 'accepted' | 'unknown' | 'rejected',
    code: string,
    message?: string | null,
  ): void => {
    if (pendingSend !== pending || pending.custody !== 'pending') return;
    pending.custody = custody;
    if (custody === 'accepted') {
      publish({
        kind: 'input-accepted',
        inputIds: pending.request.inputIds,
        delivery: pending.request.delivery,
      });
      for (const deferred of pending.deferredRuntimeEvents.drain()) {
        publish(deferred.input, deferred.emittedAtMs);
      }
      pending.deferredRuntimeEvents.dispose();
      return;
    }
    pending.deferredRuntimeEvents.dispose();
    if (custody === 'unknown') {
      publish({
        kind: 'input-custody-unknown',
        inputIds: pending.request.inputIds,
        issue: diagnostic(code, message),
      });
      return;
    }
    publish({
      kind: 'input-rejected',
      inputIds: pending.request.inputIds,
      diagnostic: diagnostic(code, message),
      retryable: true,
    });
  };
  const acquirePendingSend = (request: AgentSessionSendRequest): PendingSend | null => {
    if (pendingSend) return null;
    const pending: PendingSend = {
      request,
      custody: 'pending',
      providerInvocationStarted: false,
      deferredRuntimeEvents: createAgentSessionPreAdmissionBuffer(),
      deferredRuntimeEventFailure: null,
    };
    pendingSend = pending;
    return pending;
  };
  const unsubscribeOperations = params.operations.subscribeRuntimeEvents((event) => {
    if (event.kind === 'available-commands') {
      availableCommands = event.commands;
      publish({ kind: 'available-commands', commands: event.commands }, event.emittedAtMs);
      return;
    }
    if (event.kind === 'mode-catalog-observed') {
      const snapshot = params.operations.readModeCatalog();
      for (const listener of Array.from(modeListeners)) listener(snapshot);
      return;
    }
    if (event.kind === 'model-catalog-observed') {
      const snapshot = readModels();
      for (const listener of Array.from(modelListeners)) listener(snapshot);
      return;
    }
    const deferUntilCustody = pendingSend?.custody === 'pending' ? pendingSend : null;
    publishProviderIdentity();
    if (event.kind === 'turn-start') {
      active = true;
      activeTurnId = event.turnId;
    } else if (event.kind === 'turn-failed') {
      if (
        event.issue.code === 'opencode_prompt_submission_failed'
        || event.issue.code === 'opencode_prompt_identity_unresolved'
      ) {
        if (deferUntilCustody) {
          publishInputCustody(
            deferUntilCustody,
            'unknown',
            'opencode_input_custody_unknown',
            event.issue.sanitizedPreview,
          );
        }
      } else if (event.issue.code === 'opencode_runtime_startup_failed' || event.issue.code === 'opencode_prompt_rejected') {
        if (deferUntilCustody) {
          publishInputCustody(
            deferUntilCustody,
            'rejected',
            'opencode_input_rejected',
            event.issue.sanitizedPreview,
          );
        }
      }
    }
    if (
      event.kind === 'turn-complete'
      || event.kind === 'turn-failed'
      || event.kind === 'turn-cancelled'
    ) {
      if (event.kind === 'turn-complete') {
        latestCompletedTurnId = event.turnId;
      }
      if (activeTurnId === null || event.turnId === activeTurnId) {
        active = false;
        activeTurnId = null;
        for (const wake of Array.from(terminalWaiters)) wake();
      }
    }
    const mapped = mapRuntimeEvent(event);
    if (!mapped) return;
    if (deferUntilCustody) {
      const deferredRuntimeEvents = deferUntilCustody.deferredRuntimeEvents;
      if (pendingSend === deferUntilCustody && deferUntilCustody.custody === 'pending') {
        const admission = deferredRuntimeEvents.admit({
          input: mapped,
          emittedAtMs: event.emittedAtMs,
        });
        if (
          admission.status !== 'accepted'
          && deferUntilCustody.deferredRuntimeEventFailure === null
        ) {
          deferUntilCustody.deferredRuntimeEventFailure = admission;
          deferredRuntimeEvents.dispose();
        }
      }
      return;
    }
    publish(mapped, event.emittedAtMs);
  });

  const waitForCompletion = async (signal?: AbortSignal): Promise<void> => {
    while (active) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error('OpenCode send was aborted');
      }
      await params.operations.waitForTurnCompletion();
      if (active) {
        await waitForCompletionEventOrFallback(terminalWaiters, () => active, signal);
      }
    }
  };

  const send = async (
    request: AgentSessionSendRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => {
    if (disposed) {
      return {
        status: 'unavailable' as const,
        diagnostic: diagnostic(
          'opencode_runtime_disposed',
          'OpenCode runtime is disposed.',
        ),
        retryable: false,
      };
    }
    if (!request.input.text.trim() && request.input.structuredInput === undefined) {
      return {
        status: 'rejected' as const,
        diagnostic: diagnostic('opencode_input_missing_text'),
        retryable: false,
      };
    }
    let ownedPendingSend: PendingSend | null = null;
    try {
      const promptProjection = buildOpenCodePromptParts({
        text: request.input.text,
        structuredInput: request.input.structuredInput,
        ...(params.inputFiles ? { inputFiles: params.inputFiles } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const promptParts = Array.isArray(promptProjection)
        ? promptProjection
        : await promptProjection;
      if (request.delivery.kind === 'followUp') {
        await waitForCompletion(options?.signal);
        if (disposed) {
          return {
            status: 'unavailable' as const,
            diagnostic: diagnostic(
              'opencode_runtime_disposed',
              'OpenCode runtime was disposed before follow-up provider work began.',
            ),
            retryable: false,
          };
        }
      }
      ownedPendingSend = acquirePendingSend(request);
      if (!ownedPendingSend) {
        return {
          status: 'unavailable' as const,
          diagnostic: diagnostic(
            'opencode_input_submission_in_flight',
            'OpenCode is already submitting another input.',
          ),
          retryable: true,
        };
      }
      const meta = {
        localInputId: request.inputIds[0],
        localInputIds: request.inputIds,
        modelId: null,
        promptParts,
      };
      let providerUserMessageId: string | null;
      let effectivePromptModelId: string | null | undefined;
      let priorCompletedTurnId: string | null = null;
      if (request.delivery.kind === 'steer') {
        ownedPendingSend.providerInvocationStarted = true;
        ({ providerUserMessageId, effectiveModelId: effectivePromptModelId } =
          await params.operations.steerInFlightTurn(request.input.text, meta));
      } else {
        priorCompletedTurnId = latestCompletedTurnId;
        params.operations.beginTurnLifecycle(request.delivery.turnId);
        if (disposed) {
          return {
            status: 'unavailable' as const,
            diagnostic: diagnostic(
              'opencode_runtime_disposed',
              'OpenCode runtime was disposed before provider work began.',
            ),
            retryable: false,
          };
        }
        ownedPendingSend.providerInvocationStarted = true;
        ({ providerUserMessageId, effectiveModelId: effectivePromptModelId } =
          await params.operations.sendTurnPrompt(request.input.text, meta));
        if (priorCompletedTurnId && providerUserMessageId) {
          publish({
            kind: 'turn-rollback-boundary',
            turnId: priorCompletedTurnId,
            providerCheckpoint: {
              kind: 'opencode_exclusive_message_id',
              messageId: providerUserMessageId,
            },
          });
          if (latestCompletedTurnId === priorCompletedTurnId) {
            latestCompletedTurnId = null;
          }
        }
      }
      if (disposed) {
        return {
          status: 'unavailable' as const,
          diagnostic: diagnostic(
            ownedPendingSend.providerInvocationStarted
              ? 'opencode_input_custody_unknown'
              : 'opencode_runtime_disposed',
            ownedPendingSend.providerInvocationStarted
              ? 'OpenCode runtime was disposed while provider input custody was unresolved.'
              : 'OpenCode runtime is disposed.',
          ),
          retryable: false,
        };
      }
      publishEffectiveModel(effectivePromptModelId);
      publishProviderIdentity();
      if (disposed) {
        return {
          status: 'unavailable' as const,
          diagnostic: diagnostic(
            'opencode_input_custody_unknown',
            'OpenCode runtime was disposed while provider input custody was unresolved.',
          ),
          retryable: false,
        };
      }
      const preAdmissionFailure = ownedPendingSend.deferredRuntimeEventFailure;
      if (preAdmissionFailure) {
        let providerTurnCancellationPublicationFailed = false;
        try {
          await params.operations.cancelTurn();
        } catch {
          providerTurnCancellationPublicationFailed = true;
        }
        active = false;
        activeTurnId = null;
        publishInputCustody(
          ownedPendingSend,
          'unknown',
          'opencode_pre_admission_event_buffer_failed',
          `OpenCode pre-admission event buffering failed (${preAdmissionFailure.status}${
            preAdmissionFailure.status === 'overflow'
              ? `:${preAdmissionFailure.reason}`
              : ''
          }).${providerTurnCancellationPublicationFailed
            ? ' Exact provider turn state was reset, but cancellation publication failed.'
            : ''}`,
        );
        return {
          status: 'unavailable' as const,
          diagnostic: diagnostic(
            'opencode_pre_admission_event_buffer_failed',
            providerTurnCancellationPublicationFailed
              ? 'OpenCode pre-admission buffering failed after exact-turn cancellation publication also failed.'
              : null,
          ),
          retryable: false,
        };
      }
      publishInputCustody(ownedPendingSend, 'accepted', 'opencode_input_accepted');
      void waitForCompletion(options?.signal).catch(() => undefined);
      return { status: 'admitted' as const };
    } catch (error) {
      if (ownedPendingSend) {
        publishInputCustody(
          ownedPendingSend,
          'rejected',
          'opencode_input_rejected',
          error instanceof Error ? error.message : String(error),
        );
      }
      const custody = ownedPendingSend?.custody;
      return {
        status: custody === 'unknown' ? 'unavailable' as const : 'rejected' as const,
        diagnostic: diagnostic(
          custody === 'unknown'
            ? 'opencode_input_custody_unknown'
            : error instanceof OpenCodePromptProjectionError
              ? error.code
              : 'opencode_input_rejected',
          error instanceof Error ? error.message : String(error),
        ),
        retryable: error instanceof OpenCodePromptProjectionError
          ? false
          : custody !== 'unknown',
      };
    } finally {
      if (ownedPendingSend) {
        ownedPendingSend.deferredRuntimeEvents.dispose();
        if (pendingSend === ownedPendingSend) pendingSend = null;
      }
    }
  };

  const activeSkillsReaderBinding = params.bindActiveSkillsReader?.(
    params.request.sessionId,
    async () => normalizeOpenCodeSkills(await params.operations.listSkills()),
  ) ?? null;
  return {
    runtimeCapabilities: params.runtimeCapabilities,
    ...(params.prepareTerminalPresentation
      ? { prepareTerminalPresentation: params.prepareTerminalPresentation }
      : {}),
    send,
    async cancel(request) {
      if (!active || activeTurnId !== request.turnId) return { status: 'notRunning' };
      try {
        await params.operations.cancelTurn();
        return { status: 'requested', turnId: request.turnId };
      } catch (error) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'opencode_cancellation_unavailable',
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },
    async updateConfiguration(request) {
      if (request.permissionIntent.value !== launchPermissionIntent) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic(
            'opencode_permission_intent_update_requires_provider_restart',
            'OpenCode server mode applies permission intent when its process is launched.',
          ),
        };
      }
      try {
        const projection = projectOpenCodeSessionConfiguration(request);
        let deferred = false;
        for (const update of projection.updates) {
          if (await params.operations.updateSessionRuntimeConfig(update) === 'deferred') deferred = true;
        }
        if (!deferred) publishEffectiveModel(request.model.value);
        return {
          status: deferred ? 'deferred' : 'applied',
          changed: projection.changed,
        };
      } catch (error) {
        return {
          status: 'rejected',
          diagnostic: diagnostic(
            'opencode_configuration_rejected',
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },
    async compact(request) {
      if (request.instructions?.trim()) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic('opencode_compaction_instructions_unsupported'),
          retryable: false,
        };
      }
      try {
        await params.operations.compactContext({
          compactionId: request.compactionId,
        });
        return { status: 'admitted' };
      } catch (error) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'opencode_compaction_unavailable',
            error instanceof Error ? error.message : String(error),
          ),
          retryable: true,
        };
      }
    },
    watch(listener) {
      listeners.add(listener);
      publishProviderIdentity();
      if (availableCommands) publish({ kind: 'available-commands', commands: availableCommands });
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    isTurnInFlight: () => active,
    waitForTurnCompletion: () => waitForCompletion(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      const disposingPendingSend = pendingSend;
      if (
        disposingPendingSend?.custody === 'pending'
        && disposingPendingSend.providerInvocationStarted
      ) {
        publishInputCustody(
          disposingPendingSend,
          'unknown',
          'opencode_input_custody_unknown',
          'OpenCode runtime was disposed while provider input custody was unresolved.',
        );
      }
      activeSkillsReaderBinding?.dispose();
      unsubscribeOperations();
      listeners.clear();
      for (const wake of Array.from(terminalWaiters)) wake();
      terminalWaiters.clear();
      modelListeners.clear();
      modelsBinding?.dispose();
      modesBinding?.dispose();
      modeListeners.clear();
      active = false;
      activeTurnId = null;
      disposingPendingSend?.deferredRuntimeEvents.dispose();
      if (pendingSend === disposingPendingSend) pendingSend = null;
      await params.disposeOperations();
    },
  };
}
