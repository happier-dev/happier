import { Platform } from 'react-native';
import { resolveVoiceSpeechSettingsCorrespondence } from '@happier-dev/protocol/plugins/contributions/voice';
import { resolveVoiceSpeechSynthesisInputLimits } from '@happier-dev/protocol/voice/speech';
import { batchSpeechTextForSynthesis } from '@happier-dev/protocol/voice/speechText';
import type { VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol/voice/realtime/providerSettings';
import type { SessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { readSessionVoiceSettingFieldV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import type { VoiceConversationInUseVoice } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionVoicePreference } from '@/voice/settings/resolveSessionVoicePreference';

import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { guessAudioMimeType } from '@/voice/input/guessAudioMimeType';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';

type BundledSpeechClient = Pick<typeof bundledSpeechDaemonClient, 'transcribe' | 'synthesize'>
  & Partial<Pick<typeof bundledSpeechDaemonClient, 'fetchCatalog'>>;

export type BundledSpeechPreparation = Readonly<{
  targetSessionAddress: SessionAddress | null;
  preference: SessionVoicePreferenceV1 | null;
  isCurrent(): boolean;
  onVoiceApplied?(voice: VoiceConversationInUseVoice | null): void;
}>;

function createRuntimeError(code: 'provider_unavailable' | 'provider_settings_invalid' | 'unsupported_audio'): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function normalizeMimeType(value: string): 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg' {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'audio/wav' || normalized === 'audio/mpeg' || normalized === 'audio/mp4'
    || normalized === 'audio/webm' || normalized === 'audio/ogg') return normalized;
  throw createRuntimeError('unsupported_audio');
}

function isVoiceProviderSettingsJsonObject(
  value: VoiceProviderSettingsJsonValueV1,
): value is Readonly<Record<string, VoiceProviderSettingsJsonValueV1>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createBundledSpeechRuntime(input: Readonly<{
  registry: VoiceProviderRegistry;
  client?: BundledSpeechClient;
  platformOs?: string;
  fetchImpl?: typeof runtimeFetch;
  play?: typeof playAudioBytesWithStopper;
}>) {
  // A default transcription controller is constructed during sync bootstrap.
  // Resolve its speech client when used, after the dependency graph is ready.
  const getClient = () => input.client ?? bundledSpeechDaemonClient;
  const entries = input.registry.list().flatMap((entry) =>
    entry.kind === 'voice.speech-engine.v1' && entry.declaration?.kind === 'speech' ? [entry] : [],
  );
  const providerIdsForRole = (role: 'stt' | 'tts') => Object.freeze(entries
    .filter((entry) => entry.role === role || entry.role === 'both')
    .map((entry) => entry.providerId));
  const sttIds = providerIdsForRole('stt');
  const ttsIds = providerIdsForRole('tts');
  const readDescriptor = (providerId: string, role: 'stt' | 'tts') => {
    const contribution = input.registry.get(providerId);
    if (!contribution || contribution.kind !== 'voice.speech-engine.v1'
      || (contribution.role !== role && contribution.role !== 'both')
      || contribution.declaration?.kind !== 'speech'
      || !contribution.providerSettings) throw createRuntimeError('provider_unavailable');
    return Object.freeze({
      contribution,
      declaration: contribution.declaration,
      settings: contribution.providerSettings,
    });
  };

  return Object.freeze({
    sttProviderIds: () => sttIds,
    ttsProviderIds: () => ttsIds,
    async transcribeRecordedAudio(providerId: string, params: Readonly<{
      uri: string;
      providerConfig: unknown;
      capturePurpose?: 'conversation' | 'dictation';
      /** Daemon the originating capture attempt was admitted against. */
      originMachineId?: string | null;
      signal?: AbortSignal | null;
    }>): Promise<string | null> {
      const { contribution, declaration, settings } = readDescriptor(providerId, 'stt');
      const config = settings.parseConfig(params.providerConfig);
      if (!config || !isVoiceProviderSettingsJsonObject(config)) {
        throw createRuntimeError('provider_settings_invalid');
      }
      let correspondence: ReturnType<typeof resolveVoiceSpeechSettingsCorrespondence>;
      try {
        correspondence = resolveVoiceSpeechSettingsCorrespondence({ contribution: declaration, settings: config });
      } catch {
        throw createRuntimeError('provider_settings_invalid');
      }
      if (!correspondence.transcribe) throw createRuntimeError('provider_settings_invalid');

      let source: { kind: 'native'; uri: string } | { kind: 'memory'; bytes: Uint8Array };
      let mimeType: ReturnType<typeof normalizeMimeType>;
      if ((input.platformOs ?? Platform.OS) === 'web' && params.uri.startsWith('blob:')) {
        const blob = await (input.fetchImpl ?? runtimeFetch)(params.uri).then((response) => response.blob());
        mimeType = normalizeMimeType(blob.type || 'audio/webm');
        source = { kind: 'memory', bytes: new Uint8Array(await blob.arrayBuffer()) };
      } else {
        mimeType = normalizeMimeType(guessAudioMimeType(params.uri));
        source = { kind: 'native', uri: params.uri };
      }
      const text = await getClient().transcribe({
        entry: contribution,
        source,
        mimeType,
        fileName: `recording.${mimeType === 'audio/wav' ? 'wav' : mimeType.split('/')[1]}`,
        originMachineId: params.originMachineId ?? null,
        ...(params.capturePurpose ? { capturePurpose: params.capturePurpose } : {}),
        signal: params.signal,
      });
      return text.trim() || null;
    },
    async speak(providerId: string, params: Readonly<{
      text: string;
      providerConfig: unknown;
      preparation?: BundledSpeechPreparation;
      originMachineId?: string | null;
      registerPlaybackStopper: VoicePlaybackStopperRegistrar;
      onPlaybackStarted?: () => void;
      signal?: AbortSignal | null;
    }>): Promise<void> {
      const { contribution, declaration, settings } = readDescriptor(providerId, 'tts');
      let config = settings.parseConfig(params.providerConfig);
      if (!config || !isVoiceProviderSettingsJsonObject(config)) {
        throw createRuntimeError('provider_settings_invalid');
      }
      let catalog: readonly Readonly<{ id: string; name: string }>[] | null = null;
      if (params.preparation) {
        if (!params.preparation.isCurrent() || params.signal?.aborted) return;
        if (readSessionVoiceSettingFieldV1(declaration)) {
          try { catalog = await getClient().fetchCatalog?.(contribution, 'voices', params.signal, params.originMachineId) ?? null; }
          catch (error) { if (params.signal?.aborted) throw error; }
        }
        if (!params.preparation.isCurrent() || params.signal?.aborted) return;
        const resolved = resolveSessionVoicePreference({ providerContributionId: providerId,
          declaration, providerConfig: config, preference: params.preparation.preference, catalog });
        if (resolved.kind === 'unavailable') throw createRuntimeError('provider_settings_invalid');
        config = resolved.providerConfig;
      }
      if (!isVoiceProviderSettingsJsonObject(config)) throw createRuntimeError('provider_settings_invalid');
      let correspondence: ReturnType<typeof resolveVoiceSpeechSettingsCorrespondence>;
      try {
        correspondence = resolveVoiceSpeechSettingsCorrespondence({ contribution: declaration, settings: config });
      } catch {
        throw createRuntimeError('provider_settings_invalid');
      }
      if (!correspondence.synthesize) throw createRuntimeError('provider_settings_invalid');
      const batches = batchSpeechTextForSynthesis(params.text, resolveVoiceSpeechSynthesisInputLimits({
        contribution: declaration, settings: config,
      }));
      const abortController = new AbortController();
      let stopPlayback: (() => void) | null = null;
      const stop = () => {
        abortController.abort();
        const stopper = stopPlayback;
        stopPlayback = null;
        try {
          stopper?.();
        } catch {
          // Playback teardown is best-effort; synthesis cancellation remains authoritative.
        }
      };
      const abortFromSignal = () => stop();
      if (params.signal?.aborted) stop();
      else params.signal?.addEventListener('abort', abortFromSignal, { once: true });

      let clearStopper = () => {};
      try {
        clearStopper = params.registerPlaybackStopper(stop);
        if (abortController.signal.aborted) return;
        let playbackStarted = false;
        for (const text of batches) {
          if (abortController.signal.aborted || params.preparation?.isCurrent() === false) return;
          const result = await getClient().synthesize({
            entry: contribution,
            input: text,
            originMachineId: params.originMachineId,
            ...(params.preparation?.preference ? { voicePreference: params.preparation.preference } : {}),
            signal: abortController.signal,
          });
          if (abortController.signal.aborted || params.preparation?.isCurrent() === false) return;
          const registerPlaybackOnly: VoicePlaybackStopperRegistrar = (stopper) => {
            stopPlayback = stopper;
            return () => {
              if (stopPlayback === stopper) stopPlayback = null;
            };
          };
          await (input.play ?? playAudioBytesWithStopper)({
            bytes: result.bytes.buffer.slice(
              result.bytes.byteOffset,
              result.bytes.byteOffset + result.bytes.byteLength,
            ) as ArrayBuffer,
            format: result.mimeType === 'audio/wav' ? 'wav' : 'mp3',
            registerPlaybackStopper: registerPlaybackOnly,
            onPlaybackStarted: () => {
              if (playbackStarted || abortController.signal.aborted || params.preparation?.isCurrent() === false) return;
              playbackStarted = true;
              const actual = result.appliedVoice;
              const applied = actual ? resolveSessionVoicePreference({ providerContributionId: providerId,
                declaration, providerConfig: config, preference: actual, catalog }) : null;
              const accepted = applied && applied.kind !== 'unavailable' && applied.inUseVoice
                ? Object.freeze(applied.inUseVoice) : null;
              params.preparation?.onVoiceApplied?.(accepted);
              params.onPlaybackStarted?.();
            },
          });
        }
      } finally {
        params.signal?.removeEventListener('abort', abortFromSignal);
        clearStopper();
      }
    },
  });
}
