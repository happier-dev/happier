import { describe, expect, it, vi } from 'vitest';
import { pingHandler } from './pingHandler';

describe('pingHandler', () => {
    it('returns the legacy liveness acknowledgement without duplicating feature negotiation', async () => {
        let handler: ((callback: (response: unknown) => void) => Promise<void>) | undefined;
        const socket = {
            on: vi.fn((event: string, listener: typeof handler) => {
                if (event === 'ping') handler = listener;
            }),
        };
        pingHandler(socket as never);
        const callback = vi.fn();

        await handler?.(callback);

        expect(callback).toHaveBeenCalledWith({});
    });
});
