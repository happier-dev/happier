import { Platform } from 'react-native';
import {
  resolveVoiceSpeechSettingsCorrespondence,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';

import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { guessAudioMimeType } from '@/voice/input/guessAudioMimeType';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';

type BundledSpeechClient = Pick<typeof bundledSpeechDaemonClient, 'transcribe' | 'synthesize'>;

function createRuntimeError(code: 'provider_unavailable' | 'provider_settings_invalid' | 'unsupported_audio'): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function normalizeMimeType(value: string): 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg' {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'audio/wav' || normalized === 'audio/mpeg' || normalized === 'audio/mp4'
    || normalized === 'audio/webm' || normalized === 'audio/ogg') return normalized;
  throw createRuntimeError('unsupported_audio');
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  const client = input.client ?? bundledSpeechDaemonClient;
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
      fallbackLanguage: string | null;
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
      const language = asTrimmedString(config.language) ?? params.fallbackLanguage;

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
      const text = await client.transcribe({
        entry: contribution,
        source,
        mimeType,
        fileName: `recording.${mimeType === 'audio/wav' ? 'wav' : mimeType.split('/')[1]}`,
        model: correspondence.transcribe.model,
        language,
        originMachineId: params.originMachineId ?? null,
        signal: params.signal,
      });
      return text.trim() || null;
    },
    async speak(providerId: string, params: Readonly<{
      text: string;
      providerConfig: unknown;
      registerPlaybackStopper: VoicePlaybackStopperRegistrar;
      onPlaybackStarted?: () => void;
      signal?: AbortSignal | null;
    }>): Promise<void> {
      const { contribution, declaration, settings } = readDescriptor(providerId, 'tts');
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
      if (!correspondence.synthesize) throw createRuntimeError('provider_settings_invalid');
      const format = config.format === 'wav' ? 'wav' : 'mp3';
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
        const result = await client.synthesize({
          entry: contribution,
          input: params.text,
          model: correspondence.synthesize.model,
          voiceName: correspondence.synthesize.voiceName,
          languageCode: asTrimmedString(config.languageCode),
          format,
          speakingRate: typeof config.speakingRate === 'number' ? config.speakingRate : null,
          pitch: typeof config.pitch === 'number' ? config.pitch : null,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) return;
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
          format,
          registerPlaybackStopper: registerPlaybackOnly,
          onPlaybackStarted: params.onPlaybackStarted,
        });
      } finally {
        params.signal?.removeEventListener('abort', abortFromSignal);
        clearStopper();
      }
    },
  });
}
