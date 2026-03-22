import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createExpoRouterMock,
    createStackOptionsCapture,
} from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineExecutionRunsListArgs = [string, Record<string, unknown>?];

const machineExecutionRunsListSpy = vi.fn(async (..._args: MachineExecutionRunsListArgs) => ({
    ok: true as const,
    runs: [],
}));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerNavigateSpy = vi.fn();
const stackOptionsCapture = createStackOptionsCapture();
const routerMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: routerReplaceSpy,
        setParams: vi.fn(),
    },
    stackOptionsCapture,
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', () => ({
    ...routerMock.module,
    useRouter: () => ({
        ...routerMock.state.router,
        navigate: routerNavigateSpy,
    }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            surface: '#111',
            surfaceHigh: '#222',
            divider: '#333',
            text: '#eee',
            textSecondary: '#aaa',
            header: { tint: '#eee' },
            status: { error: '#f00' },
            shadow: { color: '#000', opacity: 0.2 },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (_props: any) => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/layout/ConstrainedScreenContent', () => ({
    ConstrainedScreenContent: (props: any) =>
        React.createElement('ConstrainedScreenContent', { ...props, testID: 'runs-constrained-screen-content' }, props.children),
}));

vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({
    ExecutionRunRow: (_props: any) => null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
    machineExecutionRunsList: (...args: MachineExecutionRunsListArgs) => machineExecutionRunsListSpy(...args),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('@/sync/ops/machines', () => ({
    machineStopSession: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const machines = [
        {
            id: 'machine-1',
            active: true,
            createdAt: 1,
            updatedAt: 1,
            activeAt: Date.now(),
            metadata: { host: 'a.local', happyCliVersion: '1.0.0', happyHomeDir: '/tmp', homeDir: '/tmp' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
            seq: 0,
        },
    ];
    const machineListByServerId = { 'server-a': machines as any };
    const machineListStatusByServerId = { 'server-a': 'idle' as const };
    return createPartialStorageModuleMock(importOriginal, {
        useMachineListByServerId: () => machineListByServerId,
        useMachineListStatusByServerId: () => machineListStatusByServerId,
        useSetting: () => false,
    });
});

vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));

describe('Runs screen', () => {
    let Screen: React.ComponentType<any>;

    beforeEach(async () => {
        Screen = (await import('@/app/(app)/runs')).default;
        machineExecutionRunsListSpy.mockClear();
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        routerNavigateSpy.mockClear();
        stackOptionsCapture.reset();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderRunsScreen() {
        const screen = await renderScreen(<Screen />);
        await flushHookEffects({ cycles: 2 });
        return screen;
    }

    async function renderHeaderRight() {
        const options = stackOptionsCapture.getResolved();
        expect(options?.headerTitle).toBe('runs.title');
        expect(typeof options?.headerRight).toBe('function');
        return renderScreen(React.createElement(options!.headerRight as React.ComponentType));
    }

    it('configures a header title and right-side icon actions', async () => {
        await renderRunsScreen();

        const headerRightScreen = await renderHeaderRight();
        expect(headerRightScreen.findByProps({ accessibilityLabel: 'runs.a11y.refresh' })).toBeTruthy();
        expect(headerRightScreen.findByProps({ accessibilityLabel: 'runs.a11y.toggleFinished' })).toBeTruthy();
    });

    it('renders runs inside the constrained route content wrapper', async () => {
        const screen = await renderRunsScreen();

        expect(screen.findByTestId('runs-constrained-screen-content')).toBeTruthy();
    });

    it('lists daemon execution runs for machines in the server-scoped machine cache', async () => {
        await renderRunsScreen();

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
    });
});
