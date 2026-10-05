import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliAccountKvJsonTransport } from './accountKvJsonTransport';

afterEach(() => vi.restoreAllMocks());
it('authorizes the exact encoded CAS body, not an empty-body signature', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    let authorizedBody: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        expect(authorizedBody).toEqual(body);
        return { status: 200, data: { success: true, results: [{ key: 'todo.task-a', version: 2 }] } };
    });
    const transport = createCliAccountKvJsonTransport({ credentials: { token: 'token', encryption: null }, key: 'todo.task-a',
        serverBaseUrl: 'https://task-home.test', resolveAuthorizationHeaders: request => {
            if (request.method === 'POST') authorizedBody = 'body' in request ? request.body : undefined;
            return { Authorization: 'Bearer token' };
        } });
    await expect(transport.compareAndSet({ task: 'accepted' }, 1)).resolves.toEqual({ success: true, version: 2 });
});
