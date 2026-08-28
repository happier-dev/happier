import { describe, expect, it, vi } from 'vitest';

import { createPluginEventAutomationSetupSurfaceBinding } from './presentPluginEventAutomationSetupSurface';

function request(payload: unknown) {
    return {
        version: 1,
        requestId: 'request-setup-1',
        surface: { pluginId: 'acme.events', contributionId: 'repository-picker' },
        method: 'settleEphemeralInput',
        payload,
    } as never;
}

describe('createPluginEventAutomationSetupSurfaceBinding', () => {
    it('settles the exact ephemeral mount once with strict completed input', async () => {
        let settled = false;
        const settle = vi.fn(() => { settled = true; });
        const binding = createPluginEventAutomationSetupSurfaceBinding({
            isSettled: () => settled,
            settle,
        });
        const bundle = binding.createMountedHostApiHandlers?.({ isCurrent: () => true });
        const handler = bundle?.handlers.settleEphemeralInput;
        if (!handler) throw new Error('expected ephemeral settlement handler');

        await expect(Promise.resolve(handler(request({
            kind: 'completed',
            input: { repository: 'happier-dev/happier' },
        })))).resolves.toBeNull();
        expect(settle).toHaveBeenCalledExactlyOnceWith({
            kind: 'completed',
            input: { repository: 'happier-dev/happier' },
        });

        await expect(Promise.resolve(handler(request({ kind: 'cancelled' })))).resolves.toMatchObject({
            code: 'stale_surface',
        });
        expect(settle).toHaveBeenCalledOnce();
    });

    it('rejects malformed input and a retired mount without settling', async () => {
        const settle = vi.fn();
        const current = createPluginEventAutomationSetupSurfaceBinding({
            isSettled: () => false,
            settle,
        }).createMountedHostApiHandlers?.({ isCurrent: () => true });
        const retired = createPluginEventAutomationSetupSurfaceBinding({
            isSettled: () => false,
            settle,
        }).createMountedHostApiHandlers?.({ isCurrent: () => false });

        await expect(Promise.resolve(current?.handlers.settleEphemeralInput?.(request({
            kind: 'completed',
            input: undefined,
        })))).resolves.toMatchObject({ code: 'invalid_payload' });
        await expect(Promise.resolve(retired?.handlers.settleEphemeralInput?.(request({
            kind: 'cancelled',
        })))).resolves.toMatchObject({ code: 'stale_surface' });
        expect(settle).not.toHaveBeenCalled();
    });
});
