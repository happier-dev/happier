import { describe, expect, it, vi } from 'vitest';

import { revalidateVoiceSpeechHttpEndpoint } from './voiceSpeechHttpPolicy';

describe('Voice speech HTTP endpoint policy', () => {
    const policy = Object.freeze({
        normalizedBaseUrl: 'http://localhost:11434/v1',
        origin: 'http://localhost:11434',
        insecureHttpConfirmed: true,
    });

    it('requires the exact machine-bound consent before HTTP and keeps requests under the configured base path', async () => {
        const resolveAddresses = vi.fn(async () => ['127.0.0.1']);
        await expect(revalidateVoiceSpeechHttpEndpoint({
            policy: { ...policy, insecureHttpConfirmed: false },
            requestUrl: 'http://localhost:11434/v1/audio/speech',
            resolveAddresses,
        })).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(resolveAddresses).not.toHaveBeenCalled();

        await expect(revalidateVoiceSpeechHttpEndpoint({
            policy,
            requestUrl: 'http://localhost:11434/v2/audio/speech',
            resolveAddresses,
        })).rejects.toMatchObject({ code: 'provider_unavailable' });

        await expect(revalidateVoiceSpeechHttpEndpoint({
            policy,
            requestUrl: 'http://localhost:11434/v1/audio/speech',
            resolveAddresses,
        })).resolves.toBeUndefined();
    });

    it('rejects DNS rebinding and public plaintext destinations', async () => {
        await expect(revalidateVoiceSpeechHttpEndpoint({
            policy,
            requestUrl: 'http://localhost:11434/v1/audio/speech',
            resolveAddresses: async () => ['8.8.8.8'],
        })).rejects.toMatchObject({ code: 'provider_unavailable' });
        await expect(revalidateVoiceSpeechHttpEndpoint({
            policy: {
                normalizedBaseUrl: 'http://speech.example/v1',
                origin: 'http://speech.example',
                insecureHttpConfirmed: true,
            },
            requestUrl: 'http://speech.example/v1/audio/speech',
            resolveAddresses: async () => ['8.8.8.8'],
        })).rejects.toMatchObject({ code: 'provider_unavailable' });
    });
});
