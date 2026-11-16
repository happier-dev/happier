import { afterEach, expect, it, vi } from 'vitest';
import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: { ...actual.default, get, post } };
});

import { ApiClient } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('uses each calling Session retry policy when a shared API client creates Sessions', async () => {
    vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '3');
    vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
    vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { encryption: {
        storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain',
    } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    get.mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
    const attempts = new Map<string, number>();
    post.mockImplementation(async (_url: string, body: { tag: string }) => {
        attempts.set(body.tag, (attempts.get(body.tag) ?? 0) + 1);
        const error = new Error('server unavailable');
        throw Object.assign(error, { isAxiosError: true, response: { status: 503 } });
    });
    const api = await ApiClient.create({ token: 'retry-scope-token', encryption: null });
    await runWithServerHttpBaseUrl('https://retry-scope.test', () => Promise.all([1, 2].map(maxAttempts =>
        runInHostedSessionScope({ environment: {
            NODE_ENV: 'test',
            HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS: String(maxAttempts),
            HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS: '0', HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS: '0',
        } }, async () => {
            await Promise.resolve();
            await expect(api.getOrCreateSession({ tag: `scope-${maxAttempts}`,
                metadata: { path: '/tmp', host: 'localhost' }, state: null })).rejects.toMatchObject({ response: { status: 503 } });
        }))));
    await runWithServerHttpBaseUrl('https://retry-scope.test', () => expect(api.getOrCreateSession({ tag: 'host',
        metadata: { path: '/tmp', host: 'localhost' }, state: null })).rejects.toMatchObject({ response: { status: 503 } }));
    expect([...attempts.values()].sort()).toEqual([1, 2, 3]);
});
