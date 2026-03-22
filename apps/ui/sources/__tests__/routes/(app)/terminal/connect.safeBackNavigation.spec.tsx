import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backMock = vi.fn();
const replaceMock = vi.fn();
const canGoBackMock = vi.fn(() => false);

let onSuccessCallback: (() => void) | null = null;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: {
            back: backMock,
            replace: replaceMock,
        },
        params: {},
        pathname: '/terminal/connect',
    });
    (
        routerMock.state.router as typeof routerMock.state.router & {
            canGoBack?: () => boolean;
        }
    ).canGoBack = canGoBackMock;
    return routerMock.module;
});

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (opts: { onSuccess?: () => void }) => {
        onSuccessCallback = typeof opts?.onSuccess === 'function' ? opts.onSuccess : null;
        return {
            processAuthUrl: vi.fn(async () => {}),
            isLoading: false,
        };
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, credentials: {} }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: vi.fn(async () => true),
}));

vi.mock('@/utils/path/terminalConnectUrl', () => ({
    buildTerminalConnectDeepLink: () => 'happier://terminal?key=abc123',
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => promise,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: 'View',
                                    Platform: {
                                        OS: 'web',
                                        select: (options: Record<string, unknown>) => options.web ?? options.default ?? options.ios ?? options.android,
                                    },
                                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: { testID?: string; onPress?: () => void }) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

describe('TerminalConnectScreen safe navigation', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        backMock.mockClear();
        replaceMock.mockClear();
        canGoBackMock.mockClear();
        onSuccessCallback = null;
        (globalThis as any).window = {
            location: {
                hash: '#key=abc123&server=https%3A%2F%2Fcompany.example.test',
                pathname: '/terminal/connect',
                search: '',
            },
            history: { replaceState: vi.fn() },
        };
    });

    it('falls back to replace(/terminal) when router cannot go back (success)', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await renderScreen(<Screen />);

        expect(typeof onSuccessCallback).toBe('function');
        await act(async () => {
            onSuccessCallback?.();
        });

        expect(backMock).not.toHaveBeenCalled();
        expect(replaceMock).toHaveBeenCalledWith('/terminal');
    });

    it('falls back to replace(/terminal) when router cannot go back (reject)', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByTestId('terminal-connect-reject')).not.toBeNull();
        await act(async () => {
            screen.pressByTestId('terminal-connect-reject');
        });

        expect(backMock).not.toHaveBeenCalled();
        expect(replaceMock).toHaveBeenCalledWith('/terminal');
    });
});
