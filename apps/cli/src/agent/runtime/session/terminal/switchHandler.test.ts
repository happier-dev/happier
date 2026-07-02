import { describe, expect, it, vi } from 'vitest';

import { createTerminalRuntimeSwitchHandlerService } from './switchHandler';

describe('createTerminalRuntimeSwitchHandlerService', () => {
    it('registers one sanitized switch handler and disables it on unsubscribe', async () => {
        const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
        const service = createTerminalRuntimeSwitchHandlerService({
            registerHandler: (method, handler) => {
                handlers.set(method, handler);
            },
        });
        const onSwitch = vi.fn(async () => true);

        const subscription = service.register(onSwitch);

        await expect(handlers.get('switch')?.({
            to: 'remote',
            payload: 'do not expose this payload',
        })).resolves.toBe(true);
        expect(onSwitch).toHaveBeenCalledWith({ target: 'remote' });
        expect(JSON.stringify(onSwitch.mock.calls)).not.toContain('do not expose this payload');

        subscription.unsubscribe();
        await expect(handlers.get('switch')?.({ to: 'local' })).resolves.toBe(false);
        expect(onSwitch).toHaveBeenCalledTimes(1);
    });
});
