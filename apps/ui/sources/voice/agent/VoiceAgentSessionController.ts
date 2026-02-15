import { storage } from '@/sync/domains/state/storage';
import { buildVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { resolveDaemonVoiceAgentModelIds } from '@/voice/agent/resolveDaemonVoiceAgentModels';
import { DaemonVoiceAgentClient } from '@/voice/agent/daemonVoiceAgentClient';
import { OpenAiCompatVoiceAgentClient } from '@/voice/agent/openaiCompatVoiceAgentClient';
import type { VoiceAgentClient } from '@/voice/agent/types';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@/sync/runtime/rpcErrors';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { ensureVoiceCarrierSessionId, findVoiceCarrierSessionId } from '@/voice/agent/voiceCarrierSession';
import { buildVoiceAgentResumeContextFromCarrierSession } from '@/voice/persistence/buildVoiceAgentResumeContextFromCarrierSession';
import { readVoiceAgentRunMetadataFromCarrierSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { writeVoiceAgentRunMetadataToCarrierSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { sessionExecutionRunGet } from '@/sync/ops/sessionExecutionRuns';

type VoiceAgentHandle = { client: VoiceAgentClient; voiceAgentId: string; backend: 'daemon' | 'openai_compat'; rpcSessionId: string };

type SendTurnOptions = Readonly<{ onTextDelta?: (textDelta: string) => void | Promise<void> }>;

export type VoiceAgentSessionController = Readonly<{
  appendContextUpdate: (sessionId: string, update: string) => void;
  commit: (sessionId: string) => Promise<string>;
  isActive: (sessionId: string) => boolean;
  sendTurn: (
    sessionId: string,
    userText: string,
    options?: SendTurnOptions,
  ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
  stop: (sessionId: string) => Promise<void>;
}>;

export function createVoiceAgentSessionController(): VoiceAgentSessionController {
  const voiceAgentBySessionId = new Map<string, VoiceAgentHandle>();
  const voiceAgentPendingContextBySessionId = new Map<string, string[]>();
  const voiceAgentStreamUnsupportedBySessionId = new Set<string>();

  let openaiCompatVoiceAgentClient: OpenAiCompatVoiceAgentClient | null = null;
  let daemonVoiceAgentClient: DaemonVoiceAgentClient | null = null;

  const normalizeSessionId = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const resolveMostRecentSessionId = (): string | null => {
    const sessions: any = storage.getState().sessions ?? {};
    let best: { id: string; updatedAt: number } | null = null;
    for (const s of Object.values(sessions) as any[]) {
      if (!s || typeof s.id !== 'string') continue;
      const id = normalizeSessionId(s.id);
      if (!id) continue;
      const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
      if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && id < best.id)) {
        best = { id, updatedAt };
      }
    }
    return best?.id ?? null;
  };

  const resolveDaemonCarrierSessionId = (): string | null => {
    // Prefer a dedicated hidden/system carrier session when present.
    // This avoids coupling the global voice agent encryption context to a user-visible session.
    const sessionsAny: any = storage.getState().sessions ?? {};
    let bestSystem: { id: string; updatedAt: number } | null = null;
    for (const s of Object.values(sessionsAny) as any[]) {
      if (!s || typeof s.id !== 'string') continue;
      const id = normalizeSessionId(s.id);
      if (!id) continue;
      const meta = s.metadata ?? null;
      const sys = meta?.systemSessionV1 ?? null;
      if (!sys || sys.hidden !== true || String(sys.key ?? '') !== 'voice_carrier') continue;
      const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
      if (!bestSystem || updatedAt > bestSystem.updatedAt || (updatedAt === bestSystem.updatedAt && id < bestSystem.id)) {
        bestSystem = { id, updatedAt };
      }
    }
    if (bestSystem) return bestSystem.id;

    const store = useVoiceTargetStore.getState();
    const primary = normalizeSessionId(store.primaryActionSessionId);
    if (primary) return primary;
    const lastFocused = normalizeSessionId(store.lastFocusedSessionId);
    if (lastFocused) return lastFocused;
    return resolveMostRecentSessionId();
  };

  const getVoiceAgentHandle = async (sessionId: string): Promise<VoiceAgentHandle> => {
    const existing = voiceAgentBySessionId.get(sessionId);
    if (existing) return existing;

    const settings: any = storage.getState().settings;
    const voiceCfg = settings?.voice?.adapters?.local_conversation ?? null;
    const agentCfg = voiceCfg?.agent ?? null;
    const requestedBackend = (agentCfg?.backend ?? 'daemon') as 'daemon' | 'openai_compat';
    const permissionPolicy = (agentCfg?.permissionPolicy ?? 'read_only') as 'no_tools' | 'read_only';
    const idleTtlSeconds = Number(agentCfg?.idleTtlSeconds ?? 300);
    const verbosity = (agentCfg?.verbosity ?? 'short') as 'short' | 'balanced';
    const agentSource = (agentCfg?.agentSource ?? 'session') as 'session' | 'agent';
    const agentId = agentSource === 'agent' ? (agentCfg?.agentId ?? 'claude') : null;

    const transcriptCfg = agentCfg?.transcript ?? null;
    const transcriptPersistenceMode =
      transcriptCfg && (transcriptCfg as any).persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';
    const transcriptEpochRaw = transcriptCfg ? Number((transcriptCfg as any).epoch ?? 0) : 0;
    const transcriptEpoch =
      Number.isFinite(transcriptEpochRaw) && transcriptEpochRaw >= 0 ? Math.floor(transcriptEpochRaw) : 0;
    const transcript =
      transcriptPersistenceMode === 'persistent' || transcriptEpoch > 0
        ? ({ persistenceMode: transcriptPersistenceMode, epoch: transcriptEpoch } as const)
        : undefined;

    const resolveModelIds = (backend: 'daemon' | 'openai_compat', daemonSessionId: string) => {
      if (backend === 'openai_compat') {
        const openaiCompatCfg = agentCfg?.openaiCompat ?? null;
        const chatModelId = String(openaiCompatCfg?.chatModel ?? 'default');
        const commitModelId = String(openaiCompatCfg?.commitModel ?? chatModelId);
        return { chatModelId, commitModelId };
      }

      const session = storage.getState().sessions?.[daemonSessionId] ?? null;
      if (!session) {
        const chatModelId = String(agentCfg?.chatModelId ?? 'default');
        const commitModelId = String(agentCfg?.commitModelId ?? chatModelId);
        return { chatModelId, commitModelId };
      }

      return resolveDaemonVoiceAgentModelIds({
        session,
        agent: agentCfg ?? {},
      });
    };

    const baseInitialContext = buildVoiceInitialContext(sessionId);

    const shouldFallbackFromDaemon = (error: unknown) => {
      const err: any = error;
      if (isRpcMethodNotAvailableError(err)) return true;
      if (typeof err?.rpcErrorCode === 'string' && err.rpcErrorCode === 'VOICE_AGENT_UNSUPPORTED') return true;
      return false;
    };

    let backend: 'daemon' | 'openai_compat' = requestedBackend;
    const isGlobalVoiceAgent = sessionId === VOICE_AGENT_GLOBAL_SESSION_ID;
    let daemonCarrierSessionId = backend === 'daemon' && isGlobalVoiceAgent ? resolveDaemonCarrierSessionId() : null;

    if (backend === 'daemon' && isGlobalVoiceAgent && !findVoiceCarrierSessionId(storage.getState() as any)) {
      // Best-effort: create a dedicated hidden carrier session in the background so future global
      // voice agent turns do not depend on borrowing a user-visible session for encryption context.
      void ensureVoiceCarrierSessionId().catch(() => {});
    }

    if (backend === 'daemon' && isGlobalVoiceAgent && !daemonCarrierSessionId) {
      // If there are no sessions to borrow from, attempt to create the carrier synchronously.
      try {
        daemonCarrierSessionId = await ensureVoiceCarrierSessionId();
      } catch {
        // Fall back behavior is handled below.
      }
    }

    if (backend === 'daemon' && isGlobalVoiceAgent && !daemonCarrierSessionId) {
      // Daemon agent is session-scoped (requires a real session encryption context).
      // If no carrier session exists, only openai_compat can run.
      const baseUrl = String(agentCfg?.openaiCompat?.chatBaseUrl ?? '').trim();
      if (!baseUrl) {
        throw Object.assign(new Error('voice_agent_requires_session'), { code: 'VOICE_AGENT_REQUIRES_SESSION' });
      }
      backend = 'openai_compat';
    }

    const resumeContext =
      isGlobalVoiceAgent && transcriptPersistenceMode === 'persistent' && daemonCarrierSessionId
        ? await buildVoiceAgentResumeContextFromCarrierSession({
            carrierSessionId: daemonCarrierSessionId,
            epoch: transcriptEpoch,
          }).catch(() => '')
        : '';
    const effectiveInitialContext = resumeContext
      ? [baseInitialContext, resumeContext].filter(Boolean).join('\n\n')
      : baseInitialContext;

    let rpcSessionId = backend === 'daemon' ? (daemonCarrierSessionId ?? sessionId) : sessionId;
    let { chatModelId, commitModelId } = resolveModelIds(backend, rpcSessionId);

    const resolveDaemonAgentId = (daemonSessionId: string): string => {
      if (agentSource === 'agent') {
        const explicit = String(agentId ?? '').trim();
        return explicit.length > 0 ? explicit : DEFAULT_AGENT_ID;
      }
      const session = storage.getState().sessions?.[daemonSessionId] ?? null;
      return resolveAgentIdFromFlavor(session?.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    };
    const resolvedAgentId = backend === 'daemon' ? resolveDaemonAgentId(rpcSessionId) : String(agentId ?? '').trim();

    const persistedRunMeta =
      backend === 'daemon' && isGlobalVoiceAgent && transcriptPersistenceMode === 'persistent' && daemonCarrierSessionId
        ? readVoiceAgentRunMetadataFromCarrierSession({ carrierSessionId: daemonCarrierSessionId })
        : null;
    const existingRunId =
      persistedRunMeta && persistedRunMeta.backendId === resolvedAgentId ? persistedRunMeta.runId : null;
    const resumeHandle =
      persistedRunMeta && persistedRunMeta.backendId === resolvedAgentId ? persistedRunMeta.resumeHandle : null;
    const retentionPolicy =
      backend === 'daemon' && transcriptPersistenceMode === 'persistent' ? 'resumable' : 'ephemeral';

    let client: VoiceAgentClient =
      backend === 'openai_compat'
        ? (openaiCompatVoiceAgentClient ?? (openaiCompatVoiceAgentClient = new OpenAiCompatVoiceAgentClient()))
        : (daemonVoiceAgentClient ?? (daemonVoiceAgentClient = new DaemonVoiceAgentClient()));

    const startArgsBase = {
      agentSource,
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      verbosity,
      permissionPolicy,
      idleTtlSeconds,
      initialContext: effectiveInitialContext,
      ...(transcript ? { transcript } : {}),
      ...(backend === 'daemon' ? { existingRunId, resumeHandle, retentionPolicy } : {}),
    };

      const started = await (async () => {
      try {
        return await client.start({
          sessionId: rpcSessionId,
          ...startArgsBase,
          chatModelId,
          commitModelId,
        });
      } catch (error) {
        if (requestedBackend !== 'daemon') throw error;
        if (!shouldFallbackFromDaemon(error)) throw error;

        const baseUrl = String(agentCfg?.openaiCompat?.chatBaseUrl ?? '').trim();
        if (!baseUrl) throw error;

        backend = 'openai_compat';
        rpcSessionId = sessionId;
        ({ chatModelId, commitModelId } = resolveModelIds(backend, sessionId));
        client = openaiCompatVoiceAgentClient ?? (openaiCompatVoiceAgentClient = new OpenAiCompatVoiceAgentClient());
        return await client.start({
          sessionId,
          ...startArgsBase,
          chatModelId,
          commitModelId,
        });
      }
    })();

    if (backend === 'daemon' && isGlobalVoiceAgent && transcriptPersistenceMode === 'persistent' && daemonCarrierSessionId) {
      try {
        const getRes: any = await sessionExecutionRunGet(rpcSessionId, { runId: started.voiceAgentId, includeStructured: false });
        const resumeHandle = getRes?.run?.resumeHandle ?? null;
        await writeVoiceAgentRunMetadataToCarrierSession({
          carrierSessionId: daemonCarrierSessionId,
          runId: started.voiceAgentId,
          backendId: resolvedAgentId,
          resumeHandle,
          updatedAtMs: Date.now(),
        });
      } catch {
        // best-effort; persistence should not block voice usage
      }
    }

    const handle: VoiceAgentHandle = { client, voiceAgentId: started.voiceAgentId, backend, rpcSessionId };
    voiceAgentBySessionId.set(sessionId, handle);
    return handle;
  };

  const sendTurnStreamed = async (
    sessionId: string,
    handle: VoiceAgentHandle,
    userText: string,
    options?: SendTurnOptions
  ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
    const resolveStreamReadConfig = () => {
      const settings: any = storage.getState().settings;
      const voiceCfg = settings?.voice?.adapters?.local_conversation ?? {};
      const streamingCfg = voiceCfg?.streaming ?? {};

      const defaults = voiceSettingsDefaults.adapters.local_conversation.streaming;
      const defaultTimeoutMs = voiceSettingsDefaults.adapters.local_conversation.networkTimeoutMs;

      const networkTimeoutMsRaw = voiceCfg?.networkTimeoutMs;
      const networkTimeoutMs =
        typeof networkTimeoutMsRaw === 'number' && Number.isFinite(networkTimeoutMsRaw) && networkTimeoutMsRaw > 0
          ? Math.max(1000, Math.min(60000, Math.floor(networkTimeoutMsRaw)))
          : defaultTimeoutMs;

      const pollIntervalMsRaw = streamingCfg?.turnReadPollIntervalMs;
      const pollIntervalMs =
        typeof pollIntervalMsRaw === 'number' && Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0
          ? Math.max(10, Math.min(500, Math.floor(pollIntervalMsRaw)))
          : defaults.turnReadPollIntervalMs;

      const maxEventsRaw = streamingCfg?.turnReadMaxEvents;
      const maxEvents =
        typeof maxEventsRaw === 'number' && Number.isFinite(maxEventsRaw) && maxEventsRaw > 0
          ? Math.max(1, Math.min(256, Math.floor(maxEventsRaw)))
          : defaults.turnReadMaxEvents;

      const streamTimeoutMsRaw = streamingCfg?.turnStreamTimeoutMs;
      const streamTimeoutMs =
        typeof streamTimeoutMsRaw === 'number' && Number.isFinite(streamTimeoutMsRaw) && streamTimeoutMsRaw > 0
          ? Math.max(1000, Math.min(60000, Math.floor(streamTimeoutMsRaw)))
          : networkTimeoutMs;

      return {
        pollIntervalMs,
        maxEvents,
        streamTimeoutMs,
      } as const;
    };

    const streamCfg = resolveStreamReadConfig();
    const started = await handle.client.startTurnStream({
      sessionId: handle.rpcSessionId,
      voiceAgentId: handle.voiceAgentId,
      userText,
    });

    try {
      let cursor = 0;
      let mergedDeltaText = '';
      let doneAssistantText: string | null = null;
      let doneActions: VoiceAssistantAction[] = [];
      const startedAtMs = Date.now();

      while (true) {
        const elapsedMs = Date.now() - startedAtMs;
        if (elapsedMs >= streamCfg.streamTimeoutMs) break;

        const read = await handle.client.readTurnStream({
          sessionId: handle.rpcSessionId,
          voiceAgentId: handle.voiceAgentId,
          streamId: started.streamId,
          cursor,
          maxEvents: streamCfg.maxEvents,
        });

        cursor = read.nextCursor;

        for (const event of read.events) {
          if (event.t === 'delta' && typeof event.textDelta === 'string') {
            await options?.onTextDelta?.(event.textDelta);
            mergedDeltaText += event.textDelta;
            continue;
          }
          if (event.t === 'done') {
            doneAssistantText = event.assistantText;
            doneActions = event.actions ?? [];
            continue;
          }
          if (event.t === 'error') {
            throw Object.assign(new Error(event.error || 'stream_failed'), {
              rpcErrorCode: event.errorCode,
            });
          }
        }

        if (read.done) {
          return { assistantText: (doneAssistantText ?? mergedDeltaText).trim(), actions: doneActions };
        }

        const remainingMs = streamCfg.streamTimeoutMs - (Date.now() - startedAtMs);
        if (remainingMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(streamCfg.pollIntervalMs, remainingMs)));
      }

      throw new Error('stream_timeout');
    } catch (error) {
      await handle.client
        .cancelTurnStream({
          sessionId: handle.rpcSessionId,
          voiceAgentId: handle.voiceAgentId,
          streamId: started.streamId,
        })
        .catch(() => {});
      throw error;
    }
  };

  const sendTurn = async (
    sessionId: string,
    userText: string,
    options?: SendTurnOptions,
  ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
    const isVoiceAgentNotFound = (error: unknown) => {
      const err: any = error;
      if (typeof err?.rpcErrorCode === 'string' && (err.rpcErrorCode === 'VOICE_AGENT_NOT_FOUND' || err.rpcErrorCode === 'execution_run_not_found' || err.rpcErrorCode === 'execution_run_stream_not_found')) return true;
      if (typeof err?.message === 'string' && (err.message.includes('VOICE_AGENT_NOT_FOUND') || err.message.includes('execution_run_not_found') || err.message.includes('execution_run_stream_not_found'))) return true;
      return false;
    };

    const isStreamMethodUnavailable = (error: unknown) => {
      const err: any = error;
      return isRpcMethodNotAvailableError(err) || isRpcMethodNotFoundError(err);
    };

    const sendWithHandle = async (nextUserText: string) => {
      const handle = await getVoiceAgentHandle(sessionId);
      const settings: any = storage.getState().settings;
      const streamingEnabled = settings?.voice?.adapters?.local_conversation?.streaming?.enabled === true;
      const streamUnsupported = voiceAgentStreamUnsupportedBySessionId.has(sessionId);

      if (streamingEnabled && !streamUnsupported) {
        try {
          return await sendTurnStreamed(sessionId, handle, nextUserText, options);
        } catch (error) {
          if (!isStreamMethodUnavailable(error)) throw error;
          voiceAgentStreamUnsupportedBySessionId.add(sessionId);
        }
      }

      const response = await handle.client.sendTurn({
        sessionId: handle.rpcSessionId,
        voiceAgentId: handle.voiceAgentId,
        userText: nextUserText,
      });
      return {
        assistantText: response.assistantText,
        actions: response.actions ?? [],
      };
    };

    const pendingContext = voiceAgentPendingContextBySessionId.get(sessionId) ?? [];
    let payloadText = userText;
    if (pendingContext.length > 0) {
      voiceAgentPendingContextBySessionId.delete(sessionId);
      payloadText = `Context updates since your last voice turn:\n\n${pendingContext.join('\n\n---\n\n')}\n\nUser said:\n${userText}`;
    }

    try {
      return await sendWithHandle(payloadText);
    } catch (error) {
      if (!isVoiceAgentNotFound(error)) throw error;
      voiceAgentBySessionId.delete(sessionId);
      voiceAgentStreamUnsupportedBySessionId.delete(sessionId);
      return await sendWithHandle(payloadText);
    }
  };

  const commit = async (sessionId: string): Promise<string> => {
    const isVoiceAgentNotFound = (error: unknown) => {
      const err: any = error;
      if (typeof err?.rpcErrorCode === 'string' && (err.rpcErrorCode === 'VOICE_AGENT_NOT_FOUND' || err.rpcErrorCode === 'execution_run_not_found' || err.rpcErrorCode === 'execution_run_stream_not_found')) return true;
      if (typeof err?.message === 'string' && (err.message.includes('VOICE_AGENT_NOT_FOUND') || err.message.includes('execution_run_not_found') || err.message.includes('execution_run_stream_not_found'))) return true;
      return false;
    };

    const commitWithHandle = async () => {
      const handle = await getVoiceAgentHandle(sessionId);
      const response = await handle.client.commit({
        sessionId: handle.rpcSessionId,
        voiceAgentId: handle.voiceAgentId,
        kind: 'session_instruction',
      });
      return response.commitText;
    };

    try {
      return await commitWithHandle();
    } catch (error) {
      if (!isVoiceAgentNotFound(error)) throw error;
      voiceAgentBySessionId.delete(sessionId);
      return await commitWithHandle();
    }
  };

  const stop = async (sessionId: string): Promise<void> => {
    const handle = voiceAgentBySessionId.get(sessionId);
    if (!handle) {
      voiceAgentStreamUnsupportedBySessionId.delete(sessionId);
      return;
    }

    voiceAgentBySessionId.delete(sessionId);
    voiceAgentPendingContextBySessionId.delete(sessionId);
    voiceAgentStreamUnsupportedBySessionId.delete(sessionId);

    try {
      await handle.client.stop({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId });
    } catch {
      // best-effort only
    }
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
    isActive: (sessionId: string) => voiceAgentBySessionId.has(sessionId),
    sendTurn,
    stop,
  };
}
