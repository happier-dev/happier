import { describe, expect, it, vi } from 'vitest';
import { pingHandler } from './pingHandler';

describe('pingHandler compatibility ACK', () => {
    it('returns current requirements on the exact connected socket', async () => {
        let handler: ((callback: (response: unknown) => void) => Promise<void>) | undefined;
        const socket = { on: vi.fn((event: string, listener: typeof handler) => { if (event === 'ping') handler = listener; }) };
        pingHandler(socket as never);
        const callback = vi.fn();
        await handler?.(callback);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            compatibility: expect.objectContaining({
                sessionSync: expect.objectContaining({ currentSessionSyncProtocolVersion: 2 }),
                pendingInput: expect.objectContaining({ currentPendingInputProtocolVersion: 1 }),
            }),
        }));
    });

    it('advertises the configured required provider-host floors', async () => {
        let handler: ((callback: (response: unknown) => void) => Promise<void>) | undefined;
        const socket = { on: vi.fn((event: string, listener: typeof handler) => { if (event === 'ping') handler = listener; }) };
        pingHandler(socket as never, {
            env: {
                HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: 'required',
                HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '2',
                HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
                    daemon: '0.2.10',
                    'session-runner': '0.2.10',
                }),
            },
        });
        const callback = vi.fn();
        await handler?.(callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            compatibility: expect.objectContaining({
                sessionSync: expect.objectContaining({
                    enforcement: 'required',
                    minimumVersionsByClientKind: {
                        daemon: '0.2.10',
                        'session-runner': '0.2.10',
                    },
                }),
            }),
        }));
    });
});
