import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    searchParams: { serviceId: 'anthropic', profileId: 'work' } as ExpoRouterParams,
    routerPushSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    unsupportedSpy: vi.fn((props: Record<string, unknown>) =>
        React.createElement('OAuthViewUnsupported', props),
    ),
    pasteSpy: vi.fn((props: Record<string, unknown>) =>
        React.createElement('ConnectedServiceOauthPasteView', props),
    ),
    deviceAuthSpy: vi.fn((props: Record<string, unknown>) =>
        React.createElement('OpenAiCodexDeviceAuthView', props),
    ),
    embeddedSpy: vi.fn((props: Record<string, unknown>) =>
        React.createElement('ConnectedServiceOauthEmbeddedView', props),
    ),
}));

installConnectedServicesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: shared.routerBackSpy, push: shared.routerPushSpy },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => shared.searchParams,
            useGlobalSearchParams: () => shared.searchParams,
        };
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    getConnectedServiceRegistryEntry: (serviceId: string) => ({
        serviceId,
        connectCommand: `happier connect ${serviceId}`,
        supportsOauth: serviceId !== 'anthropic',
        oauthAddActionModes:
            serviceId === 'openai-codex'
                ? ['device', 'paste', 'browser']
                : serviceId === 'claude-subscription'
                    ? ['paste']
                    : ['paste'],
    }),
}));

vi.mock('@/sync/domains/connectedServices/oauth/connectedServiceOauthAdapters', () => ({
    getConnectedServiceOauthAdapter: (serviceId: string) => ({
        serviceId,
        defaultRedirectUri: 'http://localhost/cb',
        buildAuthorizationUrl: () => 'https://example.com/oauth',
        exchangeAuthorizationCodeForRecord: async () => ({}),
    }),
}));

vi.mock('@/components/ui/navigation/OAuthView', () => ({
    OAuthView: () => React.createElement('OAuthView'),
    OAuthViewUnsupported: shared.unsupportedSpy,
}));

vi.mock('./ConnectedServiceOauthPasteView', () => ({
    ConnectedServiceOauthPasteView: shared.pasteSpy,
}));

vi.mock('./oauth/openai/OpenAiCodexDeviceAuthView', () => ({
    OpenAiCodexDeviceAuthView: shared.deviceAuthSpy,
}));

vi.mock('./oauth/ConnectedServiceOauthEmbeddedView', () => ({
    ConnectedServiceOauthEmbeddedView: shared.embeddedSpy,
}));

describe('ConnectedServiceOauthView mode selection', () => {
    it('renders unsupported when the service does not support oauth', async () => {
        shared.searchParams = { serviceId: 'anthropic', profileId: 'work' };
        vi.clearAllMocks();
        const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

        await renderScreen(<ConnectedServiceOauthView />);

        expect(shared.unsupportedSpy).toHaveBeenCalledTimes(1);
        expect(shared.pasteSpy).not.toHaveBeenCalled();
    });

    it('uses paste fallback for openai-codex device auth on native', async () => {
        shared.searchParams = { serviceId: 'openai-codex', profileId: 'work' };
        vi.clearAllMocks();

        const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

        await renderScreen(<ConnectedServiceOauthView />);

        expect(shared.deviceAuthSpy).toHaveBeenCalledTimes(1);
        const deviceProps = shared.deviceAuthSpy.mock.calls[0]?.[0] as
            | { fallbackAction?: { onPress?: () => void } }
            | undefined;
        expect(deviceProps?.fallbackAction?.onPress).toBeTypeOf('function');

        deviceProps?.fallbackAction?.onPress?.();

        expect(shared.routerPushSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                params: expect.objectContaining({ method: 'paste' }),
            }),
        );
    });

    it('supports embedded oauth for claude-subscription when explicitly requested on native', async () => {
        shared.searchParams = { serviceId: 'claude-subscription', profileId: 'work', method: 'browser' };
        vi.clearAllMocks();
        const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

        await renderScreen(<ConnectedServiceOauthView />);

        expect(shared.embeddedSpy).toHaveBeenCalledTimes(1);
        expect(shared.pasteSpy).not.toHaveBeenCalled();
    });

    it('supports embedded oauth for openai-codex when explicitly requested on native', async () => {
        shared.searchParams = { serviceId: 'openai-codex', profileId: 'work', method: 'browser' };
        vi.clearAllMocks();
        const { ConnectedServiceOauthView } = await import('./ConnectedServiceOauthView');

        await renderScreen(<ConnectedServiceOauthView />);

        expect(shared.embeddedSpy).toHaveBeenCalledTimes(1);
        expect(shared.deviceAuthSpy).not.toHaveBeenCalled();
    });
});
