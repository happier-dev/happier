import { buildOpenAiSpeechRequest } from './openaiCompat';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';

export async function fetchOpenAiCompatSpeechAudio(opts: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
    voice: string;
    format: 'mp3' | 'wav';
    input: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<ArrayBuffer> {
    const req = buildOpenAiSpeechRequest({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        voice: opts.voice,
        responseFormat: opts.format,
        input: opts.input,
    });

    return fetchWithTimeout(req.url, { ...req.init, signal: opts.signal }, opts.timeoutMs ?? 15_000, 'tts_timeout', async (response) => {
        if (!response.ok) throw new Error(`tts_failed:${response.status}`);
        return response.arrayBuffer();
    });
}
