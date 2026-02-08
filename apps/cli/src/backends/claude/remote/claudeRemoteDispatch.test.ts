import { describe, expect, it, vi } from 'vitest';

describe('claudeRemoteDispatch', () => {
    it('routes to Agent SDK runner when enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});

        // Avoid leaking hoisted module mocks into other test files by using doMock + cleanup.
        vi.doMock('../claudeRemote', () => ({
            claudeRemote: mockLegacy,
        }));
        vi.doMock('./claudeRemoteAgentSdk', () => ({
            claudeRemoteAgentSdk: mockAgentSdk,
        }));

        try {
            const { claudeRemoteDispatch } = await import('./claudeRemoteDispatch');

            let sent = false;
            await claudeRemoteDispatch({
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any);

            expect(mockAgentSdk).toHaveBeenCalledTimes(1);
            expect(mockLegacy).toHaveBeenCalledTimes(0);
        } finally {
            vi.unmock('../claudeRemote');
            vi.unmock('./claudeRemoteAgentSdk');
            vi.resetModules();
        }
    });
});
