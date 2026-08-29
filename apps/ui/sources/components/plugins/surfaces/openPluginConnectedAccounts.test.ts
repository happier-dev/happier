import { describe, expect, it, vi } from 'vitest';

import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import { createPluginOpenConnectedAccountsHostApiHandler } from './openPluginConnectedAccounts';

const surface = {
    pluginId: 'acme.source',
    contributionId: 'settings',
    surfaceId: 'settings:acme.source:settings',
    placement: 'settings',
    platform: 'web',
    channel: 'internal',
} as const;

function request(payload: unknown): PluginUiHostApiRequestEnvelopeV1 {
    return {
        wireVersion: 1,
        kind: 'request',
        identity: {
            pluginId: surface.pluginId,
            pluginVersion: '1.0.0',
            viewId: 'settings',
            generation: 'generation-1',
        },
        requestId: 'request-1',
        method: 'openConnectedAccounts',
        surface,
        payload,
    } as unknown as PluginUiHostApiRequestEnvelopeV1;
}

describe('createPluginOpenConnectedAccountsHostApiHandler', () => {
    it('forwards only a validated semantic service/account request', async () => {
        const open = vi.fn(async () => undefined);
        const handler = createPluginOpenConnectedAccountsHostApiHandler(open);
        const payload = {
            service: { pluginId: 'happier.scm.github', localId: 'github-account' },
            accountId: 'github:work',
        };

        await expect(handler(request(payload))).resolves.toBeNull();
        expect(open).toHaveBeenCalledWith(payload);

        const invalid = await handler(request({ accountId: 'unqualified' }));
        expect(invalid).toMatchObject({ code: 'invalid_payload' });
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('refuses navigation after the mount retires', async () => {
        const open = vi.fn(async () => undefined);
        const handler = createPluginOpenConnectedAccountsHostApiHandler(open, () => false);

        await expect(handler(request({}))).resolves.toMatchObject({ code: 'stale_surface' });
        expect(open).not.toHaveBeenCalled();
    });
});
