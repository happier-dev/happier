import { describe, expect, it, vi } from 'vitest';

import { createPluginHostedWebNativeMessageBridge } from './nativeMessageBridge';

const frameOrigin = 'happier-hosted-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('hosted-web native bridge message adapter', () => {
    it('accepts a message only from the exact token-scoped iOS frame origin', () => {
        const onMessage = vi.fn();
        const bridgeInput = {
            fallbackFrameUrl: `${frameOrigin}/`,
            bridge: {
                expectedOrigin: frameOrigin,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'preview-web',
                expectedSurfaceId: 'preview-surface',
                expectedNonce: 'nonce-1',
                expectedSessionId: 'session-1',
                allowedMessageKinds: new Set(['ready']),
                onMessage,
            },
        };
        const onNativeMessage = createPluginHostedWebNativeMessageBridge(
            bridgeInput as Parameters<typeof createPluginHostedWebNativeMessageBridge>[0],
        );
        const message = JSON.stringify({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'preview-surface',
            nonce: 'nonce-1',
            sequence: 1,
            kind: 'ready',
            payload: null,
        });

        onNativeMessage({ nativeEvent: { data: message } });
        onNativeMessage({ nativeEvent: { url: `${frameOrigin}/index.html`, data: message } });
        onNativeMessage({ nativeEvent: { url: 'happier-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html', data: message } });

        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
    });
});
