import type {
  BundledRealtimeProviderRuntimeConfig,
  BundledRealtimeProviderRuntimeHost,
  BundledVoiceProviderMediaPort,
  BundledVoiceRuntimeContribution,
  VoiceAdapterController,
  VoiceConnectionCloseReason,
  VoiceRealtimeConnection,
  VoiceRealtimeProtocolAdapter,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  readVoiceProviderCredentialRemediationCode,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type { PluginVoiceProviderExecutionAuthority } from '@happier-dev/plugin-sdk/runtime';
import { createRealtimeBargeInCoordinator } from '@/voice/runtime/realtime/createRealtimeBargeInCoordinator';
import { isVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { markVoiceConversationAssistantTurnInterrupted } from '@/voice/transcript/voiceTurnInterruption';
import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';
import { normalizeVoiceRuntimeFailureCode } from '@/voice/runtime/voiceRuntimeFailureCode';

function readRequest(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : {};
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('voice_attempt_aborted'), { name: 'AbortError' });
}

const LEGACY_CREDENTIAL_SETUP_DECLINE_CODE = 'realtime_byo_not_configured';

function isCredentialSetupDeclineCode(code: string): boolean {
  return code === LEGACY_CREDENTIAL_SETUP_DECLINE_CODE
    || readVoiceProviderCredentialRemediationCode({ code }) !== null;
}

function readCredentialSetupDeclineCode(error: unknown): string | null {
  const remediationCode = readVoiceProviderCredentialRemediationCode(error);
  if (remediationCode) return remediationCode;
  const candidate = error as { code?: unknown } | null;
  return candidate?.code === LEGACY_CREDENTIAL_SETUP_DECLINE_CODE
    ? LEGACY_CREDENTIAL_SETUP_DECLINE_CODE
    : null;
}

function machineErrorKindForDecline(code: string): 'mic_permission_denied' | 'provider_auth_invalid' | 'provider_error' {
  if (code === 'mic_permission_denied') return 'mic_permission_denied';
  return isCredentialSetupDeclineCode(code) ? 'provider_auth_invalid' : 'provider_error';
}

type ActiveTranscriptAttempt = {
  controlSessionId: string;
  controllerAttemptId: number | null;
  conversationSessionId: string | null;
  epoch: number | null;
  lastSequence: number;
  sequenceOffsetBySource: Map<string, number>;
};

/**
 * Provider-neutral first-party realtime composition. Provider packages own wire
 * semantics and media drivers; this owner centralizes app machine, mic, binding,
 * transcript, tool, context, and teardown behavior.
 */
export function createBundledRealtimeProviderRuntime(
  host: BundledRealtimeProviderRuntimeHost,
  config: BundledRealtimeProviderRuntimeConfig,
): BundledVoiceRuntimeContribution {
  const providerId = config.providerId;
  let runtime: ReturnType<BundledRealtimeProviderRuntimeHost['createConversationController']> | null = null;
  type ResourceAttempt = {
    audioModeLease: Readonly<{ release(): Promise<void> }> | null;
    directMediaConversation: Readonly<{
      controlSessionId: string;
      conversationSessionId: string;
    }> | null;
    micRequested: boolean;
    preparePromise: Promise<void | Readonly<{ kind: 'declined'; code: string }>> | null;
    releasePromise: Promise<void> | null;
  };
  const resourceAttempts = new Map<number, ResourceAttempt>();
  let inputLevelWriter: ReturnType<BundledRealtimeProviderRuntimeHost['openLevelWriter']> | null = null;
  let outputLevelWriter: ReturnType<BundledRealtimeProviderRuntimeHost['openLevelWriter']> | null = null;
  let outputLevelSourceId: string | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let activeStartAttempt: object | null = null;
  let bargeInCoordinator: ReturnType<typeof createRealtimeBargeInCoordinator> | null = null;
  let activeTranscriptAttempt: ActiveTranscriptAttempt | null = null;
  let activeHostedLease: Readonly<{
    controlSessionId: string;
    expiresAtMs: number;
  }> | null = null;
  let hostedLeaseWarningTimer: ReturnType<typeof setTimeout> | null = null;
  let hostedLeaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHostedLeaseNotices = (): void => {
    if (hostedLeaseWarningTimer) clearTimeout(hostedLeaseWarningTimer);
    if (hostedLeaseExpiryTimer) clearTimeout(hostedLeaseExpiryTimer);
    hostedLeaseWarningTimer = null;
    hostedLeaseExpiryTimer = null;
  };
  const scheduleHostedLeaseNotices = (controlSessionId: string): void => {
    clearHostedLeaseNotices();
    const lease = activeHostedLease;
    if (!lease || lease.controlSessionId !== controlSessionId) return;
    const remainingMs = lease.expiresAtMs - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
    host.presentHostedLeaseNotice({
      controlSessionId,
      providerId,
      phase: 'started',
      remainingMs,
    });
    const warningDelayMs = remainingMs - 60_000;
    if (warningDelayMs <= 0) {
      host.presentHostedLeaseNotice({
        controlSessionId,
        providerId,
        phase: 'expiring',
        remainingMs,
      });
    } else {
      hostedLeaseWarningTimer = setTimeout(() => {
        host.presentHostedLeaseNotice({
          controlSessionId,
          providerId,
          phase: 'expiring',
          remainingMs: Math.max(0, lease.expiresAtMs - Date.now()),
        });
      }, warningDelayMs);
    }
    hostedLeaseExpiryTimer = setTimeout(() => {
      host.presentHostedLeaseNotice({
        controlSessionId,
        providerId,
        phase: 'expired',
        remainingMs: 0,
      });
    }, remainingMs);
  };
  const mic = host.createMicSession({
    onFailure(failure) {
      if (runtime?.getOwnedControlSessionId()) void runtime.fail(failure.kind);
    },
    onLevel(level: number) {
      inputLevelWriter?.write(level);
    },
  });
  const closeOutputLevelWriter = (): void => {
    const outputWriter = outputLevelWriter;
    outputLevelWriter = null;
    outputWriter?.close();
  };
  const closeLevelWriters = (): void => {
    const inputWriter = inputLevelWriter;
    inputLevelWriter = null;
    outputLevelSourceId = null;
    inputWriter?.close();
    closeOutputLevelWriter();
  };
  const protocol: VoiceRealtimeProtocolAdapter = Object.freeze({
    ...config.protocol,
    async prepare(input) {
      try {
        return await config.protocol.prepare(input);
      } catch (error) {
        const declineCode = readCredentialSetupDeclineCode(error);
        if (declineCode) return { kind: 'declined', code: declineCode };
        throw error;
      }
    },
  });

  const beginTranscriptProjection = (input: Readonly<{
    controlSessionId: string;
    attemptId: number;
  }>): void => {
    const transcriptAttempt = activeTranscriptAttempt;
    if (!transcriptAttempt || transcriptAttempt.controlSessionId !== input.controlSessionId) {
      throw new Error('voice_transcript_attempt_ownership_mismatch');
    }
    if (
      transcriptAttempt.controllerAttemptId !== null
      && input.attemptId < transcriptAttempt.controllerAttemptId
    ) {
      throw new Error('voice_transcript_attempt_ownership_mismatch');
    }
    const conversationSessionId = host.resolveConversationSessionId(
      input.controlSessionId,
      providerId,
    );
    if (!conversationSessionId) throw new Error('voice_transcript_conversation_unavailable');
    if (
      transcriptAttempt.controllerAttemptId === input.attemptId
      && transcriptAttempt.conversationSessionId === conversationSessionId
      && transcriptAttempt.epoch !== null
    ) {
      return;
    }
    const epoch = host.beginTranscriptAttempt({ conversationSessionId });
    if (epoch === null) throw new Error('voice_transcript_attempt_epoch_unavailable');
    transcriptAttempt.controllerAttemptId = input.attemptId;
    transcriptAttempt.conversationSessionId = conversationSessionId;
    transcriptAttempt.epoch = epoch;
  };

  const resources = Object.freeze({
    async preflight(input: Readonly<{
      controlSessionId: string; attemptId: number; request: VoiceRealtimeJsonValue; signal: AbortSignal;
    }>) {
      const request = readRequest(input.request);
      const target = typeof request.requestedTargetSessionId === 'string' && request.requestedTargetSessionId.trim()
        ? request.requestedTargetSessionId.trim()
        : null;
      if (config.execution.kind === 'direct_media') return;
      await host.ensureBound({
        adapterId: providerId,
        controlSessionId: input.controlSessionId,
        requestedTargetSessionId: target,
      });
      abortIfRequested(input.signal);
      beginTranscriptProjection(input);
    },
    async prepare(input: Readonly<{
      controlSessionId: string; attemptId: number; request: VoiceRealtimeJsonValue; signal: AbortSignal;
    }>) {
      if (config.execution.kind === 'direct_media') {
        const transcriptAttempt = activeTranscriptAttempt;
        if (
          !transcriptAttempt
          || transcriptAttempt.controlSessionId !== input.controlSessionId
          || (
            transcriptAttempt.controllerAttemptId !== null
            && input.attemptId < transcriptAttempt.controllerAttemptId
          )
        ) {
          throw new Error('voice_transcript_attempt_ownership_mismatch');
        }
      }
      const existingAttempt = resourceAttempts.get(input.attemptId);
      if (existingAttempt?.preparePromise) {
        return await existingAttempt.preparePromise;
      }
      const attempt: ResourceAttempt = existingAttempt ?? {
        audioModeLease: null,
        directMediaConversation: null,
        micRequested: false,
        preparePromise: null,
        releasePromise: null,
      };
      resourceAttempts.set(input.attemptId, attempt);
      const prepare = (async () => {
        if (config.execution.kind === 'direct_media') {
          const request = readRequest(input.request);
          const target = typeof request.requestedTargetSessionId === 'string'
            && request.requestedTargetSessionId.trim()
            ? request.requestedTargetSessionId.trim()
            : null;
          const acquired = await host.acquireDirectMediaConversation({
            adapterId: providerId,
            controlSessionId: input.controlSessionId,
            requestedTargetSessionId: target,
          });
          attempt.directMediaConversation = Object.freeze({
            controlSessionId: input.controlSessionId,
            conversationSessionId: acquired.conversationSessionId,
          });
          abortIfRequested(input.signal);
          beginTranscriptProjection(input);
        }
        if (config.requiresMicForConnection !== false) {
          host.machine.transitionToAcquiringMic(input.controlSessionId, providerId);
          attempt.micRequested = true;
          try {
            await mic.ensureActive();
          } catch (error) {
            if (isPermissionDeniedMicrophoneError(error)) {
              return { kind: 'declined' as const, code: 'mic_permission_denied' };
            }
            throw error;
          }
          abortIfRequested(input.signal);
        }
        attempt.audioModeLease = await host.acquireAudioMode(providerId);
        abortIfRequested(input.signal);
      })();
      attempt.preparePromise = prepare;
      return await prepare;
    },
    async release(input: Readonly<{ attemptId: number }>) {
      const attempt = resourceAttempts.get(input.attemptId);
      if (!attempt) return;
      if (attempt.releasePromise) {
        await attempt.releasePromise;
        return;
      }
      const hasNewerMicOwner = attempt.micRequested && [...resourceAttempts].some(
        ([attemptId, candidate]) => attemptId > input.attemptId && candidate.micRequested,
      );
      const teardownMic = attempt.micRequested && !hasNewerMicOwner
        ? mic.teardown().catch(() => {})
        : Promise.resolve();
      const release = (async () => {
        await attempt.preparePromise?.catch(() => {});
        await teardownMic;
        const audioModeLease = attempt.audioModeLease;
        attempt.audioModeLease = null;
        if (audioModeLease) {
          await audioModeLease.release();
        }
        const directMediaConversation = attempt.directMediaConversation;
        attempt.directMediaConversation = null;
        const hasNewerDirectMediaOwner = directMediaConversation && [...resourceAttempts].some(
          ([attemptId, candidate]) => (
            attemptId > input.attemptId
            && candidate.directMediaConversation?.controlSessionId
              === directMediaConversation.controlSessionId
            && candidate.directMediaConversation.conversationSessionId
              === directMediaConversation.conversationSessionId
          ),
        );
        if (directMediaConversation && !hasNewerDirectMediaOwner) {
          host.releaseDirectMediaConversation({
            adapterId: providerId,
            ...directMediaConversation,
          });
        }
        if (resourceAttempts.get(input.attemptId) === attempt) {
          resourceAttempts.delete(input.attemptId);
        }
      })();
      attempt.releasePromise = release;
      await release;
    },
  });

  runtime = host.createConversationController({
    adapter: protocol,
    machine: {
      connecting: ({ controlSessionId }: Readonly<{ controlSessionId: string }>) => host.machine.transitionToConnecting(controlSessionId, providerId),
      reconnecting: ({ controlSessionId, active }: Readonly<{ controlSessionId: string; active: boolean }>) => {
        if (active) bargeInCoordinator?.reset();
        host.machine.setReconnecting(controlSessionId, providerId, active);
      },
      connected: ({ controlSessionId }: Readonly<{ controlSessionId: string }>) => {
        host.machine.transitionToConnected(controlSessionId, providerId);
        scheduleHostedLeaseNotices(controlSessionId);
      },
      ending: ({ controlSessionId }: Readonly<{ controlSessionId: string }>) => host.machine.transitionToEnding(controlSessionId, providerId),
      disconnected: ({ controlSessionId, code }: Readonly<{ controlSessionId: string; code?: string }>) => {
        clearHostedLeaseNotices();
        activeHostedLease = null;
        bargeInCoordinator?.reset();
        closeLevelWriters();
        host.machine.transitionToDisconnected(
          controlSessionId,
          providerId,
          code ? host.createMachineError({ kind: machineErrorKindForDecline(code), reason: code }) : null,
        );
      },
      failed: ({ controlSessionId, code }: Readonly<{ controlSessionId: string; code: string }>) => {
        clearHostedLeaseNotices();
        activeHostedLease = null;
        bargeInCoordinator?.reset();
        closeLevelWriters();
        host.machine.setError(controlSessionId, providerId, host.createMachineError({
          kind: isVoiceMachineErrorKind(code) ? code : 'provider_error',
          reason: code,
        }));
      },
    },
    resources,
    createConnection: async (
      session: Readonly<{ config: VoiceRealtimeJsonValue; safeMetadata: VoiceRealtimeJsonValue }>,
      attemptId: number,
      signal: AbortSignal,
    ) => {
      abortIfRequested(signal);
      closeOutputLevelWriter();
      const attemptOutputWriter = config.outputLevelMeter === 'measured'
        ? host.openLevelWriter({
            channel: 'output',
            sourceId: `${outputLevelSourceId ?? providerId}:attempt-${attemptId}`,
          })
        : null;
      outputLevelWriter = attemptOutputWriter;
      let mediaFactoryOpen = true;
      let mediaConnection: VoiceRealtimeConnection | null = null;
      let executionLifetime: AbortController | null = null;
      const controlSessionId = runtime?.getOwnedControlSessionId();
      if (!controlSessionId) throw new Error('voice_execution_control_session_unavailable');
      const safeMetadata = session.safeMetadata && typeof session.safeMetadata === 'object'
        && !Array.isArray(session.safeMetadata)
        ? session.safeMetadata as Readonly<Record<string, VoiceRealtimeJsonValue>>
        : {};
      activeHostedLease = safeMetadata.billingMode === 'happier'
        && typeof safeMetadata.expiresAtMs === 'number'
        && Number.isFinite(safeMetadata.expiresAtMs)
        ? Object.freeze({ controlSessionId, expiresAtMs: safeMetadata.expiresAtMs })
        : null;
      let execution: PluginVoiceProviderExecutionAuthority;
      if (config.execution.kind === 'direct_media') {
        execution = Object.freeze({ kind: 'direct_media' as const });
      } else {
        const { provider, agent } = config.execution;
        execution = await (async () => {
          const lifetime = new AbortController();
          executionLifetime = lifetime;
          const abortLifetime = (): void => lifetime.abort();
          signal.addEventListener('abort', abortLifetime, { once: true });
          const service = await host.createAgentSessionRealtimeService?.({
            provider,
            agent,
            adapterId: providerId,
            controlSessionId,
            applicationAttemptId: `voice:${attemptId}`,
            signal: lifetime.signal,
            onTerminal(event) {
              if (signal.aborted || lifetime.signal.aborted) return;
              void runtime?.fail(
                event.diagnostic?.code ?? `agent_realtime_${event.reason}`,
              );
            },
          });
          if (!service) {
            signal.removeEventListener('abort', abortLifetime);
            lifetime.abort();
            throw new Error('voice_agent_realtime_execution_authority_unavailable');
          }
          return Object.freeze({
            kind: 'experimental_agent_session_realtime' as const,
            agentSessionRealtime: service,
          });
        })();
      }
      const readMediaConnection = (): VoiceRealtimeConnection | null => mediaConnection;
      const assertMediaConnectionAvailable = (): void => {
        abortIfRequested(signal);
        if (!mediaFactoryOpen) throw new Error('voice_media_factory_expired');
        if (mediaConnection) throw new Error('voice_media_connection_already_created');
      };
      const media = Object.freeze({
        createSdkHandleConnection(input: Parameters<typeof host.createSdkHandleConnection>[0]) {
          assertMediaConnectionAvailable();
          mediaConnection = host.createSdkHandleConnection(input);
          return mediaConnection;
        },
        createWebRtcConnection(input: Parameters<BundledVoiceProviderMediaPort['createWebRtcConnection']>[0]) {
          assertMediaConnectionAvailable();
          const micStream = mic.getStream();
          if (!micStream) throw new Error('voice_webrtc_mic_stream_unavailable');
          mediaConnection = host.createWebRtcConnection({
            signaling: input.signaling,
            control: input.control,
            micStream,
            duckGain: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.duckGain,
            ...(executionLifetime
              ? {
                  onClosed: (reason: VoiceConnectionCloseReason) => {
                    executionLifetime?.abort(reason);
                  },
                }
              : {}),
          });
          return mediaConnection;
        },
        createPcmConnection(input: Parameters<BundledVoiceProviderMediaPort['createPcmConnection']>[0]) {
          assertMediaConnectionAvailable();
          const pcmMedia = host.createWebSocketPcmMedia({
            mic,
            input: input.input,
            output: {
              ...input.output,
              retainedOutputMaxMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.retainedOutputMaxMs,
            },
            onInputChunk: input.onInputChunk,
            ...(input.onInputError ? { onInputError: input.onInputError } : {}),
            onOutputLevel: (level) => {
              if (outputLevelWriter === attemptOutputWriter) attemptOutputWriter?.write(level);
            },
          });
          const connection = host.createWebSocketPcmConnection({
            driver: input.driver,
            pcm: pcmMedia.pcm,
          });
          mediaConnection = connection;
          return Object.freeze({
            connection,
            enqueueOutput: pcmMedia.enqueueOutput,
            clearOutput: pcmMedia.clearOutput,
            waitForOutputDrain: pcmMedia.waitForOutputDrain,
          });
        },
      });
      try {
        const connection = await config.createConnection({
          controlSessionId,
          session,
          attemptId,
          mic,
          interruption: {
            duckGain: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.duckGain,
            retainedOutputMaxMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.retainedOutputMaxMs,
          },
          levels: {
            onOutputLevel: (level) => {
              if (outputLevelWriter === attemptOutputWriter) attemptOutputWriter?.write(level);
            },
          },
          media,
          signal,
          execution,
        });
        mediaFactoryOpen = false;
        abortIfRequested(signal);
        // SDK/native or text-only providers may own no host media. Once a
        // provider opts into this facade, its returned connection must match.
        if (mediaConnection && connection !== mediaConnection) {
          throw new Error('voice_media_connection_mismatch');
        }
        return connection;
      } catch (error) {
        mediaFactoryOpen = false;
        const createdMediaConnection = readMediaConnection();
        if (createdMediaConnection) {
          await createdMediaConnection.close({
            code: signal.aborted ? 'aborted' : 'error',
            detail: 'voice_connection_creation_failed',
          }).catch(() => {});
        }
        if (outputLevelWriter === attemptOutputWriter) outputLevelWriter = null;
        attemptOutputWriter?.close();
        throw error;
      } finally {
        mediaFactoryOpen = false;
      }
    },
    isSelectionCurrent: () => host.projectVoiceSettings(host.getSettings(), providerId)?.providerId === providerId,
    projectTranscript: ({ controlSessionId, attemptId, connectionId, event }) => {
      const transcriptAttempt = activeTranscriptAttempt;
      if (
        !transcriptAttempt
        || transcriptAttempt.controlSessionId !== controlSessionId
        || transcriptAttempt.controllerAttemptId !== attemptId
        || transcriptAttempt.conversationSessionId === null
        || transcriptAttempt.epoch === null
      ) {
        return;
      }
      const sourceKey = `${connectionId}:${event.epoch}`;
      let sequenceOffset = transcriptAttempt.sequenceOffsetBySource.get(sourceKey);
      if (sequenceOffset === undefined) {
        sequenceOffset = transcriptAttempt.lastSequence + 1 - event.sequence;
        transcriptAttempt.sequenceOffsetBySource.set(sourceKey, sequenceOffset);
      }
      const normalizedEvent = Object.freeze({
        ...event,
        epoch: transcriptAttempt.epoch,
        sequence: event.sequence + sequenceOffset,
      });
      transcriptAttempt.lastSequence = Math.max(
        transcriptAttempt.lastSequence,
        normalizedEvent.sequence,
      );
      const conversationSessionId = transcriptAttempt.conversationSessionId;
      const assistantEntryId = conversationSessionId
        ? host.projectTranscript({
            conversationSessionId,
            event: normalizedEvent,
            ...(config.providerSource ? { source: config.providerSource } : {}),
          })
        : null;
      const transcript = normalizedEvent as Readonly<{
        role?: unknown;
        type?: unknown;
        text?: unknown;
        itemId?: unknown;
      }>;
      if (
        (transcript.role === 'user' || transcript.role === 'assistant')
        && typeof transcript.type === 'string'
        && typeof transcript.text === 'string'
      ) {
        void bargeInCoordinator?.onTranscript({
          role: transcript.role,
          type: transcript.type,
          text: transcript.text,
          ...(typeof transcript.itemId === 'string' ? { itemId: transcript.itemId } : {}),
          ...(transcript.role === 'assistant' ? { assistantEntryId } : {}),
        }).catch(() => runtime?.fail('voice_interruption_failed'));
      }
    },
    onCanonicalEvent: async (event) => {
      if (event.type === 'assistant_output_started') {
        bargeInCoordinator?.onAssistantOutputStarted({ itemId: event.itemId });
      }
      if (event.type === 'assistant_output_stopped') {
        bargeInCoordinator?.onAssistantOutputStopped();
        outputLevelWriter?.reset();
      }
      if (event.type === 'input_speech_started') bargeInCoordinator?.onInputSpeechStarted();
      if (event.type === 'input_speech_stopped') bargeInCoordinator?.onInputSpeechStopped();
    },
    onConnectionReady: async ({ request, connection, signal }: Readonly<{
      request: VoiceRealtimeJsonValue;
      connection: VoiceRealtimeConnection;
      signal: AbortSignal;
    }>) => {
      const initialContext = readRequest(request).initialContext;
      if (typeof initialContext !== 'string' || !initialContext.trim()) return;
      for (const event of config.encodeContextUpdate(initialContext)) {
        abortIfRequested(signal);
        await connection.sendControl(event);
      }
    },
    createToolBarrier: () => host.createToolBarrier({
      resolveSessionId: (explicitSessionId) => explicitSessionId ?? (
        runtime?.getOwnedControlSessionId()
          ? host.resolveConversationSessionId(runtime.getOwnedControlSessionId()!, providerId)
          : null
      ),
      async submitResults(_responseId, results, signal) {
        for (const event of config.encodeToolResults(results)) {
          abortIfRequested(signal);
          const sent = await runtime!.sendClientControl(event);
          if (sent.status !== 'sent') throw new Error('voice_connection_not_open');
        }
      },
      async continueResponse(responseId, signal) {
        abortIfRequested(signal);
        await config.beforeToolContinuation?.(responseId, signal);
        abortIfRequested(signal);
        const sent = await runtime!.sendClientControl(config.encodeToolContinuation(responseId));
        if (sent.status !== 'sent') throw new Error('voice_connection_not_open');
      },
    }),
    sessionLifecycle: { connected: async () => {}, ended: async () => {} },
  });

  const projectAdapterSnapshot = (snapshot: unknown) => {
    const projected = host.machine.projectSnapshot(providerId, snapshot);
    const terminalCode = projected.errorCode === 'provider_error'
      && typeof projected.errorMessage === 'string'
      && projected.errorMessage.startsWith('voice_')
      ? normalizeVoiceRuntimeFailureCode(projected.errorMessage)
      : null;
    if (!terminalCode || terminalCode !== projected.errorMessage) return projected;
    return {
      ...projected,
      status: 'error' as const,
      errorCode: terminalCode,
      errorPresentation: 'error' as const,
    };
  };

  const unsubscribeMirror = host.createStorageMirror({
    adapterId: providerId,
    getSnapshot: host.machine.getSnapshot,
    subscribe: host.machine.subscribe,
    projectSnapshot(snapshot) {
      const projected = projectAdapterSnapshot(snapshot);
      return { status: projected.status, mode: projected.mode === 'speaking' ? 'speaking' : 'idle' };
    },
  });

  const sendEvents = async (events: readonly VoiceRealtimeJsonValue[]): Promise<void> => {
    for (const event of events) {
      const sent = await runtime!.sendClientControl(event);
      if (sent.status !== 'sent') throw new Error('voice_service_unavailable');
    }
  };

  const interruptActiveResponse = async (): Promise<void> => {
    let localFailure: unknown = null;
    try {
      await config.beforeInterrupt?.();
    } catch (error) {
      localFailure = error;
    }
    const cancelled = await runtime!.performTurnControl('cancel_response');
    if (cancelled.status === 'sent' && config.encodePostCancelControls) {
      await sendEvents(config.encodePostCancelControls());
    }
    if (localFailure) throw localFailure;
  };

  const encodePostBargeInControls = config.encodePostBargeInControls;
  bargeInCoordinator = createRealtimeBargeInCoordinator({
    beginOutputInterruptionCandidate: () => runtime!.beginOutputInterruptionCandidate(),
    resolveOutputInterruptionCandidate: (resolution) => runtime!.resolveOutputInterruptionCandidate(resolution),
    readPlaybackCursorMs: () => runtime!.playbackCursorMs(),
    onConfirmedInterruption: ({ controlSessionId, assistantEntryId }) => {
      const conversationSessionId = host.resolveConversationSessionId(controlSessionId, providerId);
      if (!conversationSessionId) return;
      markVoiceConversationAssistantTurnInterrupted({
        conversationSessionId,
        assistantEntryId,
      });
    },
    interrupt: interruptActiveResponse,
    ...(encodePostBargeInControls
      ? { continueAfterConfirmedSpeech: () => sendEvents(encodePostBargeInControls()) }
      : {}),
    onInterruptError: () => { void runtime?.fail('voice_interruption_failed'); },
    transitionToSpeaking: (controlSessionId) => host.machine.transitionToSpeaking(controlSessionId, providerId),
    transitionToConnected: (controlSessionId) => host.machine.transitionToConnected(controlSessionId, providerId),
    getControlSessionId: () => runtime!.getOwnedControlSessionId(),
    isBargeInEnabled: () => {
      const capabilities = config.resolveSurfaceCapabilities(host.getSettings());
      if (capabilities?.bargeInEnabled !== true) return false;
      return (capabilities.interruptionPolicy ?? 'client_two_stage') === 'client_two_stage';
    },
  });

  const start = async (input: Readonly<{ sessionId: string; initialContext?: string; textOnly?: boolean }>) => {
    const startAttempt = {};
    activeStartAttempt = startAttempt;
    const isStartAttemptCurrent = (): boolean => (
      !disposed && activeStartAttempt === startAttempt
    );
    const normalized = String(input.sessionId ?? '').trim();
    const controlSessionId = normalized || host.globalVoiceSessionId;
    const requestedTargetSessionId = controlSessionId === host.globalVoiceSessionId ? null : controlSessionId;
    if (requestedTargetSessionId) {
      try {
        await host.applyTargetSelection({
          controlSessionId,
          targetSessionId: requestedTargetSessionId,
          updateLastFocused: true,
        });
      } catch (error) {
        if (!isStartAttemptCurrent()) return;
        activeStartAttempt = null;
        throw error;
      }
      if (!isStartAttemptCurrent()) return;
    }
    const initialContext = input.initialContext ?? host.voiceHooks.onStarted(input.sessionId);
    host.clearAttemptStatus(controlSessionId);
    const transcriptAttempt: ActiveTranscriptAttempt = {
      controlSessionId,
      controllerAttemptId: null,
      conversationSessionId: null,
      epoch: null,
      lastSequence: 0,
      sequenceOffsetBySource: new Map(),
    };
    activeTranscriptAttempt = transcriptAttempt;
    closeLevelWriters();
    const levelSourceId = `${providerId}:${controlSessionId}`;
    outputLevelSourceId = levelSourceId;
    if (config.requiresMicForConnection !== false) {
      inputLevelWriter = host.openLevelWriter({ channel: 'input', sourceId: levelSourceId });
    }
    let result;
    try {
      result = await runtime!.start({
        controlSessionId,
        request: {
          ...(initialContext ? { initialContext } : {}),
          ...(requestedTargetSessionId ? { requestedTargetSessionId } : {}),
          textOnly: input.textOnly === true,
        },
      });
    } catch (error) {
      if (!isStartAttemptCurrent()) return;
      activeStartAttempt = null;
      if (activeTranscriptAttempt === transcriptAttempt) activeTranscriptAttempt = null;
      closeLevelWriters();
      await runtime!.stop().catch(() => {});
      host.voiceHooks.onStopped();
      throw error;
    }
    if (!isStartAttemptCurrent()) return;
    activeStartAttempt = null;
    if (result.status !== 'connected') {
      if (activeTranscriptAttempt === transcriptAttempt) activeTranscriptAttempt = null;
      closeLevelWriters();
      host.voiceHooks.onStopped();
      if (result.status === 'failed') {
        const code = normalizeVoiceRuntimeFailureCode(result.code);
        throw Object.assign(new Error(code), { code });
      }
    }
  };

  const stop = async (): Promise<void> => {
    const transcriptAttempt = activeTranscriptAttempt;
    activeStartAttempt = null;
    bargeInCoordinator?.reset();
    closeLevelWriters();
    await runtime!.stop();
    if (activeTranscriptAttempt !== transcriptAttempt) return;
    activeTranscriptAttempt = null;
    host.voiceHooks.onStopped();
  };

  const sendContextEvents = (events: readonly VoiceRealtimeJsonValue[]): void => {
    void sendEvents(events).catch(async () => {
      await runtime!.fail('voice_context_update_failed').catch(() => {});
    });
  };

  const adapter: VoiceAdapterController = Object.freeze({
    id: providerId,
    engineKind: 'realtime',
    conversationTargeting: config.execution.kind === 'experimental_agent_session_realtime'
      ? 'bound_conversation'
      : 'route_target',
    start,
    stop,
    async toggle(input) { if (runtime!.getActiveControlSessionId()) await stop(); else await start(input); },
    async interrupt() {
      await interruptActiveResponse();
    },
    async bargeIn() {
      await interruptActiveResponse();
    },
    async setMuted({ muted }) {
      mic.setMuted(muted);
      if (muted) inputLevelWriter?.reset();
      await config.setInputMuted?.(muted);
      host.machine.setMuted(muted);
    },
    sendContextUpdate({ update }) {
      if (runtime!.getActiveControlSessionId()) {
        sendContextEvents(config.encodeContextUpdate(update));
      }
    },
    sendContextText({ text }) {
      if (runtime!.getActiveControlSessionId()) {
        sendContextEvents(config.encodeTextTurn(text));
      }
    },
    async sendTextTurn({ controlSessionId, text }) {
      if (!runtime!.getActiveControlSessionId()) await start({ sessionId: controlSessionId, textOnly: true });
      await sendEvents(config.encodeTextTurn(text));
    },
    getSnapshot: () => projectAdapterSnapshot(host.machine.getSnapshot()),
    subscribe: host.machine.subscribe,
    ...(config.resolveConversationBinding
      ? { resolveConversationBinding: config.resolveConversationBinding }
      : {}),
    resolveSurfaceCapabilities(settings) {
      const capability = config.resolveSurfaceCapabilities(settings);
      if (!capability) return null;
      return Object.freeze({
        allowsGlobalStart: capability.allowsGlobalStart,
        controlSessionScope: capability.controlSessionScope,
        requiresVoiceAgentFeature: capability.requiresVoiceAgentFeature,
        bargeInEnabled: capability.bargeInEnabled,
        cancelResponse: config.protocol.turnControls.cancelResponse,
        ...(capability.interruptionPolicy !== undefined
          ? { interruptionPolicy: capability.interruptionPolicy }
          : {}),
        ...(config.execution.kind === 'experimental_agent_session_realtime'
          ? { agentRuntime: config.execution.agent }
          : {}),
      });
    },
    async performRuntimeAction(actionId) {
      const action = config.runtimeActions?.[actionId];
      if (!action) return { status: 'unsupported' };
      await action();
      return { status: 'completed' };
    },
    resolveContextChannel(settings) {
      if (!runtime!.getActiveControlSessionId() || !config.resolveSurfaceCapabilities(settings)) return null;
      return {
        sendContextualUpdate: (update) => { sendContextEvents(config.encodeContextUpdate(update)); },
        sendTextMessage: (text) => { sendContextEvents(config.encodeTextTurn(text)); },
      };
    },
  });

  return Object.freeze({
    adapter,
    dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        activeStartAttempt = null;
        clearHostedLeaseNotices();
        activeHostedLease = null;
        bargeInCoordinator?.reset();
        closeLevelWriters();
        await runtime?.stop().catch(() => {});
        activeTranscriptAttempt = null;
        unsubscribeMirror();
      })();
      return disposePromise;
    },
  });
}
