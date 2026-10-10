import { describe, expect, it } from 'vitest';
import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';

const identity = { instanceId: 'page-mount', mountNonce: 'page-nonce' } as const;
const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'example.page', contributionId: 'overview', surfaceId: 'page-overview',
    placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
};

describe('hosted widget-area Host API admission', () => {
    it('does not advertise or dispatch native area operations, while ordinary widget Action transport remains available', async () => {
        const dispatched: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface, identity, requestIdPrefix: 'hosted-area',
            canonicalHostApi: { identity, surface: {}, methods: ['context', 'widgetArea', 'executeAction'] },
            // This is the mounted host transport boundary. The bridge, wire parser and method
            // negotiation remain real; no Artifact read or Action effect is claimed by this test.
            handleRequest: async request => { dispatched.push(request); return { accepted: true }; },
        });
        const envelope = (payload: PluginHostedWebBridgeEnvelopeV1['payload']): PluginHostedWebBridgeEnvelopeV1 => ({
            version: 1, identity, sequence: 1, kind: 'hostApi', payload,
        });
        await handler({ version: 1, identity, sequence: 0, kind: 'ready', payload: { ready: true } });
        await expect(handler(envelope({ wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1.0.0' })))
            .resolves.toMatchObject({ kind: 'result', payload: { kind: 'negotiated', methods: ['context', 'executeAction'] } });
        const operation = { actionId: 'widgets.item.remove', instanceId: 'copy' };
        await expect(handler(envelope({ wireVersion: 1, kind: 'request', identity, requestId: 'forged-area',
            method: 'widgetArea', payload: { area: 'pinned', operation } })))
            .resolves.toMatchObject({ kind: 'result', payload: { kind: 'error', error: { code: 'unsupported_method' } } });
        expect(dispatched).toEqual([]);
        await expect(handler(envelope({ wireVersion: 1, kind: 'request', identity, requestId: 'ordinary-widget-action',
            method: 'executeAction', payload: { action: 'widgets.item.remove', input: { ref: {
                surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'copy',
            } } } })))
            .resolves.toMatchObject({ kind: 'result', payload: { kind: 'result', result: { accepted: true } } });
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({ method: 'executeAction', payload: { action: 'widgets.item.remove' } });
        handler.dispose();
    });
});
