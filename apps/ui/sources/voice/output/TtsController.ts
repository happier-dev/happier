import { fetchOpenAiCompatSpeechAudio } from '@/voice/local/fetchOpenAiCompatSpeechAudio';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { speakBufferedSpeech } from '@/voice/output/speakBufferedSpeech';

/**
 * Speaks text with an OpenAI-compatible speech endpoint. Resolves when playback finishes or is
 * deliberately stopped (including while the request is in flight); rejects only on a real failure.
 */
export async function speakOpenAiCompatText(opts: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  voice: string;
  format: 'mp3' | 'wav';
  input: string;
  readAloudChunkChars?: number;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  return speakBufferedSpeech({
    ...opts,
    fetchAudio: (input, signal) => fetchOpenAiCompatSpeechAudio({ ...opts, input, signal }),
  });
}
