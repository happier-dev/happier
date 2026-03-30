import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

const tauriDesktopState = vi.hoisted(() => ({
    desktop: false,
    pickedPath: null as string | null,
}));

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('Group', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.desktop,
    invokeTauri: async (_command: string) => tauriDesktopState.pickedPath,
}));

describe('RemoteSshMachineSetupSection web fallback', () => {
    beforeEach(() => {
        tauriDesktopState.desktop = false;
        tauriDesktopState.pickedPath = null;
        activeServerSnapshot.serverId = 'relay-example';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.activeLocalRelayUrl = null;
        activeServerSnapshot.generation = 1;
    });

    it('shows a desktop-only notice on browser web instead of the SSH bootstrap form', async () => {
        tauriDesktopState.desktop = false;
        const { RemoteSshMachineSetupSection } = await import('./RemoteSshMachineSetupSection');
        const screen = await renderScreen(React.createElement(RemoteSshMachineSetupSection, {
            expanded: true,
            runner: {
                mode: 'tauri' as const,
                async start() {
                    return 'task-1';
                },
                async cancel() {},
                async respond() {},
                subscribe() {
                    return () => {};
                },
                getSnapshot() {
                    return null;
                },
            },
        }));

        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')).toBeTruthy();
        expect(screen.findByTestId('settings.machineSetup.remoteSshTargetInput')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.remoteIdentityFileInput')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.remoteChooseIdentityFile')).toBeNull();
    });

    it('lets the user pick a key-file path in Tauri on web', async () => {
        tauriDesktopState.desktop = true;
        tauriDesktopState.pickedPath = 'file:///Users/leeroy/.ssh/id_ed25519';

        const { RemoteSshMachineSetupSection } = await import('./RemoteSshMachineSetupSection');
        const screen = await renderScreen(React.createElement(RemoteSshMachineSetupSection, {
            expanded: true,
            runner: {
                mode: 'tauri' as const,
                async start() {
                    return 'task-1';
                },
                async cancel() {},
                async respond() {},
                subscribe() {
                    return () => {};
                },
                getSnapshot() {
                    return null;
                },
            },
        }));

        await screen.pressByTestIdAsync('settings.machineSetup.remoteAuth.keyfile');
        await screen.pressByTestIdAsync('settings.machineSetup.remoteChooseIdentityFile');

        expect(screen.findByTestId('settings.machineSetup.remoteIdentityFileInput')?.props.value).toBe('/Users/leeroy/.ssh/id_ed25519');
    });
});
