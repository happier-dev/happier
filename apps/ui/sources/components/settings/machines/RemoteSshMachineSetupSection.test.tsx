import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';

const openIdentityFilePickerSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
                select: (options: Record<string, unknown>) => options?.ios ?? options?.native ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
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
    AttachmentFilePicker: React.forwardRef(function AttachmentFilePickerMock(props: Record<string, unknown>, ref) {
        React.useImperativeHandle(ref, () => ({
            open: () => openIdentityFilePickerSpy(props),
            openFiles: () => openIdentityFilePickerSpy(props),
            openImages: () => {},
        }));
        return React.createElement('AttachmentFilePicker', props);
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

describe('RemoteSshMachineSetupSection', () => {
    beforeEach(() => {
        openIdentityFilePickerSpy.mockReset();
        modalAlertSpy.mockReset();
        activeServerSnapshot.serverId = 'relay-example';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.activeLocalRelayUrl = null;
        activeServerSnapshot.generation = 1;
    });

    it('opens the shared identity-file picker on native platforms and fills the path', async () => {
        openIdentityFilePickerSpy.mockImplementation((props: { onAttachmentsPicked?: (attachments: readonly unknown[]) => void }) => {
            props.onAttachmentsPicked?.([
                {
                    kind: 'native',
                    uri: 'file:///Users/leeroy/.ssh/id_ed25519',
                    name: 'id_ed25519',
                    sizeBytes: null,
                    mimeType: 'application/octet-stream',
                },
            ]);
        });

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

        expect(openIdentityFilePickerSpy).toHaveBeenCalled();
        expect(screen.findByTestId('settings.machineSetup.remoteIdentityFileInput')?.props.value).toBe('/Users/leeroy/.ssh/id_ed25519');
    });

    it('surfaces the underlying start error instead of misclassifying it as a bridge failure', async () => {
        const { RemoteSshMachineSetupSection } = await import('./RemoteSshMachineSetupSection');
        const screen = await renderScreen(React.createElement(RemoteSshMachineSetupSection, {
            expanded: true,
            runner: {
                mode: 'tauri' as const,
                async start() {
                    throw new Error('remote ssh bootstrap failed');
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

        const targetInput = screen.findByTestId('settings.machineSetup.remoteSshTargetInput');
        await renderer.act(async () => {
            targetInput?.props.onChangeText?.('root@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'remote ssh bootstrap failed');
    });
});
