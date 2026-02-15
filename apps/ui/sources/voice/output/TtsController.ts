import { fetchOpenAiCompatSpeechAudio } from '@/voice/local/fetchOpenAiCompatSpeechAudio';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';

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
  const buffer = await fetchOpenAiCompatSpeechAudio({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    voice: opts.voice,
    format: opts.format,
    input: opts.input,
    timeoutMs: opts.timeoutMs,
  });

  return await playAudioBytesWithStopper({
    bytes: buffer,
    format: opts.format,
    registerPlaybackStopper: opts.registerPlaybackStopper,
  });
}
