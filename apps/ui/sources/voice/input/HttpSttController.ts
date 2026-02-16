import { Platform } from 'react-native';

import { sync } from '@/sync/sync';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { fetchWithTimeout, resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { buildOpenAiTranscriptionRequest } from '@/voice/local/openaiCompat';
import { RecordingPresets } from 'expo-audio';

export class MissingSttBaseUrlError extends Error {
  constructor() {
    super('missing_stt_base_url');
    this.name = 'MissingSttBaseUrlError';
  }
}

export async function transcribeRecordedAudioWithHttpStt(params: {
  uri: string;
  settings: any;
}): Promise<string | null> {
  const { uri, settings } = params;
  const voice = settings?.voice ?? null;
  const providerId = voice?.providerId;
  const adapter =
    providerId === 'local_direct'
      ? voice?.adapters?.local_direct
      : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;

  const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(adapter?.networkTimeoutMs, 15_000);
  const stt = adapter?.stt ?? null;
  const openaiCompat = (stt?.openaiCompat ?? stt) as any;

  const sttBaseUrl = (openaiCompat?.baseUrl ?? '').trim();
  if (!sttBaseUrl) {
    throw new MissingSttBaseUrlError();
  }

  const sttApiKey = openaiCompat?.apiKey ? (sync.decryptSecretValue(openaiCompat.apiKey) ?? null) : null;
  const sttModel = (openaiCompat?.model ?? 'whisper-1') as string;

  const fileName = (RecordingPresets.HIGH_QUALITY as any)?.extension
    ? `recording${(RecordingPresets.HIGH_QUALITY as any).extension}`
    : 'recording.m4a';

	  const transcriptionReq = await (async () => {
	    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
	      const blob = await (await runtimeFetch(uri)).blob();
	      return buildOpenAiTranscriptionRequest({
	        baseUrl: sttBaseUrl,
	        apiKey: sttApiKey,
	        model: sttModel,
	        file: { kind: 'web', blob, name: fileName.replace(/\.m4a$/i, '.webm') },
	      });
	    }
    return buildOpenAiTranscriptionRequest({
      baseUrl: sttBaseUrl,
      apiKey: sttApiKey,
      model: sttModel,
      file: { kind: 'native', uri, name: fileName, mimeType: guessMimeType(fileName) },
    });
  })();

  const response = await fetchWithTimeout(transcriptionReq.url, transcriptionReq.init, networkTimeoutMs, 'stt_timeout');
  if (!response.ok) {
    return null;
  }

  const json = await response.json().catch(() => null);
  const text = json && typeof json.text === 'string' ? json.text.trim() : '';
  return text || null;
}

function guessMimeType(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/mp4';
}
