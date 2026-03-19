import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backMock = vi.fn();
const replaceMock = vi.fn();
const canGoBackMock = vi.fn(() => false);

let onSuccessCallback: (() => void) | null = null;

const roundButtonHandlers: Record<string, () => void> = {};

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({
        back: backMock,
        canGoBack: canGoBackMock,
        replace: replaceMock,
    }),
}));

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

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'web' },
}));

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
    RoundButton: (props: { testID?: string; onPress?: () => void }) => {
        if (props?.testID && typeof props.onPress === 'function') {
            roundButtonHandlers[props.testID] = props.onPress;
        }
        return null;
    },
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
    beforeEach(() => {
        backMock.mockClear();
        replaceMock.mockClear();
        canGoBackMock.mockClear();
        onSuccessCallback = null;
        for (const key of Object.keys(roundButtonHandlers)) {
            delete roundButtonHandlers[key];
        }
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

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(typeof onSuccessCallback).toBe('function');
        onSuccessCallback?.();

        expect(backMock).not.toHaveBeenCalled();
        expect(replaceMock).toHaveBeenCalledWith('/terminal');
    });

    it('falls back to replace(/terminal) when router cannot go back (reject)', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(typeof roundButtonHandlers['terminal-connect-reject']).toBe('function');
        roundButtonHandlers['terminal-connect-reject']?.();

        expect(backMock).not.toHaveBeenCalled();
        expect(replaceMock).toHaveBeenCalledWith('/terminal');
    });
});
