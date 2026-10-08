import { afterEach, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { fetchAccountEncryptionCurrentness } from './apiAccountEncryptionMode';
import { createServerFetchAtEndpoint } from '@/sync/http/client';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps captured-Home readiness failure out of the selected Home recovery flow', async () => {
    await upsertAndActivateServer({ serverUrl: 'https://selected-currentness.test' });
    const credentials = { token: 'captured-token', secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'migration-required',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-currentness.test', credentials });
    await expect(fetchAccountEncryptionCurrentness(credentials, { request })).rejects.toMatchObject({
        code: 'account-encryption-currentness-unavailable',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).origin).toBe('https://captured-currentness.test');
});
