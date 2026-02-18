import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteDispatch } from './claudeRemoteDispatch';

describe('claudeRemoteDispatch', () => {
    it('routes to Agent SDK runner when enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});

        let sent = false;
        await claudeRemoteDispatch(
            {
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });
});
