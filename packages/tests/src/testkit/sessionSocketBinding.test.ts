import { afterEach, describe, expect, it, vi } from 'vitest';

const { createSessionScopedSocketCollector } = vi.hoisted(() => ({
    createSessionScopedSocketCollector: vi.fn(() => ({ kind: 'fake-socket' })),
}));

vi.mock('./socketClient', () => ({
    createSessionScopedSocketCollector,
}));

import { createMachineBoundSessionScopedSocketCollector } from './sessionSocketBinding';

function createJsonResponse(status: number, body: unknown) {
    return {
        status,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
    } as Response;
}

describe('createMachineBoundSessionScopedSocketCollector', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        createSessionScopedSocketCollector.mockReset();
        createSessionScopedSocketCollector.mockReturnValue({ kind: 'fake-socket' });
    });

    it('retries a transient machine-create 500 before creating the access key', async () => {
        const fetchSpy = vi.fn()
            .mockResolvedValueOnce(createJsonResponse(500, { error: 'transient' }))
            .mockResolvedValueOnce(createJsonResponse(200, { machine: { id: 'machine-1' } }))
            .mockResolvedValueOnce(createJsonResponse(200, { success: true }));
        globalThis.fetch = fetchSpy as typeof globalThis.fetch;

        const result = await createMachineBoundSessionScopedSocketCollector({
            baseUrl: 'http://127.0.0.1:3000',
            token: 'token',
            sessionId: 'session-1',
            machineId: 'machine-1',
            connectTimeoutMs: 65_000,
        });

        expect(result.machineId).toBe('machine-1');
        expect(createSessionScopedSocketCollector).toHaveBeenCalledWith(
            'http://127.0.0.1:3000',
            'token',
            'session-1',
            'machine-1',
            { transports: undefined, connectTimeoutMs: 65_000 },
        );
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3000/v1/machines');
        expect(fetchSpy.mock.calls[1]?.[0]).toBe('http://127.0.0.1:3000/v1/machines');
        expect(fetchSpy.mock.calls[2]?.[0]).toBe('http://127.0.0.1:3000/v1/access-keys/session-1/machine-1');
    });

    it('fails after the bounded retry budget is exhausted for repeated machine-create 500 responses', async () => {
        const fetchSpy = vi.fn()
            .mockResolvedValue(createJsonResponse(500, { error: 'still failing' }));
        globalThis.fetch = fetchSpy as typeof globalThis.fetch;

        await expect(
            createMachineBoundSessionScopedSocketCollector({
                baseUrl: 'http://127.0.0.1:3000',
                token: 'token',
                sessionId: 'session-1',
                machineId: 'machine-1',
            }),
        ).rejects.toThrow('Failed to create machine (500)');

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(createSessionScopedSocketCollector).not.toHaveBeenCalled();
    });
});
