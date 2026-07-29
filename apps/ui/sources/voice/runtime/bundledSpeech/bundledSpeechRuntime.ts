import { Platform } from 'react-native';

import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { guessAudioMimeType } from '@/voice/input/guessAudioMimeType';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { bundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { readBundledSpeechSettingsDescriptorFromEntry } from '@/voice/settings/panels/bundledSpeech/descriptor';

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

export function createBundledSpeechRuntime(input: Readonly<{
  registry: VoiceProviderRegistry;
  client?: BundledSpeechClient;
  platformOs?: string;
  fetchImpl?: typeof runtimeFetch;
  play?: typeof playAudioBytesWithStopper;
}>) {
  const client = input.client ?? bundledSpeechDaemonClient;
  const entries = input.registry.list().flatMap((entry) =>
    entry.source.kind === 'bundled' && entry.kind === 'voice.speech-engine.v1' ? [entry] : [],
  );
  const providerIdsForRole = (role: 'stt' | 'tts') => Object.freeze(entries
    .filter((entry) => entry.role === role || entry.role === 'both')
    .map((entry) => entry.providerId));
  const sttIds = providerIdsForRole('stt');
  const ttsIds = providerIdsForRole('tts');
  const readDescriptor = (providerId: string, role: 'stt' | 'tts') => {
    const contribution = input.registry.get(providerId);
    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(providerId, contribution);
    if (!contribution || contribution.source.kind !== 'bundled'
      || contribution.kind !== 'voice.speech-engine.v1'
      || (contribution.role !== role && contribution.role !== 'both')
      || descriptor?.role !== role) throw createRuntimeError('provider_unavailable');
    return Object.freeze({ contribution, descriptor });
  };

  return Object.freeze({
    sttProviderIds: () => sttIds,
    ttsProviderIds: () => ttsIds,
    async transcribeRecordedAudio(providerId: string, params: Readonly<{
      uri: string;
      providerConfig: unknown;
      fallbackLanguage: string | null;
      signal?: AbortSignal | null;
    }>): Promise<string | null> {
      const { contribution, descriptor } = readDescriptor(providerId, 'stt');
      const config = descriptor.parseConfig(params.providerConfig);
      if (!config) throw createRuntimeError('provider_settings_invalid');
      const model = asTrimmedString(config[descriptor.runtime.modelKey ?? 'model'])
        ?? asTrimmedString(descriptor.runtime.defaultModel);
      if (!model) throw createRuntimeError('provider_settings_invalid');
      const language = asTrimmedString(config[descriptor.runtime.languageKey ?? 'language']) ?? params.fallbackLanguage;

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
        model,
        language,
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
      const { contribution, descriptor } = readDescriptor(providerId, 'tts');
      const config = descriptor.parseConfig(params.providerConfig);
      if (!config) throw createRuntimeError('provider_settings_invalid');
      const voiceName = asTrimmedString(config[descriptor.runtime.voiceKey ?? 'voiceName']);
      if (!voiceName) throw createRuntimeError('provider_settings_invalid');
      const format = config[descriptor.runtime.formatKey ?? 'format'] === 'wav' ? 'wav' : 'mp3';
      const result = await client.synthesize({
        entry: contribution,
        input: params.text,
        voiceName,
        languageCode: asTrimmedString(config[descriptor.runtime.languageKey ?? 'languageCode']),
        format,
        speakingRate: typeof config[descriptor.runtime.rateKey ?? 'speakingRate'] === 'number'
          ? config[descriptor.runtime.rateKey ?? 'speakingRate'] as number : null,
        pitch: typeof config[descriptor.runtime.pitchKey ?? 'pitch'] === 'number'
          ? config[descriptor.runtime.pitchKey ?? 'pitch'] as number : null,
        signal: params.signal,
      });
      await (input.play ?? playAudioBytesWithStopper)({
        bytes: result.bytes.buffer.slice(
          result.bytes.byteOffset,
          result.bytes.byteOffset + result.bytes.byteLength,
        ) as ArrayBuffer,
        format,
        registerPlaybackStopper: params.registerPlaybackStopper,
        onPlaybackStarted: params.onPlaybackStarted,
      });
    },
  });
}
