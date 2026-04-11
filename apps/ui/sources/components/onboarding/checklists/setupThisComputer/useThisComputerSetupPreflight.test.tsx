import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';

import { renderScreen } from '@/dev/testkit';

const activeServerState = vi.hoisted(() => {
    let listener: ((snapshot: any) => void) | null = null;
    let snapshot = {
        serverId: 'server-1',
        serverUrl: 'https://relay-1.example.test',
        activeLocalRelayUrl: null,
        activeShareableServerUrl: null,
        generation: 1,
    };
    return {
        getSnapshot: () => snapshot,
        setSnapshot: (next: any) => {
            snapshot = next;
            listener?.(next);
        },
        subscribe: (nextListener: (next: any) => void) => {
            listener = nextListener;
            return () => {
                if (listener === nextListener) {
                    listener = null;
                }
            };
        },
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storageStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storageStore')>();
    return {
        ...actual,
        storage: (selector: (state: any) => unknown) => selector({ profile: { id: 'acct_1' } }),
    };
});

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: {
            serviceInstalled: true,
            daemonRunning: true,
            machineId: 'machine_1',
            needsAuth: false,
            daemonServerUrl: 'https://relay-1.example.test',
            daemonComparableKey: 'key_1',
            daemonAccountId: 'acct_1',
            daemonMachineRegistered: true,
        },
    }),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.getSnapshot(),
    subscribeActiveServer: (listener: (snapshot: any) => void) => activeServerState.subscribe(listener),
}));

describe('useThisComputerSetupPreflight', () => {
    it('reacts to active server changes', async () => {
        const { useThisComputerSetupPreflight } = await import('./useThisComputerSetupPreflight');

        function Harness() {
            const preflight = useThisComputerSetupPreflight();
            return (
                <>
                    <Text testID="preflight-active-relay">
                        {preflight.activeRelayUrl ?? ''}
                    </Text>
                    <Text testID="preflight-local-cli">
                        {preflight.localCliReady === true ? 'ready' : 'missing'}
                    </Text>
                </>
            );
        }

        const screen = await renderScreen(<Harness />);
        const firstNode = screen.findByTestId('preflight-active-relay');
        if (!firstNode) {
            throw new Error('Expected active relay node');
        }
        expect(firstNode.props.children).toBe('https://relay-1.example.test');
        expect(screen.findByTestId('preflight-local-cli')?.props.children).toBe('ready');

        await act(async () => {
            activeServerState.setSnapshot({
                ...activeServerState.getSnapshot(),
                serverUrl: 'https://relay-2.example.test',
                generation: 2,
            });
        });

        const secondNode = screen.findByTestId('preflight-active-relay');
        if (!secondNode) {
            throw new Error('Expected active relay node');
        }
        expect(secondNode.props.children).toBe('https://relay-2.example.test');
    });
});
