import { Platform } from 'react-native';
import { RecordingPresets } from 'expo-audio';

import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { guessAudioMimeType } from '@/voice/input/guessAudioMimeType';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { OpenAiCompatDaemonClient } from '@/voice/local/openaiCompat/client';

export class MissingSttBaseUrlError extends Error {
  constructor() {
    super('missing_stt_base_url');
    this.name = 'MissingSttBaseUrlError';
  }
}

function normalizeSupportedMimeType(value: string): 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg' {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'audio/wav' || normalized === 'audio/mpeg' || normalized === 'audio/mp4' || normalized === 'audio/webm' || normalized === 'audio/ogg') {
    return normalized;
  }
  return 'audio/mp4';
}

export async function transcribeRecordedAudioWithHttpStt(params: Readonly<{
  uri: string;
  settings: any;
  signal?: AbortSignal;
  client?: Pick<OpenAiCompatDaemonClient, 'transcribe'>;
}>): Promise<string | null> {
  const { uri, settings, signal } = params;
  if (signal?.aborted) return null;

  const adapter = resolveLocalVoiceAdapterSettings(settings).config;
  const openaiCompat = (adapter?.stt?.openaiCompat ?? adapter?.stt ?? null) as any;
  const baseUrl = typeof openaiCompat?.baseUrl === 'string' ? openaiCompat.baseUrl.trim() : '';
  if (!baseUrl) throw new MissingSttBaseUrlError();
  const model = typeof openaiCompat?.model === 'string' && openaiCompat.model.trim()
    ? openaiCompat.model.trim()
    : 'whisper-1';
  const extension = (RecordingPresets.HIGH_QUALITY as any)?.extension;
  const defaultName = extension ? `recording${extension}` : 'recording.m4a';
  const client = params.client ?? new OpenAiCompatDaemonClient();

  try {
    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
      const blob = await (await runtimeFetch(uri, { signal })).blob();
      if (signal?.aborted) return null;
      const mimeType = normalizeSupportedMimeType(blob.type || 'audio/webm');
      const fileName = defaultName.replace(/\.m4a$/iu, mimeType === 'audio/webm' ? '.webm' : '.audio');
      const file = new File([blob], fileName, { type: mimeType });
      const text = await client.transcribe({
        baseUrl,
        insecureLocalOriginConsent: openaiCompat?.insecureLocalOriginConsent ?? null,
        insecureLocalConsentMachineId: openaiCompat?.insecureLocalConsentMachineId ?? null,
        credentialKind: 'stt_api_key',
        model,
        source: { kind: 'web', file },
        mimeType,
        fileName,
        signal,
      });
      return text.trim() || null;
    }

    const mimeType = normalizeSupportedMimeType(guessAudioMimeType(defaultName));
    const text = await client.transcribe({
      baseUrl,
      insecureLocalOriginConsent: openaiCompat?.insecureLocalOriginConsent ?? null,
      insecureLocalConsentMachineId: openaiCompat?.insecureLocalConsentMachineId ?? null,
      credentialKind: 'stt_api_key',
      model,
      source: { kind: 'native', uri },
      mimeType,
      fileName: defaultName,
      signal,
    });
    return text.trim() || null;
  } catch (error) {
    if (signal?.aborted) return null;
    throw error;
  }
}
