import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const hostedPluginTargetProps: unknown[] = [];
const desktopArtifactHostProps: unknown[] = [];
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

vi.mock('@/components/browser/adapters/HostedPluginTarget.web', () => ({
    HostedPluginTarget: (props: Record<string, unknown>) => {
        hostedPluginTargetProps.push(props);
        return React.createElement('HostedPluginTargetMock', { testID: props.testID });
    },
}));

vi.mock('./PluginHostedArtifactDesktopViewHost', () => ({
    PluginHostedArtifactDesktopViewHost: (props: Record<string, unknown>) => {
        desktopArtifactHostProps.push(props);
        return React.createElement('PluginHostedArtifactDesktopViewHostMock', { testID: props.testID });
    },
}));

describe('PluginHostedWebFrame web contract', () => {
    afterEach(() => {
        hostedPluginTargetProps.length = 0;
        desktopArtifactHostProps.length = 0;
    });

    it('passes the complete hosted-web security policy to the browser adapter target', async () => {
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.web');

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

    it('forwards the browser Artifact opaque-frame transport flag only to the URL target', async () => {
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.web');
        const onUnexpectedNavigation = vi.fn();

        await renderScreen(<PluginHostedWebFrame
            title="Preview"
            url="https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/"
            sandbox={{
                scripts: true,
                sameOrigin: false,
                popups: false,
                topNavigation: false,
                mixedContent: false,
            }}
            security={security}
            opaqueArtifactFrame
            onUnexpectedNavigation={onUnexpectedNavigation}
            testID="plugin-hosted-web-frame"
        />);

        expect(hostedPluginTargetProps.at(-1)).toMatchObject({
            opaqueArtifactFrame: true,
            onUnexpectedNavigation,
            testID: 'plugin-hosted-web-frame',
        });
        expect(desktopArtifactHostProps).toHaveLength(0);
    });

    it('routes a registered desktop Artifact to the direct Wry host without requiring a URL', async () => {
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.web');
        const onNativeArtifactHistoryStateChange = vi.fn();
        const onNativeArtifactGoBackResult = vi.fn();

        await renderScreen(<PluginHostedWebFrame
            title="Preview"
            sandbox={{
                scripts: true,
                sameOrigin: false,
                popups: false,
                topNavigation: false,
                mixedContent: false,
            }}
            security={security}
            desktopArtifact={{
                artifactHandleToken: 'hpat_test_token',
                initialPathAndQuery: '/index.html',
            }}
            navigationCommand={{ commandId: 'desktop-history-back-1', kind: 'goBack' }}
            onNativeArtifactHistoryStateChange={onNativeArtifactHistoryStateChange}
            onNativeArtifactGoBackResult={onNativeArtifactGoBackResult}
            testID="plugin-hosted-web-frame"
        />);

        expect(desktopArtifactHostProps.at(-1)).toMatchObject({
            artifact: {
                artifactHandleToken: 'hpat_test_token',
                initialPathAndQuery: '/index.html',
            },
            navigationCommand: { commandId: 'desktop-history-back-1', kind: 'goBack' },
            onNativeArtifactHistoryStateChange,
            onNativeArtifactGoBackResult,
            testID: 'plugin-hosted-web-frame',
        });
        expect(hostedPluginTargetProps).toHaveLength(0);
    });

});
