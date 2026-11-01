import { fetchOpenAiCompatSpeechAudio } from '@/voice/local/fetchOpenAiCompatSpeechAudio';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createStoppableSpeech } from '@/voice/output/stoppableSpeech';

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
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  const speech = createStoppableSpeech(opts.registerPlaybackStopper);
  try {
    const buffer = await fetchOpenAiCompatSpeechAudio({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      voice: opts.voice,
      format: opts.format,
      input: opts.input,
      timeoutMs: opts.timeoutMs,
      signal: speech.signal,
    });
    if (speech.signal.aborted) return;
    await playAudioBytesWithStopper({
      bytes: buffer,
      format: opts.format,
      registerPlaybackStopper: speech.registerPlayback,
    });
  } catch (error) {
    if (speech.signal.aborted) return;
    throw error;
  } finally {
    speech.dispose();
  }
}
