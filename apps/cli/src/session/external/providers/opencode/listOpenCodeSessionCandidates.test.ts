import { describe, expect, it, vi } from 'vitest';

const openCodeClientMock = vi.hoisted(() => ({
    sessionList: vi.fn(),
    sessionStatusList: vi.fn(),
    dispose: vi.fn(),
}));

// Boundary mock: OpenCode direct client talks to the provider server.
vi.mock('./createOpenCodeDirectClient', () => ({
    createOpenCodeDirectClient: vi.fn(async () => openCodeClientMock),
}));

import { listOpenCodeSessionCandidates } from './listOpenCodeSessionCandidates';

describe('listOpenCodeSessionCandidates', () => {
    it('emits canonical runtimeDescriptorV1 candidate details', async () => {
        openCodeClientMock.sessionList.mockResolvedValueOnce([
            {
                id: 'oc-session-1',
                title: 'OpenCode session',
                updatedAtMs: 123,
            },
        ]);
        openCodeClientMock.sessionStatusList.mockResolvedValueOnce({});
        openCodeClientMock.dispose.mockResolvedValueOnce(undefined);

        const result = await listOpenCodeSessionCandidates({
            source: {
                kind: 'opencodeServer',
                baseUrl: 'http://127.0.0.1:4096/',
            },
            limit: 10,
        });

        expect(result.candidates).toHaveLength(1);
        const details = result.candidates[0]?.details;
        expect(details).toMatchObject({
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'opencode',
                provider: {
                    backendMode: 'server',
                    vendorSessionId: 'oc-session-1',
                    providerExtra: {
                        runtimeHandle: {
                            backendMode: 'server',
                            vendorSessionId: 'oc-session-1',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                },
            },
        });
        expect(details).not.toHaveProperty('agentRuntimeDescriptorV1');
    });
});
