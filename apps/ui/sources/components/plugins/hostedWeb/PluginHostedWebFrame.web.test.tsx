import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const hostedPluginTargetProps: unknown[] = [];

vi.mock('@/components/browser/adapters/HostedPluginTarget.web', () => ({
    HostedPluginTarget: (props: Record<string, unknown>) => {
        hostedPluginTargetProps.push(props);
        return React.createElement('HostedPluginTargetMock', { testID: props.testID });
    },
}));

describe('PluginHostedWebFrame web contract', () => {
    it('passes the complete hosted-web security policy to the browser adapter target', async () => {
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.web');
        const security = {
            allowedNavigationOrigins: ['https://docs.example.test'],
            allowedCallbackOrigins: ['https://oauth.example.test'],
            allowedConnectOrigins: ['https://api.example.test'],
            sourceMaps: 'disabled',
            mixedContent: 'deny',
            csp: {
                scriptSrc: 'selfOnly',
                styleSrc: 'selfOnly',
                imgSrc: 'selfOnly',
                fontSrc: 'selfOnly',
                connectSrc: 'declaredOrigins',
                allowDataUrls: false,
                allowBlobUrls: false,
                allowInlineStyles: false,
                allowEval: false,
            },
        } satisfies PluginHostedWebSecurityPolicyV1;

        await renderScreen(<PluginHostedWebFrame
            title="Preview"
            url="https://preview.happier.test/plugin/acme/"
            sandbox={{
                scripts: true,
                sameOrigin: false,
                popups: false,
                topNavigation: false,
                mixedContent: false,
            }}
            security={security}
            testID="plugin-hosted-web-frame"
        />);

        expect(hostedPluginTargetProps.at(-1)).toMatchObject({
            title: 'Preview',
            url: 'https://preview.happier.test/plugin/acme/',
            security,
            testID: 'plugin-hosted-web-frame',
        });
    });
});
