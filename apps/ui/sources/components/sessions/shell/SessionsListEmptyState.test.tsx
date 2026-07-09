import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildMachineSetupWizardHref } from '@/utils/routes/setupWizardHref';
import type { Machine } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

let machinesMock: Machine[] = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            text: '#111',
            textSecondary: '#777',
            divider: '#ddd',
            surfaceHigh: '#f5f5f5',
            groupped: { background: '#fff' },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => typeof params?.machine === 'string' ? `${key}:${params.machine}` : key,
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/sync/runtime/resolvePublicReleaseRing', () => ({
    resolveCliInvokerNameForCurrentApp: () => 'hdev',
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => machinesMock,
    });
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function createMachine(params: Readonly<{
    id: string;
    host: string;
    active?: boolean;
    activeAt?: number;
}>): Machine {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: params.active ?? true,
        activeAt: params.activeAt ?? Date.now(),
        metadata: {
            host: params.host,
            platform: 'darwin',
            happyCliVersion: '0',
            happyHomeDir: '/tmp/.happy',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function flattenTextValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(flattenTextValue).join('');
    }
    if (value == null || typeof value === 'boolean') {
        return '';
    }
    if (typeof value === 'object' && 'props' in (value as Record<string, unknown>)) {
        return flattenTextValue((value as { props?: { children?: unknown } }).props?.children);
    }
    return String(value);
}

describe('SessionsListEmptyState', () => {
    beforeEach(() => {
        standardCleanup();
        routerPushSpy.mockReset();
        machinesMock = [];
    });

    it('renders one start-session action per online machine and keeps the CLI guidance inline', async () => {
        const nowMs = Date.now();
        machinesMock = [
            createMachine({ id: 'm-online', host: 'leeroy-mbp', active: true, activeAt: nowMs }),
            createMachine({ id: 'm-offline', host: 'studio-mac', active: true, activeAt: nowMs - (2 * 60_000) }),
        ];

        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderScreen(<SessionsListEmptyState kind="create_session" targetLabel="leeroy-mbp" />);

        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.startSessionOnMachine:leeroy-mbp'),
        ).toBe(true);
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.startSessionOnMachineSubtitle'),
        ).toBe(true);
        expect(() => screen.findByProps({ testID: 'sessions-empty-state-machine:m-offline' })).toThrow();
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children).includes('hdev')),
        ).toBe(true);
    });

    it('routes the machine action into the new-session flow with machine and server context', async () => {
        machinesMock = [
            createMachine({ id: 'm-online', host: 'leeroy-mbp' }),
        ];

        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderScreen(<SessionsListEmptyState kind="create_session" targetLabel="leeroy-mbp" />);

        await screen.pressByTestIdAsync('sessions-empty-state-machine:m-online');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'm-online',
                spawnServerId: 'server-1',
            },
        });
    });

    it('renders the connect action below the tile for never-connected accounts and routes it to the setup wizard', async () => {
        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderScreen(<SessionsListEmptyState kind="connect_machine" targetLabel="leeroy-mbp" />);

        expect(screen.findByProps({ testID: 'session-getting-started-kind-connect_machine' })).toBeTruthy();
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.connectMachineActionSubtitle'),
        ).toBe(true);
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.reconnectMachineActionSubtitle'),
        ).toBe(false);

        await screen.pressByTestIdAsync('sessions-empty-state-open-setup');

        expect(routerPushSpy).toHaveBeenCalledWith(buildMachineSetupWizardHref({
            action: 'local',
            step: 'setup_this_computer',
        }));
    });

    it('renders the reconnect action below the tile when a machine exists but is offline', async () => {
        machinesMock = [
            createMachine({ id: 'm-offline', host: 'leeroy-mbp', active: false, activeAt: Date.now() - (10 * 60_000) }),
        ];

        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderScreen(<SessionsListEmptyState kind="start_daemon" targetLabel="leeroy-mbp" />);

        expect(screen.findByProps({ testID: 'session-getting-started-kind-start_daemon' })).toBeTruthy();
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.reconnectMachineActionSubtitle'),
        ).toBe(true);

        await screen.pressByTestIdAsync('sessions-empty-state-open-setup');

        expect(routerPushSpy).toHaveBeenCalledWith(buildMachineSetupWizardHref({
            action: 'local',
            step: 'setup_this_computer',
        }));
    });

    it('renders select-session as the browse-style summary without setup actions', async () => {
        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderScreen(<SessionsListEmptyState kind="select_session" targetLabel="leeroy-mbp" />);

        expect(screen.findByProps({ testID: 'session-getting-started-kind-select_session' })).toBeTruthy();
        expect(screen.findByTestId('sessions-empty-state-summary')).not.toBeNull();
        expect(screen.findByTestId('sessions-empty-state-title')).not.toBeNull();
        expect(screen.findByTestId('sessions-empty-state-description')).not.toBeNull();
        expect(screen.findByTestId('sessions-empty-state-open-setup')).toBeNull();
        expect(() => screen.findByProps({ testID: 'sessions-empty-state-machine:m-online' })).toThrow();
    });
});
