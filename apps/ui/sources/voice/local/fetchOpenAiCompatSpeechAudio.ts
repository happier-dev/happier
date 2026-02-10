import { buildOpenAiSpeechRequest } from './openaiCompat';

export async function fetchOpenAiCompatSpeechAudio(opts: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
    voice: string;
    format: 'mp3' | 'wav';
    input: string;
}): Promise<ArrayBuffer> {
    const req = buildOpenAiSpeechRequest({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        voice: opts.voice,
        responseFormat: opts.format,
        input: opts.input,
    });

    const res = await fetch(req.url, req.init);
    if (!res.ok) {
        throw new Error(`tts_failed:${res.status}`);
    }

    return await res.arrayBuffer();
}
