import { storage } from '@/sync/domains/state/storage';
import { DaemonVoiceAgentClient } from '@/voice/agent/daemonVoiceAgentClient';
import { OpenAiCompatVoiceAgentClient } from '@/voice/agent/openaiCompatVoiceAgentClient';
import { initializeVoiceAgentHandle } from '@/voice/agent/initializeVoiceAgentHandle';
import type { VoiceAgentHandle } from '@/voice/agent/types';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { resolveVoiceTurnStreamReadConfig } from '@/voice/agent/resolveVoiceTurnStreamReadConfig';
import {
  captureAssistantTextMessageBaseline,
  collectAssistantTextMessagesSinceBaseline,
} from '@/voice/runtime/waitForNextAssistantTextMessage';
import { mergeAbortSignals } from '@/voice/agent/voiceAgentAbort';
import {
  isVoiceAgentBusyError,
  isVoiceAgentNotFoundError,
  isVoiceAgentRpcMethodUnavailable,
} from '@/voice/agent/voiceAgentErrorGuards';
import { readVoiceAgentRunMetadataFromSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { sessionExecutionRunGet, sessionExecutionRunList, sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
  assertActiveDaemonTargetSession,
  clearVoiceAgentRunMetadata,
  clearStaleDaemonRunState,
  persistVoiceAgentRunMetadata,
  resolveBoundConversationSessionId,
  resolveVoiceRunMetadataSessionId,
} from '@/voice/agent/voiceAgentRunState';
import { streamVoiceAgentTurn } from '@/voice/agent/streamVoiceAgentTurn';
import { buildVoiceAgentTurnPayload } from '@/voice/agent/buildVoiceAgentTurnPayload';

type SendTurnOptions = Readonly<{ onTextDelta?: (textDelta: string) => void | Promise<void>; signal?: AbortSignal }>;

function resolveExecutionRunBackendId(run: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const backendIdRaw = typeof run?.backendId === 'string' ? run.backendId.trim() : '';
  if (backendIdRaw) return backendIdRaw;

  const backendTarget = run?.backendTarget as Record<string, unknown> | undefined;
  if (backendTarget?.kind === 'builtInAgent' && typeof backendTarget.agentId === 'string' && backendTarget.agentId.trim()) {
    return backendTarget.agentId.trim();
  }
  if (backendTarget?.kind === 'configuredAcpBackend' && typeof backendTarget.backendId === 'string' && backendTarget.backendId.trim()) {
    return backendTarget.backendId.trim();
  }

  const resumeHandle = run?.resumeHandle as Record<string, unknown> | undefined;
  const backendTargetFromHandle = resumeHandle?.backendTarget as Record<string, unknown> | undefined;
  if (backendTargetFromHandle?.kind === 'builtInAgent' && typeof backendTargetFromHandle.agentId === 'string' && backendTargetFromHandle.agentId.trim()) {
    return backendTargetFromHandle.agentId.trim();
  }
  if (backendTargetFromHandle?.kind === 'configuredAcpBackend' && typeof backendTargetFromHandle.backendId === 'string' && backendTargetFromHandle.backendId.trim()) {
    return backendTargetFromHandle.backendId.trim();
  }

  const backendIdFromHandle = typeof resumeHandle?.backendId === 'string' ? resumeHandle.backendId.trim() : '';
  return backendIdFromHandle || null;
}

function resolveExecutionRunBackendTarget(
  run: Readonly<Record<string, unknown>> | null | undefined,
): { kind: 'builtInAgent'; agentId: string } | { kind: 'configuredAcpBackend'; backendId: string } | null {
  const backendTarget = run?.backendTarget as Record<string, unknown> | undefined;
  if (backendTarget?.kind === 'builtInAgent' && typeof backendTarget.agentId === 'string' && backendTarget.agentId.trim()) {
    return { kind: 'builtInAgent', agentId: backendTarget.agentId.trim() };
  }
  if (backendTarget?.kind === 'configuredAcpBackend' && typeof backendTarget.backendId === 'string' && backendTarget.backendId.trim()) {
    return { kind: 'configuredAcpBackend', backendId: backendTarget.backendId.trim() };
  }

  const resumeHandle = run?.resumeHandle as Record<string, unknown> | undefined;
  const targetFromHandle = resumeHandle?.backendTarget as Record<string, unknown> | undefined;
  if (targetFromHandle?.kind === 'builtInAgent' && typeof targetFromHandle.agentId === 'string' && targetFromHandle.agentId.trim()) {
    return { kind: 'builtInAgent', agentId: targetFromHandle.agentId.trim() };
  }
  if (targetFromHandle?.kind === 'configuredAcpBackend' && typeof targetFromHandle.backendId === 'string' && targetFromHandle.backendId.trim()) {
    return { kind: 'configuredAcpBackend', backendId: targetFromHandle.backendId.trim() };
  }

  const backendId = resolveExecutionRunBackendId(run);
  if (backendId) {
    return { kind: 'builtInAgent', agentId: backendId };
  }

  return null;
}

export type VoiceAgentSessionController = Readonly<{
  appendContextUpdate: (sessionId: string, update: string) => void;
  commit: (sessionId: string) => Promise<string>;
  ensureRunning: (sessionId: string) => Promise<void>;
  ensureRunningAndMaybeWelcome: (sessionId: string) => Promise<string | null>;
  isActive: (sessionId: string) => boolean;
  sendInterruptingTextUpdate: (
    sessionId: string,
    update: string,
    options?: SendTurnOptions,
  ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
  sendTextUpdate: (
    sessionId: string,
    update: string,
  ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
  sendTurn: (
    sessionId: string,
    userText: string,
    options?: SendTurnOptions,
  ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
  stop: (sessionId: string) => Promise<void>;
}>;

export function createVoiceAgentSessionController(): VoiceAgentSessionController {
  const voiceAgentBySessionId = new Map<string, VoiceAgentHandle>();
  const voiceAgentInitBySessionId = new Map<string, Promise<VoiceAgentHandle>>();
  const voiceAgentPendingContextBySessionId = new Map<string, string[]>();
  const voiceAgentTurnBarrierBySessionId = new Map<string, Promise<void>>();
  const voiceAgentTurnAbortControllerBySessionId = new Map<string, AbortController>();
  const voiceAgentWelcomeEpochBySessionId = new Map<string, number>();

  let openaiCompatVoiceAgentClient: OpenAiCompatVoiceAgentClient | null = null;
  let daemonVoiceAgentClient: DaemonVoiceAgentClient | null = null;

  const runSerializedTurn = async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previousBarrier = voiceAgentTurnBarrierBySessionId.get(sessionId) ?? Promise.resolve();
    const taskPromise = previousBarrier.catch(() => undefined).then(task);
    const nextBarrier = taskPromise.then(() => undefined, () => undefined);
    voiceAgentTurnBarrierBySessionId.set(sessionId, nextBarrier);

    try {
      return await taskPromise;
    } finally {
      if (voiceAgentTurnBarrierBySessionId.get(sessionId) === nextBarrier) {
        voiceAgentTurnBarrierBySessionId.delete(sessionId);
      }
    }
  };

  const interruptActiveTurn = (sessionId: string): void => {
    const controller = voiceAgentTurnAbortControllerBySessionId.get(sessionId);
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  };

  const initVoiceAgentHandle = async (sessionId: string): Promise<VoiceAgentHandle> =>
    initializeVoiceAgentHandle({
      sessionId,
      getDaemonVoiceAgentClient: () => {
        daemonVoiceAgentClient ??= new DaemonVoiceAgentClient();
        return daemonVoiceAgentClient;
      },
      getOpenAiCompatVoiceAgentClient: () => {
        openaiCompatVoiceAgentClient ??= new OpenAiCompatVoiceAgentClient();
        return openaiCompatVoiceAgentClient;
      },
      enqueuePendingContextUpdate: (pendingSessionId, update) => {
        const existingPendingContext = voiceAgentPendingContextBySessionId.get(pendingSessionId) ?? [];
        existingPendingContext.push(update);
        voiceAgentPendingContextBySessionId.set(
          pendingSessionId,
          existingPendingContext.slice(Math.max(0, existingPendingContext.length - 8)),
        );
      },
    });

  const getVoiceAgentHandle = async (sessionId: string): Promise<VoiceAgentHandle> => {
    const existing = voiceAgentBySessionId.get(sessionId);
    if (existing) return existing;
    const pending = voiceAgentInitBySessionId.get(sessionId);
    if (pending) return await pending;

    const init = initVoiceAgentHandle(sessionId);
    voiceAgentInitBySessionId.set(sessionId, init);
    try {
      const handle = await init;
      voiceAgentBySessionId.set(sessionId, handle);
      return handle;
    } finally {
      voiceAgentInitBySessionId.delete(sessionId);
    }
  };

  const sendTurnImpl = async (
    sessionId: string,
    userText: string,
    options?: SendTurnOptions,
  ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
    let lastHandle: VoiceAgentHandle | null = null;
    let preparedPayloadText: string | null = null;
    const preparePayloadText = (): string => {
      if (preparedPayloadText !== null) return preparedPayloadText;

      const pendingContext = voiceAgentPendingContextBySessionId.get(sessionId) ?? [];
      let nextPayloadText = userText;
      if (pendingContext.length > 0) {
        voiceAgentPendingContextBySessionId.delete(sessionId);
      }
      const payload = buildVoiceAgentTurnPayload({
        sessionId,
        userText: nextPayloadText,
        pendingContext,
        lastWelcomedEpoch: voiceAgentWelcomeEpochBySessionId.get(sessionId),
      });
      if (payload.nextWelcomedEpoch !== null) {
        voiceAgentWelcomeEpochBySessionId.set(sessionId, payload.nextWelcomedEpoch);
      }
      preparedPayloadText = payload.payloadText;
      return preparedPayloadText;
    };
    const sendWithHandle = async (displayUserText: string) => {
      const handle = await getVoiceAgentHandle(sessionId);
      lastHandle = handle;
      const nextUserText = preparePayloadText();
      const transcriptBaseline = captureAssistantTextMessageBaseline(handle.rpcSessionId);
      const settings: any = storage.getState().settings;
      const streamingEnabled = settings?.voice?.adapters?.local_conversation?.streaming?.enabled === true;

      const response = streamingEnabled
        ? await streamVoiceAgentTurn({ sessionId, handle, userText: nextUserText, displayUserText, options })
        : await handle.client.sendTurn({
            sessionId: handle.rpcSessionId,
            voiceAgentId: handle.voiceAgentId,
            userText: nextUserText,
            displayUserText,
          });
      const normalizedResponse = {
        assistantText: response.assistantText,
        actions: response.actions ?? [],
      };
      if (
        normalizedResponse.assistantText.trim().length === 0 &&
        ((storage.getState() as any).settings?.voice?.adapters?.local_conversation?.agent?.backend ?? 'daemon') === 'daemon'
      ) {
        const recoveredAssistantTexts = collectAssistantTextMessagesSinceBaseline(
          handle.rpcSessionId,
          transcriptBaseline.baselineIds,
          transcriptBaseline.baselineCount,
        );
        const recoveredAssistantText = recoveredAssistantTexts.at(-1)?.trim() ?? '';
        if (recoveredAssistantText) {
          return {
            assistantText: recoveredAssistantText,
            actions: normalizedResponse.actions,
          };
        }
      }
      return normalizedResponse;
    };

    try {
      return await sendWithHandle(userText);
    } catch (error) {
      if (isVoiceAgentBusyError(error)) {
        await stop(sessionId).catch(() => {});
        return await sendWithHandle(userText);
      }
      if (isVoiceAgentRpcMethodUnavailable(error)) {
        await clearStaleDaemonRunState(sessionId, lastHandle).catch(() => {});
        voiceAgentBySessionId.delete(sessionId);
        return await sendWithHandle(userText);
      }
      if (!isVoiceAgentNotFoundError(error)) throw error;
      voiceAgentBySessionId.delete(sessionId);
      return await sendWithHandle(userText);
    }
  };

  const sendTurn = async (
    sessionId: string,
    userText: string,
    options?: SendTurnOptions,
  ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> =>
    await runSerializedTurn(sessionId, async () => {
      const internalAbortController = new AbortController();
      voiceAgentTurnAbortControllerBySessionId.set(sessionId, internalAbortController);
      const mergedAbort = mergeAbortSignals([options?.signal, internalAbortController.signal]);
      try {
        return await sendTurnImpl(sessionId, userText, { ...options, signal: mergedAbort.signal });
      } finally {
        mergedAbort.dispose();
        if (voiceAgentTurnAbortControllerBySessionId.get(sessionId) === internalAbortController) {
          voiceAgentTurnAbortControllerBySessionId.delete(sessionId);
        }
      }
    });

  const sendInterruptingTextUpdate = async (
    sessionId: string,
    update: string,
    options?: SendTurnOptions,
  ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
    const text = update.trim();
    if (!text) {
      return { assistantText: '', actions: [] };
    }

    interruptActiveTurn(sessionId);
    return await sendTurn(sessionId, text, options);
  };

  const sendTextUpdate = async (
    sessionId: string,
    update: string,
  ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
    const text = update.trim();
    if (!text) {
      return { assistantText: '', actions: [] };
    }

    return await sendTurn(sessionId, text);
  };

  const commit = async (sessionId: string): Promise<string> => {
    const commitWithHandle = async () => {
      const handle = await getVoiceAgentHandle(sessionId);
      const response = await handle.client.commit({
        sessionId: handle.rpcSessionId,
        voiceAgentId: handle.voiceAgentId,
        kind: 'session_instruction',
      });

      const settings: any = storage.getState().settings;
      const agentCfg = settings?.voice?.adapters?.local_conversation?.agent ?? null;
      if (handle.backend === 'daemon') {
        const metadataSessionId = resolveVoiceRunMetadataSessionId(sessionId, handle.backend);
        if (metadataSessionId) {
          try {
            const getRes: any = await sessionExecutionRunGet(handle.rpcSessionId, { runId: handle.voiceAgentId, includeStructured: false });
            const resumeHandle = getRes?.run?.resumeHandle ?? null;
            const backendId = resolveExecutionRunBackendId(getRes?.run ?? null);
            const backendTarget = resolveExecutionRunBackendTarget(getRes?.run ?? null);
            if (backendId && backendTarget) {
              await persistVoiceAgentRunMetadata(metadataSessionId, {
                runId: handle.voiceAgentId,
                backendId,
                backendTarget,
                resumeHandle,
              });
            }
          } catch {
            // best-effort only
          }
        }
      }
      return response.commitText;
    };

    try {
      return await commitWithHandle();
    } catch (error) {
      if (!isVoiceAgentNotFoundError(error)) throw error;
      voiceAgentBySessionId.delete(sessionId);
      return await commitWithHandle();
    }
  };

  const stop = async (sessionId: string): Promise<void> => {
    const agentCfg = storage.getState().settings?.voice?.adapters?.local_conversation?.agent ?? null;
    const requestedBackend = (agentCfg?.backend ?? 'daemon') as 'daemon' | 'openai_compat';
    const metadataSessionId = resolveVoiceRunMetadataSessionId(sessionId, requestedBackend);
    const persistedRunMeta = metadataSessionId
      ? readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId })
      : null;
    const existingHandle = voiceAgentBySessionId.get(sessionId) ?? null;
    const pendingInit = voiceAgentInitBySessionId.get(sessionId) ?? null;
    // Prevent new callers from awaiting a stale init promise after stop is requested.
    voiceAgentInitBySessionId.delete(sessionId);

    const handle = existingHandle
      ? existingHandle
      : pendingInit
        ? await pendingInit.catch(() => null)
        : null;

    voiceAgentBySessionId.delete(sessionId);
    voiceAgentPendingContextBySessionId.delete(sessionId);
    voiceAgentTurnBarrierBySessionId.delete(sessionId);
    voiceAgentWelcomeEpochBySessionId.delete(sessionId);

    const fallbackRpcSessionId =
      sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        ? (metadataSessionId ?? sessionId)
        : sessionId;
    const daemonRpcSessionId = handle?.backend === 'daemon' ? handle.rpcSessionId : fallbackRpcSessionId;
    const daemonBackendId = normalizeNonEmptyString(
      handle?.backend === 'daemon'
        ? handle.agentBackendId
        : persistedRunMeta?.backendId ?? null,
    );

    if (handle) {
      try {
        await handle.client.stop({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId });
      } catch {
        // best-effort only
      }
    } else if (requestedBackend === 'daemon' && persistedRunMeta?.runId) {
      await sessionExecutionRunStop(fallbackRpcSessionId, { runId: persistedRunMeta.runId }).catch(() => {});
    }

    if (requestedBackend === 'daemon' && daemonBackendId) {
      const listed: any = await Promise.resolve(sessionExecutionRunList(daemonRpcSessionId, {})).catch(() => null);
      const runs = Array.isArray(listed?.runs) ? listed.runs : [];
      const matchingRunIds: string[] = Array.from(
        new Set(
          runs
            .filter((run: any) =>
              run
              && run.intent === 'voice_agent'
              && run.status === 'running'
              && typeof run.runId === 'string'
              && run.runId.trim().length > 0
              && resolveExecutionRunBackendId(run) === daemonBackendId,
            )
            .map((run: any) => String(run.runId).trim())
            .filter((runId: string) => runId.length > 0),
        ),
      );
      for (const runId of matchingRunIds) {
        await sessionExecutionRunStop(daemonRpcSessionId, { runId }).catch(() => {});
      }
    }

    await clearVoiceAgentRunMetadata(metadataSessionId).catch(() => {});
  };

  const appendContextUpdate = (sessionId: string, update: string): void => {
    const text = update.trim();
    if (!text) return;

    const existing = voiceAgentPendingContextBySessionId.get(sessionId) ?? [];
    existing.push(text);
    voiceAgentPendingContextBySessionId.set(sessionId, existing.slice(Math.max(0, existing.length - 8)));
  };

  return {
    appendContextUpdate,
    commit,
    ensureRunning: async (sessionId: string) => {
      await getVoiceAgentHandle(sessionId);
    },
    ensureRunningAndMaybeWelcome: async (sessionId: string) => {
      const settings: any = storage.getState().settings;
      const agentCfg = settings?.voice?.adapters?.local_conversation?.agent ?? null;
      const welcomeCfg = agentCfg?.welcome ?? null;
      const welcomeEnabled = welcomeCfg?.enabled === true;
      const welcomeMode = welcomeCfg?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
      if (!welcomeEnabled || welcomeMode !== 'immediate') {
        await getVoiceAgentHandle(sessionId);
        return null;
      }

      const epochRaw = Number(agentCfg?.transcript?.epoch ?? 0);
      const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
      const lastWelcomedEpoch = voiceAgentWelcomeEpochBySessionId.get(sessionId);
      if (lastWelcomedEpoch === epoch) {
        await getVoiceAgentHandle(sessionId);
        return null;
      }

      const handle = await getVoiceAgentHandle(sessionId);
      try {
        const res = await handle.client.welcome({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId });
        const assistantText = String(res?.assistantText ?? '').trim();
        if (!assistantText) return null;
        voiceAgentWelcomeEpochBySessionId.set(sessionId, epoch);
        return assistantText;
      } catch (error) {
        if (isVoiceAgentNotFoundError(error)) {
          voiceAgentBySessionId.delete(sessionId);
        }
        return null;
      }
    },
    isActive: (sessionId: string) => voiceAgentBySessionId.has(sessionId),
    sendInterruptingTextUpdate,
    sendTextUpdate,
    sendTurn,
    stop,
  };
}
