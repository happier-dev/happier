import type {
  BundledAdmittedCanonicalTranscriptPersistenceEvent,
  BundledDirectMediaBindingOwnership,
  BundledRealtimeProviderRuntimeConfig,
  BundledRealtimeProviderRuntimeHost,
  BundledRetiringDirectMediaTranscriptDrain,
  BundledVoiceProviderMediaPort,
} from './bundledConversationRuntimeContract';
import {
  readVoiceProviderCredentialRemediationCode,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
  VoiceProviderExecutionAuthority,
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';
import {
  createVoiceTextTurnRejectedBeforeEffectError,
  type BundledVoiceRuntimeContribution,
  type VoiceAdapterController,
  type VoiceHostAuthoredContextScope,
} from '@/voice/session/types';
import type { VoiceConnectionCloseReason } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import { createRealtimeBargeInCoordinator } from '@/voice/runtime/realtime/createRealtimeBargeInCoordinator';
import { isVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { markVoiceConversationAssistantTurnInterrupted } from '@/voice/transcript/voiceTurnInterruption';
import { isCanonicalVoiceTranscriptPersistenceEvent } from '@/voice/transcript/voiceConversationTranscript';
import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  normalizeVoiceRuntimeFailureCode,
  readSafeVoiceRuntimeFailureCode,
  recordVoiceRuntimeFailure,
  type VoiceRuntimeFailureDiagnosticReason,
} from '@/voice/runtime/voiceRuntimeFailureCode';
import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';

function readRequest(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : {};
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('voice_attempt_aborted'), { name: 'AbortError' });
}

const PROVIDER_SETTINGS_SETUP_DECLINE_CODE = 'realtime_byo_not_configured';

function isCredentialSetupDeclineCode(code: string): boolean {
  return readVoiceProviderCredentialRemediationCode({ code }) !== null;
}

function readActionableSetupDeclineCode(error: unknown): string | null {
  const remediationCode = readVoiceProviderCredentialRemediationCode(error);
  if (remediationCode) return remediationCode;
  const candidate = error as { code?: unknown } | null;
  return candidate?.code === PROVIDER_SETTINGS_SETUP_DECLINE_CODE
    ? PROVIDER_SETTINGS_SETUP_DECLINE_CODE
    : null;
}

/**
 * Sole conversion from a typed runtime failure code to a machine-error kind,
 * shared by both machine ports.
 *
 * The decline and failure ports used to classify independently, so the very
 * same credential code produced `provider_auth_invalid` (terminal, "Review
 * credentials") when a provider declined and `provider_error` (recoverable,
 * "Retry") when it threw — two answers for one fact, and the throw variant
 * offered a retry that can never succeed.
 */
function machineErrorKindForFailureCode(code: string): VoiceMachineErrorKind {
  if (isVoiceMachineErrorKind(code)) return code;
  if (code === PROVIDER_SETTINGS_SETUP_DECLINE_CODE) return 'provider_setup_required';
  return isCredentialSetupDeclineCode(code) ? 'provider_auth_invalid' : 'provider_error';
}

type ActiveTranscriptAttempt = {
  controlSessionId: string;
  controllerAttemptId: number | null;
  conversationSessionId: string | null;
  epoch: number | null;
  attemptIdentity: string | null;
  lastSequence: number;
  sequenceOffsetBySource: Map<string, number>;
  stopPromise: Promise<void> | null;
};

type TypedTurnQueue = {
  tail: Promise<void>;
  abortController: AbortController;
};

function createTypedTurnQueue(): TypedTurnQueue {
  return {
    tail: Promise.resolve(),
    abortController: new AbortController(),
  };
}

async function waitForTypedTurnPredecessor(
  predecessor: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw createVoiceTextTurnRejectedBeforeEffectError(
      new Error('voice_transcript_attempt_ownership_mismatch'),
      'runtime_disposed_before_delivery',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createVoiceTextTurnRejectedBeforeEffectError(
        new Error('voice_transcript_attempt_ownership_mismatch'),
        'runtime_disposed_before_delivery',
      ));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void predecessor.then(
      () => {
        cleanup();
        resolve();
      },
      () => {
        cleanup();
        resolve();
      },
    );
  });
}

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
  const usesHostWebRtcMic = config.microphoneMode === 'host_webrtc';
  const usesHostPcmCapture = config.microphoneMode === 'host_pcm';
  const usesProviderManagedMic = config.microphoneMode === 'provider_managed';
  let runtime: ReturnType<BundledRealtimeProviderRuntimeHost['createConversationController']> | null = null;
  type ResourceAttempt = {
    audioModeLease: Readonly<{ release(): Promise<void> }> | null;
    directMediaConversation: Readonly<{
      controlSessionId: string;
      conversationSessionId: string;
      transcriptAttemptIdentity: string;
      targetSessionId: string | null;
      retiringTranscriptDrain: BundledRetiringDirectMediaTranscriptDrain | null;
      bindingOwnership: BundledDirectMediaBindingOwnership | null;
    }> | null;
    transcriptCarrierRebindPromise: Promise<void> | null;
    transcriptCarrierRebindDrain: BundledRetiringDirectMediaTranscriptDrain | null;
    micRequested: boolean;
    preparePromise: Promise<void | Readonly<{ kind: 'declined'; code: string }>> | null;
    releasePromise: Promise<void> | null;
  };
  const resourceAttempts = new Map<number, ResourceAttempt>();
  const directMediaReleaseByAttemptIdentity = new Map<string, Promise<void>>();
  let inputLevelWriter: ReturnType<BundledRealtimeProviderRuntimeHost['openLevelWriter']> | null = null;
  let outputLevelWriter: ReturnType<BundledRealtimeProviderRuntimeHost['openLevelWriter']> | null = null;
  let outputLevelSourceId: string | null = null;
  let disposed = false;
  const isCurrentGeneration = (): boolean => host.isCurrentGeneration?.() !== false;
  let disposePromise: Promise<void> | null = null;
  let activeStartAttempt: object | null = null;
  /**
   * Whether a machine port already named the current start's outcome. It keeps
   * the unsettled-outcome record below from duplicating a decline or failure the
   * machine (and therefore the surface) already carries.
   */
  let startOutcomeNamed = false;
  const recordMachinePortFailure = (
    outcome: 'declined' | 'failed',
    kind: string,
    reason: string,
    diagnosticReason?: VoiceRuntimeFailureDiagnosticReason,
  ): void => {
    startOutcomeNamed = true;
    recordVoiceRuntimeFailure(providerId, outcome, kind, reason, diagnosticReason);
  };
  /**
   * Guards already recorded for the current Start, keyed by attempt and guard.
   *
   * A refused transcript event repeats for every later event of the same turn,
   * so the record is bounded to one line per guard per controller attempt and
   * reset by the next Start. It never carries transcript text.
   */
  const recordedTranscriptDrops = new Set<string>();
  const recordTranscriptDrop = (
    attemptId: number,
    kind: string,
    reason: string,
  ): void => {
    const key = `${attemptId}:${kind}`;
    if (recordedTranscriptDrops.has(key)) return;
    recordedTranscriptDrops.add(key);
    recordVoiceRuntimeFailure(providerId, 'transcript_dropped', kind, reason);
  };
  let bargeInCoordinator: ReturnType<typeof createRealtimeBargeInCoordinator> | null = null;
  let activeTranscriptAttempt: ActiveTranscriptAttempt | null = null;
  let activeTypedTurnAcceptanceBarrier: Promise<void> | null = null;
  const pendingAdmittedPersistenceCustodyByAttemptIdentity = new Map<
    string,
    Set<Promise<void>>
  >();
  const trackAdmittedPersistenceCustody = (
    attemptIdentity: string,
    custody: Promise<void>,
  ): void => {
    let pending = pendingAdmittedPersistenceCustodyByAttemptIdentity.get(attemptIdentity);
    if (!pending) {
      pending = new Set();
      pendingAdmittedPersistenceCustodyByAttemptIdentity.set(attemptIdentity, pending);
    }
    pending.add(custody);
    const forget = (): void => {
      if (!pending?.delete(custody)) return;
      if (
        pending.size === 0
        && pendingAdmittedPersistenceCustodyByAttemptIdentity.get(attemptIdentity) === pending
      ) {
        pendingAdmittedPersistenceCustodyByAttemptIdentity.delete(attemptIdentity);
      }
    };
    void custody.then(forget, forget);
  };
  const settleAdmittedPersistenceCustody = async (attemptIdentity: string): Promise<void> => {
    for (;;) {
      const pending = pendingAdmittedPersistenceCustodyByAttemptIdentity.get(attemptIdentity);
      if (!pending || pending.size === 0) return;
      await Promise.allSettled([...pending]);
      if (
        pendingAdmittedPersistenceCustodyByAttemptIdentity.get(attemptIdentity) === pending
        && pending.size === 0
      ) {
        return;
      }
    }
  };
  let typedTurnQueue = createTypedTurnQueue();
  const retireTypedTurnQueue = (): void => {
    typedTurnQueue.abortController.abort();
    typedTurnQueue = createTypedTurnQueue();
  };
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
        const declineCode = readActionableSetupDeclineCode(error);
        if (declineCode) return { kind: 'declined', code: declineCode };
        throw error;
      }
    },
  });

  const beginTranscriptProjection = (input: Readonly<{
    controlSessionId: string;
    attemptId: number;
  }>): Readonly<{
    conversationSessionId: string;
    epoch: number;
    attemptIdentity: string;
  }> => {
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
      && transcriptAttempt.attemptIdentity !== null
    ) {
      return Object.freeze({
        conversationSessionId,
        epoch: transcriptAttempt.epoch,
        attemptIdentity: transcriptAttempt.attemptIdentity,
      });
    }
    const attempt = host.beginTranscriptAttempt({ conversationSessionId });
    if (attempt === null) throw new Error('voice_transcript_attempt_epoch_unavailable');
    transcriptAttempt.controllerAttemptId = input.attemptId;
    transcriptAttempt.conversationSessionId = conversationSessionId;
    transcriptAttempt.epoch = attempt.epoch;
    transcriptAttempt.attemptIdentity = attempt.attemptIdentity;
    return Object.freeze({
      conversationSessionId,
      epoch: attempt.epoch,
      attemptIdentity: attempt.attemptIdentity,
    });
  };

  /**
   * Whether an attempt acquires the shared host mic session (rather than only
   * its permission). Web PCM capture reads the mic-owned `AudioContext`, so it
   * acquires too; native PCM capture leaves acquisition to its stream owner.
   */
  const acquiresHostMicSession = (): boolean => (
    usesHostWebRtcMic || (usesHostPcmCapture && host.getPlatform() === 'web')
  );
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
        transcriptCarrierRebindPromise: null,
        transcriptCarrierRebindDrain: null,
        micRequested: false,
        preparePromise: null,
        releasePromise: null,
      };
      resourceAttempts.set(input.attemptId, attempt);
      // Mic ownership is claimed synchronously, before preparation's first
      // await. Release must be able to invalidate this attempt's acquisition
      // without first joining a preparation that the invalidation is what
      // settles, so the claim cannot be written from inside that preparation.
      if (acquiresHostMicSession()) attempt.micRequested = true;
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
            transcriptAttemptIdentity: beginTranscriptProjection(input).attemptIdentity,
            targetSessionId: target,
            retiringTranscriptDrain: null,
            bindingOwnership: acquired.bindingOwnership ?? null,
          });
          abortIfRequested(input.signal);
        }
        if (usesHostWebRtcMic) {
          // Mute is attempt-scoped. A newly admitted attempt must not inherit a
          // disabled capture track from the provider attempt it replaces.
          mic.setMuted(false);
          host.machine.transitionToAcquiringMic(input.controlSessionId, providerId, input.attemptId);
          try {
            // Prompt, lease, THEN capture. The platform audio session is chosen
            // when the capture track is created — Android reads
            // `AudioManager.mode`, the communication route and AEC availability
            // at that moment — so opening the WebRTC track before the canonical
            // lease is held leaves the whole call on the media route without
            // echo cancellation. Permission prompting is deliberately split out
            // so an unanswered prompt does not hold the exclusive lease.
            await mic.ensurePermission?.();
            abortIfRequested(input.signal);
            attempt.audioModeLease = await host.acquireAudioMode(providerId);
            abortIfRequested(input.signal);
            await mic.ensureActive();
          } catch (error) {
            if (isPermissionDeniedMicrophoneError(error)) {
              return { kind: 'declined' as const, code: 'mic_permission_denied' };
            }
            throw error;
          }
          abortIfRequested(input.signal);
        }
        if (usesHostPcmCapture) {
          // Web PCM capture starts inside the connection's media rather than in
          // a separate acquisition phase, so the machine stays on
          // connecting -> connected there. Native keeps its own mic phase.
          if (host.getPlatform() !== 'web') {
            host.machine.transitionToAcquiringMic(input.controlSessionId, providerId, input.attemptId);
          }
          try {
            if (host.getPlatform() === 'web') {
              // Web PCM capture reads the mic-owned AudioContext, which only
              // exists once the mic session has been acquired. Permission alone
              // would leave `getAudioContext()` null and fail media start.
              await mic.ensureActive();
            } else {
              if (!mic.ensurePermission) {
                throw Object.assign(new Error('voice_pcm_capture_permission_unavailable'), {
                  code: 'voice_pcm_capture_permission_unavailable',
                });
              }
              await mic.ensurePermission();
            }
          } catch (error) {
            if (isPermissionDeniedMicrophoneError(error)) {
              return { kind: 'declined' as const, code: 'mic_permission_denied' };
            }
            throw error;
          }
          abortIfRequested(input.signal);
        }
        // Native host-PCM capture acquires the existing coordinator lease at
        // its stream owner. Taking the provider-managed exclusive lease here
        // would create a competing capture authority before PCM starts.
        // `host_webrtc` already took the lease above, ahead of its capture track.
        if (!usesHostWebRtcMic && (!usesHostPcmCapture || host.getPlatform() === 'web')) {
          attempt.audioModeLease = await host.acquireAudioMode(providerId);
        }
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
      const releaseAttemptMic = async (): Promise<void> => {
        const hasNewerMicOwner = [...resourceAttempts].some(
          ([attemptId, candidate]) => attemptId > input.attemptId && candidate.micRequested,
        );
        if (!attempt.micRequested || hasNewerMicOwner) return;
        // A terminal attempt releases its physical mute together with the
        // capture resource. Do not reset a newer attempt sharing this
        // host-owned mic session: its prepare path already established the
        // new attempt's unmuted baseline and may have received a new mute.
        mic.setMuted(false);
        await mic.teardown().catch(() => {});
      };
      const release = (async () => {
        // Teardown precedes the preparation join. Teardown is what invalidates
        // an unsettled acquisition, so joining first makes Stop wait for a
        // `getUserMedia` that only this teardown can release.
        await releaseAttemptMic();
        await attempt.preparePromise?.catch(() => {});
        await attempt.transcriptCarrierRebindPromise?.catch(() => {});
        const audioModeLease = attempt.audioModeLease;
        attempt.audioModeLease = null;
        const directMediaConversation = attempt.directMediaConversation;
        attempt.directMediaConversation = null;
        if (directMediaConversation) {
          // A final admitted before a typed-turn acceptance barrier may still
          // be waiting to enter the existing exact-attempt persistence tail.
          // Stop keeps that one custody task ahead of release so the canonical
          // release below joins its ACK rather than racing an unowned write.
          await settleAdmittedPersistenceCustody(
            directMediaConversation.transcriptAttemptIdentity,
          );
          // End Voice has already fenced provider input and released live media
          // before reaching this point. Transcript persistence is an outbound
          // durability drain and may remain pending through a network timeout;
          // it must not retain the ending machine state or the capture lease.
          // The adapter-level stop still awaits this exact attempt below so its
          // public settlement retains the admitted-write durability contract.
          const transcriptRelease = (async () => {
            await host.releaseDirectMediaConversation({
              adapterId: providerId,
              controlSessionId: directMediaConversation.controlSessionId,
              conversationSessionId: directMediaConversation.conversationSessionId,
              transcriptAttemptIdentity:
                directMediaConversation.transcriptAttemptIdentity,
              ...(directMediaConversation.retiringTranscriptDrain
                ? { retiringTranscriptDrain: directMediaConversation.retiringTranscriptDrain }
                : {}),
              ...(directMediaConversation.bindingOwnership
                ? { bindingOwnership: directMediaConversation.bindingOwnership }
                : {}),
            });
          })();
          directMediaReleaseByAttemptIdentity.set(
            directMediaConversation.transcriptAttemptIdentity,
            transcriptRelease,
          );
          fireAndForget(transcriptRelease, {
            tag: 'BundledRealtimeProviderRuntime.releaseDirectMediaConversation',
          });
          const forgetTranscriptRelease = (): void => {
            if (
              directMediaReleaseByAttemptIdentity.get(
                directMediaConversation.transcriptAttemptIdentity,
              ) === transcriptRelease
            ) {
              directMediaReleaseByAttemptIdentity.delete(
                directMediaConversation.transcriptAttemptIdentity,
              );
            }
          };
          void transcriptRelease.then(forgetTranscriptRelease, forgetTranscriptRelease);
        }
        try {
          await audioModeLease?.release();
        } finally {
          if (resourceAttempts.get(input.attemptId) === attempt) {
            resourceAttempts.delete(input.attemptId);
          }
        }
      })();
      attempt.releasePromise = release;
      await release;
    },
  });

  runtime = host.createConversationController({
    adapter: protocol,
    machine: {
      connecting: ({ controlSessionId, attemptId }: Readonly<{ controlSessionId: string; attemptId: number }>) =>
        host.machine.transitionToConnecting(controlSessionId, providerId, attemptId),
      reconnecting: ({ controlSessionId, attemptId, active }: Readonly<{
        controlSessionId: string; attemptId: number; active: boolean;
      }>) => {
        if (active) {
          bargeInCoordinator?.reset();
        }
        host.machine.setReconnecting(controlSessionId, providerId, active, attemptId);
      },
      connected: ({ controlSessionId, attemptId }: Readonly<{ controlSessionId: string; attemptId: number }>) => {
        host.machine.transitionToConnected(controlSessionId, providerId, attemptId);
        scheduleHostedLeaseNotices(controlSessionId);
      },
      ending: ({ controlSessionId, attemptId }: Readonly<{ controlSessionId: string; attemptId: number }>) =>
        host.machine.transitionToEnding(controlSessionId, providerId, attemptId),
      disconnected: ({ controlSessionId, attemptId, code }: Readonly<{
        controlSessionId: string; attemptId: number; code?: string;
      }>) => {
        clearHostedLeaseNotices();
        activeHostedLease = null;
        bargeInCoordinator?.reset();
        closeLevelWriters();
        let declineError: ReturnType<typeof host.createMachineError> | null = null;
        if (code) {
          const kind = machineErrorKindForFailureCode(code);
          recordMachinePortFailure('declined', kind, code);
          declineError = host.createMachineError({ kind, reason: code });
        }
        host.machine.transitionToDisconnected(controlSessionId, providerId, declineError, attemptId);
      },
      failed: ({ controlSessionId, attemptId, code, diagnosticReason }: Readonly<{
        controlSessionId: string;
        attemptId: number;
        code: string;
        diagnosticReason?: VoiceRuntimeFailureDiagnosticReason;
      }>) => {
        clearHostedLeaseNotices();
        activeHostedLease = null;
        bargeInCoordinator?.reset();
        closeLevelWriters();
        const kind = machineErrorKindForFailureCode(code);
        recordMachinePortFailure('failed', kind, code, diagnosticReason);
        host.machine.setError(
          controlSessionId,
          providerId,
          host.createMachineError({ kind, reason: code }),
          attemptId,
        );
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
      let execution: VoiceProviderExecutionAuthority;
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
          if (!usesProviderManagedMic) {
            throw new Error('voice_provider_sdk_media_mode_required');
          }
          mediaConnection = host.createSdkHandleConnection(input);
          return mediaConnection;
        },
        createWebRtcConnection(input: Parameters<BundledVoiceProviderMediaPort['createWebRtcConnection']>[0]) {
          assertMediaConnectionAvailable();
          if (!usesHostWebRtcMic) {
            throw new Error('voice_webrtc_microphone_mode_required');
          }
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
          if (!usesHostPcmCapture) {
            throw new Error('voice_pcm_microphone_mode_required');
          }
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
      if (disposed || !isCurrentGeneration()) {
        recordTranscriptDrop(
          attemptId,
          disposed ? 'transcript_runtime_disposed' : 'transcript_generation_retired',
          'voice_transcript_attempt_ownership_mismatch',
        );
        return;
      }
      const transcriptAttempt = activeTranscriptAttempt;
      if (
        !transcriptAttempt
        || transcriptAttempt.controlSessionId !== controlSessionId
        || transcriptAttempt.controllerAttemptId !== attemptId
        || transcriptAttempt.conversationSessionId === null
        || transcriptAttempt.epoch === null
        || transcriptAttempt.attemptIdentity === null
      ) {
        recordTranscriptDrop(
          attemptId,
          'transcript_attempt_unowned',
          'voice_transcript_attempt_ownership_mismatch',
        );
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
      const projectEvent = (
        conversationSessionId: string,
        projectedEvent: typeof normalizedEvent,
        retiringTranscriptDrain: BundledRetiringDirectMediaTranscriptDrain | null,
      ): string | null => host.projectTranscript({
        conversationSessionId,
        event: projectedEvent,
        ...(config.providerSource ? { source: config.providerSource } : {}),
        ...(retiringTranscriptDrain ? { retiringTranscriptDrain } : {}),
      });
      const notifyProjectedTranscript = (
        conversationSessionId: string,
        projectedEvent: typeof normalizedEvent,
        attemptIdentity: string,
        assistantEntryId: string | null,
        retiringTranscriptDrain: BundledRetiringDirectMediaTranscriptDrain | null = null,
      ): void => {
        const transcript = projectedEvent as Readonly<{
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
          const role = transcript.role;
          const type = transcript.type;
          const text = transcript.text;
          const itemId = typeof transcript.itemId === 'string'
            ? transcript.itemId
            : null;
          const notifyTranscript = (): Promise<void> => bargeInCoordinator?.onTranscript({
            role,
            type,
            text,
            ...(itemId
              ? { itemId }
              : {}),
            ...(role === 'assistant' ? { assistantEntryId } : {}),
          }) ?? Promise.resolve();
          const failInterruptionIfCurrent = (): void => {
            host.runCurrentGenerationEffect(() => {
              void runtime?.fail('voice_interruption_failed');
            });
          };
          const notifyTranscriptIfCurrent = (): void => {
            // A rebind drain proves only that this final was admitted before
            // an await. It may still be current now, so the generation owner
            // atomically decides whether this may enter live barge-in state.
            host.runCurrentGenerationEffect(() => {
              void notifyTranscript().catch(failInterruptionIfCurrent);
            });
          };
          if (role === 'assistant' && assistantEntryId) {
            void host.settleTranscriptPersistence({
              conversationSessionId,
              attemptIdentity,
              ...(retiringTranscriptDrain ? { retiringTranscriptDrain } : {}),
            }).then(notifyTranscriptIfCurrent).catch(failInterruptionIfCurrent);
          } else {
            notifyTranscriptIfCurrent();
          }
        }
      };
      const projectEventAndNotify = (
        conversationSessionId: string,
        projectedEvent: typeof normalizedEvent,
        attemptIdentity: string,
        retiringTranscriptDrain: BundledRetiringDirectMediaTranscriptDrain | null = null,
      ): void => {
        const assistantEntryId = projectEvent(
          conversationSessionId,
          projectedEvent,
          retiringTranscriptDrain,
        );
        notifyProjectedTranscript(
          conversationSessionId,
          projectedEvent,
          attemptIdentity,
          assistantEntryId,
          retiringTranscriptDrain,
        );
      };
      const projectNormalizedEvent = (): void => {
        if (
          activeTranscriptAttempt !== transcriptAttempt
          || transcriptAttempt.controllerAttemptId !== attemptId
          || transcriptAttempt.attemptIdentity === null
        ) {
          recordTranscriptDrop(
            attemptId,
            'transcript_attempt_superseded',
            'voice_transcript_attempt_ownership_mismatch',
          );
          return;
        }
        const resolvedConversationSessionId = host.resolveConversationSessionId(
          controlSessionId,
          providerId,
        );
        if (
          config.execution.kind === 'direct_media'
          && resolvedConversationSessionId !== transcriptAttempt.conversationSessionId
        ) {
          if (normalizedEvent.type !== 'voice.transcript.final') {
            // Clearing targetless Voice History is delete-wins for the old
            // carrier. Interim updates and corrections to deleted rows may
            // continue arriving from the live provider attempt, but only its
            // next final is allowed to acquire the fresh fixed-tag carrier.
            return;
          }
          const resourceAttempt = resourceAttempts.get(attemptId);
          const directMediaConversation = resourceAttempt?.directMediaConversation ?? null;
          if (
            !resourceAttempt
            || !directMediaConversation
            || directMediaConversation.targetSessionId !== null
            || resourceAttempt.releasePromise !== null
          ) {
            // The attempt's carrier is no longer the one this control session
            // resolves to and no recreation is available: a targeted carrier
            // cannot be re-acquired under a different identity, and a released
            // attempt owns no carrier at all. Writing the provider's words to
            // whatever the control session resolves to now would attribute them
            // to a conversation the user never held, so the event is refused —
            // but never in silence.
            recordTranscriptDrop(
              attemptId,
              'transcript_carrier_unavailable',
              resolvedConversationSessionId === null
                ? 'voice_transcript_conversation_unavailable'
                : 'voice_transcript_carrier_changed',
            );
            return;
          }
          let rebind = resourceAttempt.transcriptCarrierRebindPromise;
          let retiringTranscriptDrain = resourceAttempt.transcriptCarrierRebindDrain
            ?? resourceAttempt.directMediaConversation?.retiringTranscriptDrain
            ?? null;
          if (!rebind) {
            const captureRetiringDrain = host.captureRetiringDirectMediaTranscriptDrain;
            retiringTranscriptDrain = captureRetiringDrain
              ? captureRetiringDrain()
              : null;
            // Real hosts must capture this synchronously, while legacy test
            // hosts without the narrow custody port retain their existing
            // deterministic behavior.
            if (captureRetiringDrain && !retiringTranscriptDrain) {
              recordTranscriptDrop(
                attemptId,
                'transcript_generation_retired',
                'voice_transcript_attempt_ownership_mismatch',
              );
              return;
            }
            resourceAttempt.transcriptCarrierRebindDrain = retiringTranscriptDrain;
            rebind = (async () => {
              let adoptedRetiringDrain = false;
              try {
                const acquired = await host.acquireDirectMediaConversation({
                  adapterId: providerId,
                  controlSessionId,
                  requestedTargetSessionId: null,
                  ...(retiringTranscriptDrain ? { retiringTranscriptDrain } : {}),
                });
                if (
                  activeTranscriptAttempt !== transcriptAttempt
                  || transcriptAttempt.controllerAttemptId !== attemptId
                  || resourceAttempts.get(attemptId) !== resourceAttempt
                  || resourceAttempt.directMediaConversation !== directMediaConversation
                ) {
                  return;
                }
                const nextAttempt = host.beginTranscriptAttempt({
                  conversationSessionId: acquired.conversationSessionId,
                  ...(retiringTranscriptDrain ? { retiringTranscriptDrain } : {}),
                });
                if (!nextAttempt) {
                  throw new Error('voice_transcript_attempt_epoch_unavailable');
                }
                transcriptAttempt.conversationSessionId = acquired.conversationSessionId;
                transcriptAttempt.epoch = nextAttempt.epoch;
                transcriptAttempt.attemptIdentity = nextAttempt.attemptIdentity;
                resourceAttempt.directMediaConversation = Object.freeze({
                  controlSessionId,
                  conversationSessionId: acquired.conversationSessionId,
                  transcriptAttemptIdentity: nextAttempt.attemptIdentity,
                  targetSessionId: null,
                  retiringTranscriptDrain,
                  bindingOwnership: acquired.bindingOwnership ?? null,
                });
                if (resourceAttempt.transcriptCarrierRebindDrain === retiringTranscriptDrain) {
                  resourceAttempt.transcriptCarrierRebindDrain = null;
                }
                adoptedRetiringDrain = true;
                fireAndForget(
                  Promise.resolve(host.releaseDirectMediaConversation({
                    adapterId: providerId,
                    controlSessionId: directMediaConversation.controlSessionId,
                    conversationSessionId:
                      directMediaConversation.conversationSessionId,
                    transcriptAttemptIdentity:
                      directMediaConversation.transcriptAttemptIdentity,
                    ...(directMediaConversation.bindingOwnership
                      ? { bindingOwnership: directMediaConversation.bindingOwnership }
                      : {}),
                  })),
                  { tag: 'BundledRealtimeProviderRuntime.releaseDeletedTranscriptCarrier' },
                );
              } finally {
                if (!adoptedRetiringDrain && retiringTranscriptDrain) {
                  if (resourceAttempt.transcriptCarrierRebindDrain === retiringTranscriptDrain) {
                    resourceAttempt.transcriptCarrierRebindDrain = null;
                  }
                  host.releaseRetiringDirectMediaTranscriptDrain?.(retiringTranscriptDrain);
                }
              }
            })();
            resourceAttempt.transcriptCarrierRebindPromise = rebind;
          }
          const clearRebind = (): void => {
            if (resourceAttempt.transcriptCarrierRebindPromise === rebind) {
              resourceAttempt.transcriptCarrierRebindPromise = null;
            }
          };
          void rebind.then(
            () => {
              clearRebind();
              if (
                activeTranscriptAttempt !== transcriptAttempt
                || transcriptAttempt.controllerAttemptId !== attemptId
                || !transcriptAttempt.conversationSessionId
                || transcriptAttempt.epoch === null
                || transcriptAttempt.attemptIdentity === null
              ) {
                recordTranscriptDrop(
                  attemptId,
                  'transcript_carrier_rebind_superseded',
                  'voice_transcript_attempt_ownership_mismatch',
                );
                return;
              }
              projectEventAndNotify(
                transcriptAttempt.conversationSessionId,
                Object.freeze({
                  ...normalizedEvent,
                  epoch: transcriptAttempt.epoch,
                }),
                transcriptAttempt.attemptIdentity,
                retiringTranscriptDrain,
              );
            },
            () => {
              clearRebind();
              recordTranscriptDrop(
                attemptId,
                'transcript_carrier_rebind_failed',
                'voice_transcript_carrier_rebind_failed',
              );
            },
          );
          return;
        }
        if (!resolvedConversationSessionId) {
          recordTranscriptDrop(
            attemptId,
            'transcript_carrier_unresolved',
            'voice_transcript_conversation_unavailable',
          );
          return;
        }
        projectEventAndNotify(
          resolvedConversationSessionId,
          normalizedEvent,
          transcriptAttempt.attemptIdentity,
        );
      };
      const acceptanceBarrier = activeTypedTurnAcceptanceBarrier;
      if (
        acceptanceBarrier
        && isCanonicalVoiceTranscriptPersistenceEvent(normalizedEvent)
        && transcriptAttempt.conversationSessionId !== null
        && transcriptAttempt.attemptIdentity !== null
      ) {
        const admittedConversationSessionId = transcriptAttempt.conversationSessionId;
        const admittedAttemptIdentity = transcriptAttempt.attemptIdentity;
        const resolvedConversationSessionId = host.resolveConversationSessionId(
          controlSessionId,
          providerId,
        );
        // Recovery onto a newly-created carrier remains owned by the existing
        // direct-media rebind path below. This exact persistence-event custody
        // applies only when the event has a stable A carrier before it enters
        // the barrier.
        if (resolvedConversationSessionId === admittedConversationSessionId) {
          const admission: BundledAdmittedCanonicalTranscriptPersistenceEvent | null =
            host.admitTranscriptPersistenceEvent({
              conversationSessionId: admittedConversationSessionId,
              event: normalizedEvent,
              ...(config.providerSource ? { source: config.providerSource } : {}),
            });
          // Canonical admission already named invalid/conflicting input. Do not
          // defer a second mutable projection path for the same event.
          if (!admission) return;
          let committed = false;
          const custody = acceptanceBarrier.then(
            () => {
              const assistantEntryId = host.commitAdmittedTranscriptPersistenceEvent(admission);
              committed = true;
              if (assistantEntryId === null) return;
              notifyProjectedTranscript(
                admittedConversationSessionId,
                normalizedEvent,
                admittedAttemptIdentity,
                assistantEntryId,
              );
            },
            () => {
              host.releaseAdmittedTranscriptPersistenceEvent(admission);
            },
          ).catch(() => {
            if (!committed) host.releaseAdmittedTranscriptPersistenceEvent(admission);
          });
          trackAdmittedPersistenceCustody(admittedAttemptIdentity, custody);
          return;
        }
      }
      if (acceptanceBarrier) {
        void acceptanceBarrier.then(projectNormalizedEvent, () => {});
      } else {
        projectNormalizedEvent();
      }
    },
    onCanonicalEvent: async (event) => {
      if (disposed || !isCurrentGeneration()) return;
      if (event.type === 'assistant_output_started') {
        bargeInCoordinator?.onAssistantOutputStarted({ itemId: event.itemId });
      }
      if (event.type === 'assistant_output_stopped') {
        bargeInCoordinator?.onAssistantOutputStopped();
        outputLevelWriter?.reset();
      }
      if (event.type === 'input_speech_started') {
        bargeInCoordinator?.onInputSpeechStarted();
      }
      if (event.type === 'input_speech_stopped') {
        bargeInCoordinator?.onInputSpeechStopped();
      }
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
      effectCalls: config.protocol.toolEffectCalls ?? 'none',
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

  /**
   * Normalized execution-owned context authority. An Agent-session realtime
   * attachment runs against an Agent runtime that already owns the
   * authoritative realtime prompt and startup context, so Happier contributes
   * no bootstrap or stored-session item there.
   */
  const hostAuthoredContext: VoiceHostAuthoredContextScope =
    config.execution.kind === 'experimental_agent_session_realtime'
      ? 'current_ui_only'
      : 'session_context';

  const start = async (input: Readonly<{ sessionId: string; initialContext?: string; textOnly?: boolean }>) => {
    const startAttempt = {};
    activeStartAttempt = startAttempt;
    startOutcomeNamed = false;
    recordedTranscriptDrops.clear();
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
        // Target selection runs before the controller exists, so no machine
        // port can name this refusal and the surface keeps its previous label.
        recordVoiceRuntimeFailure(
          providerId,
          'unstarted',
          'target_selection_rejected',
          readSafeVoiceRuntimeFailureCode(error) ?? 'voice_target_selection_failed',
        );
        throw error;
      }
      if (!isStartAttemptCurrent()) return;
    }
    const initialContext = input.initialContext
      ?? host.voiceHooks.onStarted(input.sessionId, hostAuthoredContext);
    host.clearAttemptStatus(controlSessionId);
    const transcriptAttempt: ActiveTranscriptAttempt = {
      controlSessionId,
      controllerAttemptId: null,
      conversationSessionId: null,
      epoch: null,
      attemptIdentity: null,
      lastSequence: 0,
      sequenceOffsetBySource: new Map(),
      stopPromise: null,
    };
    activeTranscriptAttempt = transcriptAttempt;
    closeLevelWriters();
    const levelSourceId = `${providerId}:${controlSessionId}`;
    outputLevelSourceId = levelSourceId;
    if (!usesProviderManagedMic) {
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
    if (result.status === 'connected') {
      host.voiceHooks.onConnected?.(controlSessionId);
      if (usesProviderManagedMic) {
        inputLevelWriter = host.openLevelWriter({ channel: 'input', sourceId: levelSourceId });
      }
    }
    if (result.status !== 'connected') {
      if (activeTranscriptAttempt === transcriptAttempt) activeTranscriptAttempt = null;
      closeLevelWriters();
      host.voiceHooks.onStopped();
      if (!startOutcomeNamed) {
        // The controller refused or abandoned this Start without reaching a
        // machine port: no state changed, no request was made, and the surface
        // still shows whatever it showed before. Name it once here — this is the
        // only place that observes the outcome.
        recordVoiceRuntimeFailure(
          providerId,
          'unsettled',
          result.status,
          result.status === 'declined'
            ? normalizeVoiceRuntimeFailureCode(result.code)
            : 'voice_start_not_settled',
        );
      }
      if (result.status === 'failed') {
        const code = normalizeVoiceRuntimeFailureCode(result.code);
        throw Object.assign(new Error(code), { code });
      }
    }
  };

  const stop = (): Promise<void> => {
    const transcriptAttempt = activeTranscriptAttempt;
    if (transcriptAttempt?.stopPromise) return transcriptAttempt.stopPromise;
    const completeStop = async (): Promise<void> => {
      const transcriptAttemptIdentityBeforeStop = transcriptAttempt?.attemptIdentity ?? null;
      retireTypedTurnQueue();
      activeStartAttempt = null;
      bargeInCoordinator?.reset();
      closeLevelWriters();
      await runtime!.stop();
      const transcriptAttemptIdentity = activeTranscriptAttempt === transcriptAttempt
        ? transcriptAttempt?.attemptIdentity ?? null
        : transcriptAttemptIdentityBeforeStop;
      const transcriptRelease = transcriptAttemptIdentity
        ? directMediaReleaseByAttemptIdentity.get(transcriptAttemptIdentity)
        : null;
      await transcriptRelease?.catch(() => {});
      if (activeTranscriptAttempt !== transcriptAttempt) return;
      activeTranscriptAttempt = null;
      host.voiceHooks.onStopped();
    };
    if (!transcriptAttempt) return completeStop();

    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // The adapter owns transcript-attempt settlement, while the controller owns
    // provider teardown. Publish this attempt's stop before entering controller
    // teardown so duplicate adapter Stops share the same durability drain.
    transcriptAttempt.stopPromise = stopPromise;
    void completeStop().then(
      () => {
        if (transcriptAttempt.stopPromise === stopPromise) {
          transcriptAttempt.stopPromise = null;
        }
        resolveStop();
      },
      (error: unknown) => {
        if (transcriptAttempt.stopPromise === stopPromise) {
          transcriptAttempt.stopPromise = null;
        }
        rejectStop(error);
      },
    );
    return stopPromise;
  };

  const sendContextEvents = (events: readonly VoiceRealtimeJsonValue[]): void => {
    void sendEvents(events).catch(async () => {
      await runtime!.fail('voice_context_update_failed').catch(() => {});
    });
  };

  const adapter: VoiceAdapterController = Object.freeze({
    id: providerId,
    engineKind: 'realtime',
    ...(config.providerSource ? { transcriptSource: config.providerSource } : {}),
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
      const controlSessionId = runtime?.getOwnedControlSessionId();
      const attemptId = runtime?.getOwnedAttemptId();
      if (!controlSessionId || attemptId === null || attemptId === undefined) return;
      mic.setMuted(muted);
      if (muted) inputLevelWriter?.reset();
      await config.setInputMuted?.(muted);
      host.machine.setMuted(controlSessionId, providerId, attemptId, muted);
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
    async sendTextTurn({ controlSessionId, conversationSessionId, text, localId, onAccepted }) {
      const queue = typedTurnQueue;
      const previousTurn = queue.tail;
      let releaseTurn!: () => void;
      queue.tail = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      try {
        await waitForTypedTurnPredecessor(previousTurn, queue.abortController.signal);
        if (disposed || queue !== typedTurnQueue || queue.abortController.signal.aborted) {
          throw createVoiceTextTurnRejectedBeforeEffectError(
            new Error('voice_transcript_attempt_ownership_mismatch'),
            'runtime_disposed_before_delivery',
          );
        }
        const events = config.encodeTextTurn(text);
        if (events.length === 0) {
          throw createVoiceTextTurnRejectedBeforeEffectError(
            new Error('voice_text_turn_unsupported'),
            'unsupported_action',
          );
        }
        if (!runtime!.getActiveControlSessionId()) await start({ sessionId: controlSessionId, textOnly: true });
        if (host.resolveConversationSessionId(controlSessionId, providerId) !== conversationSessionId) {
          throw createVoiceTextTurnRejectedBeforeEffectError(
            new Error('voice_transcript_carrier_changed'),
            'provider_rejected_before_acceptance',
          );
        }
        const transcriptAttempt = activeTranscriptAttempt;
        const attemptIdentity = transcriptAttempt?.attemptIdentity ?? null;
        if (
          !transcriptAttempt
          || transcriptAttempt.controlSessionId !== controlSessionId
          || transcriptAttempt.conversationSessionId !== conversationSessionId
          || !attemptIdentity
        ) {
          throw createVoiceTextTurnRejectedBeforeEffectError(
            new Error('voice_transcript_attempt_ownership_mismatch'),
            'provider_rejected_before_acceptance',
          );
        }
        let resolveAcceptanceBarrier!: () => void;
        let rejectAcceptanceBarrier!: (reason: unknown) => void;
        let acceptanceBarrierSettled = false;
        const acceptanceBarrier = new Promise<void>((resolve, reject) => {
          resolveAcceptanceBarrier = () => {
            if (acceptanceBarrierSettled) return;
            acceptanceBarrierSettled = true;
            resolve();
          };
          rejectAcceptanceBarrier = (reason: unknown) => {
            if (acceptanceBarrierSettled) return;
            acceptanceBarrierSettled = true;
            reject(reason);
          };
        });
        // Most turns have no concurrent transcript callback. Keep an acceptance
        // failure observable to a captured final while avoiding an unhandled
        // rejection when there was nothing waiting on this barrier.
        void acceptanceBarrier.catch(() => {});
        activeTypedTurnAcceptanceBarrier = acceptanceBarrier;
        try {
          await sendEvents(events.slice(0, 1));
          if (host.resolveConversationSessionId(controlSessionId, providerId) !== conversationSessionId) {
            throw new Error('voice_transcript_carrier_changed');
          }
          if (
            activeTranscriptAttempt !== transcriptAttempt
            || transcriptAttempt.attemptIdentity !== attemptIdentity
          ) {
            throw new Error('voice_transcript_attempt_ownership_mismatch');
          }
          await host.settleTranscriptPersistence({
            conversationSessionId,
            attemptIdentity,
          });
          await onAccepted();
          resolveAcceptanceBarrier();
          if (activeTypedTurnAcceptanceBarrier === acceptanceBarrier) {
            activeTypedTurnAcceptanceBarrier = null;
          }
          if (host.resolveConversationSessionId(controlSessionId, providerId) !== conversationSessionId) {
            throw new Error('voice_transcript_carrier_changed');
          }
          if (
            activeTranscriptAttempt !== transcriptAttempt
            || transcriptAttempt.attemptIdentity !== attemptIdentity
          ) {
            throw new Error('voice_transcript_attempt_ownership_mismatch');
          }
          await sendEvents(events.slice(1));
        } catch (error) {
          rejectAcceptanceBarrier(error);
          throw error;
        } finally {
          rejectAcceptanceBarrier(new Error('voice_typed_turn_acceptance_unsettled'));
          if (activeTypedTurnAcceptanceBarrier === acceptanceBarrier) {
            activeTypedTurnAcceptanceBarrier = null;
          }
        }
      } finally {
        releaseTurn();
      }
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
        hostAuthoredContext,
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
        retireTypedTurnQueue();
        activeStartAttempt = null;
        clearHostedLeaseNotices();
        activeHostedLease = null;
        bargeInCoordinator?.reset();
        closeLevelWriters();
        await stop().catch(() => {});
        activeTranscriptAttempt = null;
        recordedTranscriptDrops.clear();
      })();
      return disposePromise;
    },
  });
}
