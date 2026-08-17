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

    it('keeps a structurally ready machine selectable without synthetic spawn readiness', async () => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const onSelect = vi.fn();
        const machine = {
            id: 'machine-unknown',
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
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

    it('accepts an owner-supplied unavailable presentation without creating another picker', async () => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const onSelect = vi.fn();
        const machine = {
            id: 'machine-locked',
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
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
            selectedMachineId: 'machine-locked',
            selectedServerId: 'server-b',
            onSelect,
            resolveMachineAvailability: () => ({ detail: 'common.unavailable', selectable: false }),
            testIdPrefix: 'administration-machine',
        }));

        const item = capturedItemProps.find((props) => props.testID === 'administration-machine-option:machine-locked');
        expect(item).toEqual(expect.objectContaining({
            detail: 'common.unavailable',
            disabled: true,
            selected: true,
        }));

        (item?.onPress as (() => void) | undefined)?.();

        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps same-machine domain rows distinct through owner-supplied exact keys and selection', async () => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        type MaterializedServerScopedMachine = ServerScopedMachine & Readonly<{
            materializationId: string;
        }>;
        const baseMachine = {
            id: 'machine-shared',
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
            metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
        } as ServerScopedMachine;
        const machines: MaterializedServerScopedMachine[] = [
            { ...baseMachine, materializationId: 'materialization-a' },
            { ...baseMachine, materializationId: 'materialization-b' },
        ];

        capturedItemProps.length = 0;

        await renderScreen(React.createElement(ServerScopedMachineSelector<MaterializedServerScopedMachine>, {
            groups: [{
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines,
            }],
            selectedMachineId: 'machine-shared',
            selectedServerId: 'server-b',
            onSelect: vi.fn(),
            getMachineKey: (machine) => machine.materializationId,
            isMachineSelected: (machine) => machine.materializationId === 'materialization-b',
            testIdPrefix: 'plugin-origin',
        }));

        expect(capturedItemProps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                testID: 'plugin-origin-option:materialization-a',
                selected: false,
            }),
            expect.objectContaining({
                testID: 'plugin-origin-option:materialization-b',
                selected: true,
            }),
        ]));
    });

    it.each([
        ['revoked', { revokedAt: Date.now() }, 'common.unavailable'],
        ['replaced', { replacedByMachineId: 'machine-current' }, 'common.unavailable'],
        ['offline', { active: false, activeAt: 0 }, 'status.offline'],
    ] as const)(
        'marks structurally %s machines unavailable',
        async (stateName, machineState, expectedDetail) => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const onSelect = vi.fn();
        const machine = {
            id: `machine-${stateName}`,
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
            ...machineState,
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

        const item = capturedItemProps.find((props) => props.testID === `new-session-machine-option:machine-${stateName}`);
        expect(item).toEqual(expect.objectContaining({
            detail: expectedDetail,
            disabled: true,
        }));

        (item?.onPress as (() => void) | undefined)?.();

        expect(onSelect).not.toHaveBeenCalled();
    });
});
