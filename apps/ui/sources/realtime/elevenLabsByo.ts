import { getElevenLabsApiBaseUrl, getElevenLabsApiTimeoutMs } from './elevenlabs/elevenLabsApi';

export async function fetchElevenLabsConversationTokenByo(params: {
    agentId: string;
    apiKey: string;
}): Promise<string> {
    const agentId = params.agentId.trim();
    const apiKey = params.apiKey.trim();
    if (!agentId) throw new Error('Missing ElevenLabs agentId');
    if (!apiKey) throw new Error('Missing ElevenLabs API key');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getElevenLabsApiTimeoutMs());
    let res: Response;
    try {
        const baseUrl = getElevenLabsApiBaseUrl();
        res = await fetch(
            `${baseUrl}/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
            {
                method: 'GET',
                headers: {
                    'xi-api-key': apiKey,
                    Accept: 'application/json',
                },
                signal: controller.signal,
            }
        );
    } catch (e) {
        if ((e as any)?.name === 'AbortError') {
            throw new Error('ElevenLabs token request timed out');
        }
        throw e;
    } finally {
        clearTimeout(timeout);
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error(`ElevenLabs token request failed (${res.status})`);
    }

    const token = data?.token;
    if (typeof token !== 'string' || !token.trim()) {
        throw new Error('ElevenLabs token response missing token');
    }
    return token;
}
