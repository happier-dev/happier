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
}): Promise<ArrayBuffer> {
    const req = buildOpenAiSpeechRequest({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        voice: opts.voice,
        responseFormat: opts.format,
        input: opts.input,
    });

    const res = await fetchWithTimeout(req.url, req.init, opts.timeoutMs ?? 15_000, 'tts_timeout');
    if (!res.ok) {
        throw new Error(`tts_failed:${res.status}`);
    }

    return await res.arrayBuffer();
}
