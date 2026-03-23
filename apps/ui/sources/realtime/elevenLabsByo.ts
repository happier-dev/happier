import { getElevenLabsApiBaseUrl, getElevenLabsApiTimeoutMs } from './elevenlabs/elevenLabsApi';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

type ElevenLabsByoAuthParams = {
    agentId: string;
    apiKey: string;
};

async function fetchElevenLabsByoAuthJson<T>(params: ElevenLabsByoAuthParams & {
    path: string;
    errorPrefix: string;
    pick: (data: any) => T | null;
}): Promise<T> {
    const agentId = params.agentId.trim();
    const apiKey = params.apiKey.trim();
    if (!agentId) throw new Error('Missing ElevenLabs agentId');
    if (!apiKey) throw new Error('Missing ElevenLabs API key');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getElevenLabsApiTimeoutMs());
    let res: Response;
    try {
        const baseUrl = getElevenLabsApiBaseUrl();
        res = await runtimeFetch(
            `${baseUrl}${params.path}?agent_id=${encodeURIComponent(agentId)}`,
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
        throw new Error(`${params.errorPrefix} failed (${res.status})`);
    }

    const picked = params.pick(data);
    if (picked == null || (typeof picked === 'string' && !picked.trim())) {
        throw new Error(`${params.errorPrefix} response missing value`);
    }
    return picked;
}

export async function fetchElevenLabsConversationTokenByo(params: ElevenLabsByoAuthParams): Promise<string> {
    return await fetchElevenLabsByoAuthJson({
        ...params,
        path: '/convai/conversation/token',
        errorPrefix: 'ElevenLabs token request',
        pick: (data) => (typeof data?.token === 'string' ? data.token : null),
    });
}

export async function fetchElevenLabsConversationSignedUrlByo(params: ElevenLabsByoAuthParams): Promise<string> {
    return await fetchElevenLabsByoAuthJson({
        ...params,
        path: '/convai/conversation/get-signed-url',
        errorPrefix: 'ElevenLabs signed URL request',
        pick: (data) => (typeof data?.signed_url === 'string' ? data.signed_url : null),
    });
}
