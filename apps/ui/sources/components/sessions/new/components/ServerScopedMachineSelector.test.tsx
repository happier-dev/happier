import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';


import type { ServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedItemProps: Array<Readonly<Record<string, unknown>>> = [];

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: () => null,
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#666',
                },
            },
        });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Readonly<Record<string, unknown>>) => {
        capturedItemProps.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('Text', null, children),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: (machine: { active?: boolean | null }) => Boolean(machine.active),
}));

describe('ServerScopedMachineSelector', () => {
    it('assigns stable option and readiness test IDs when a prefix is provided for grouped machine rows', async () => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const machine = {
            id: 'machine-1',
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
            spawnReadinessStatus: 'ready',
            metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
        } as ServerScopedMachine;

        capturedItemProps.length = 0;

        await renderScreen(React.createElement(ServerScopedMachineSelector, {
                    groups: [
                        {
                            serverId: 'server-b',
                            serverName: 'Server B',
                            loading: false,
                            signedOut: false,
                            machines: [machine],
                        },
                        {
                            serverId: 'server-c',
                            serverName: 'Server C',
                            loading: false,
                            signedOut: false,
                            machines: [],
                        },
                    ],
                    selectedMachineId: 'machine-1',
                    selectedServerId: 'server-b',
                    onSelect: vi.fn(),
                    testIdPrefix: 'new-session-machine',
                }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'new-session-machine-option:machine-1',
            detailTestID: 'new-session-machine-readiness:machine-1',
            selected: true,
        }));
    });

    it('keeps a broadly online machine selectable while exact spawn readiness is unresolved', async () => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const onSelect = vi.fn();
        const machine = {
            id: 'machine-unknown',
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
            spawnReadinessStatus: 'unknown',
            metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
        } as ServerScopedMachine;

        capturedItemProps.length = 0;

        await renderScreen(React.createElement(ServerScopedMachineSelector, {
            groups: [{
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines: [machine],
            }],
            selectedMachineId: null,
            selectedServerId: null,
            onSelect,
            testIdPrefix: 'new-session-machine',
        }));

        const item = capturedItemProps.find((props) => props.testID === 'new-session-machine-option:machine-unknown');
        expect(item).toEqual(expect.objectContaining({
            detail: 'status.online',
            disabled: false,
        }));

        (item?.onPress as (() => void) | undefined)?.();

        expect(onSelect).toHaveBeenCalledWith(machine);
    });

    it.each(['rpcUnavailable', 'keyUnavailable'] as const)(
        'marks transport-online machines unavailable when exact spawn readiness is %s',
        async (spawnReadinessStatus) => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const onSelect = vi.fn();
        const machine = {
            id: `machine-${spawnReadinessStatus}`,
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
            spawnReadinessStatus,
            metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
        } as ServerScopedMachine;

        capturedItemProps.length = 0;

        await renderScreen(React.createElement(ServerScopedMachineSelector, {
            groups: [{
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines: [machine],
            }],
            selectedMachineId: null,
            selectedServerId: null,
            onSelect,
            testIdPrefix: 'new-session-machine',
        }));

        const item = capturedItemProps.find((props) => props.testID === `new-session-machine-option:machine-${spawnReadinessStatus}`);
        expect(item).toEqual(expect.objectContaining({
            detail: 'common.unavailable',
            disabled: true,
        }));

        (item?.onPress as (() => void) | undefined)?.();

        expect(onSelect).not.toHaveBeenCalled();
    });
});
