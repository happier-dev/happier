import * as React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

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
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('Group', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

describe('SshCredentialsFields', () => {
    it('splits the SSH target into username, host, and port fields and masks password auth input', async () => {
        const onChange = vi.fn();
        const { SshCredentialsFields } = await import('./SshCredentialsFields');
        const screen = await renderScreen(React.createElement(SshCredentialsFields, {
            testIDPrefix: 'ssh-fields',
            value: {
                username: 'dev',
                host: 'example.test',
                port: '2222',
                authMode: 'password',
                identityFilePath: '',
                password: 'super-secret',
            },
            onChange,
        }));

        expect(screen.findByTestId('ssh-fields-sshUsernameInput')?.props.value).toBe('dev');
        expect(screen.findByTestId('ssh-fields-sshHostInput')?.props.value).toBe('example.test');
        expect(screen.findByTestId('ssh-fields-sshPortInput')?.props.value).toBe('2222');
        expect(screen.findByTestId('ssh-fields-sshAuthPassword')?.props.selected).toBe(true);
        expect(screen.findByTestId('ssh-fields-sshPasswordInput')?.props.value).toBe('super-secret');
        expect(screen.findByTestId('ssh-fields-sshPasswordInput')?.props.secureTextEntry).toBe(true);
        expect(screen.findByTestId('ssh-fields-sshIdentityFile')).toBeNull();

        screen.changeTextByTestId('ssh-fields-sshHostInput', 'admin@relay.example.test');
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            username: 'admin',
            host: 'relay.example.test',
        }));
    });

    it('renders the form layout without settings-style item groups', async () => {
        const onChange = vi.fn();
        const { SshCredentialsFields } = await import('./SshCredentialsFields');
        const screen = await renderScreen(React.createElement(SshCredentialsFields, {
            testIDPrefix: 'ssh-fields',
            layoutVariant: 'form',
            value: {
                username: 'dev',
                host: 'example.test',
                port: '2222',
                authMode: 'password',
                identityFilePath: '',
                password: 'super-secret',
            },
            onChange,
        }));

        expect(screen.findAllByType('Group' as never)).toHaveLength(0);
        expect(screen.findByTestId('ssh-fields-sshUsernameInput')).toBeTruthy();
        expect(screen.findByTestId('ssh-fields-sshHostInput')).toBeTruthy();
        expect(screen.findByTestId('ssh-fields-sshPortInput')).toBeTruthy();
        expect(screen.findByTestId('ssh-fields-sshPasswordInput')).toBeTruthy();
    });

    it('keeps every form authentication label at its content width in a horizontally reachable group', async () => {
        const onChange = vi.fn();
        const { SshCredentialsFields } = await import('./SshCredentialsFields');
        const screen = await renderScreen(React.createElement(SshCredentialsFields, {
            testIDPrefix: 'ssh-fields', layoutVariant: 'form',
            value: { username: 'dev', host: 'example.test', port: '22', authMode: 'agent', identityFilePath: '', password: '' },
            onChange,
        }));

        const authBar = screen.find((node) => node.props?.testIDPrefix === 'ssh-fields-sshAuthMethod' && Array.isArray(node.props?.tabs));
        expect(authBar.props.segmentSizing).toBe('content');
        expect(screen.findAll((node) => node.props?.horizontal === true && node.props?.testID === 'ssh-fields-sshAuthMethod-scroller')).toHaveLength(1);
        const password = screen.findHostByTestId('ssh-fields-sshAuthMethod:password')!;
        const surface = password.find((node) => node.type === 'View'
            && node.props.dataSet?.surface === 'tab-bar' && node.props.dataSet?.part === 'tab');
        const label = surface.findByType('Text' as never);
        const { paddingVertical = 0, borderWidth = 0, minHeight = 0 } = StyleSheet.flatten(surface.props.style);
        const { lineHeight } = StyleSheet.flatten(label.props.style);
        const frame = StyleSheet.flatten(password.props.style);
        const drawnHeight = Math.max(minHeight, lineHeight + 2 * (paddingVertical + borderWidth));
        const rowHeight = Math.max(frame.minHeight ?? 0, drawnHeight + 2 * (frame.paddingVertical ?? 0))
            + 2 * (frame.marginVertical ?? 0);
        expect(rowHeight).toBe(28);
        await password.props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ authMode: 'password' }));
    });

    it('can hide unsupported SSH auth modes', async () => {
        const onChange = vi.fn();
        const { SshCredentialsFields } = await import('./SshCredentialsFields');
        const screen = await renderScreen(React.createElement(SshCredentialsFields, {
            testIDPrefix: 'ssh-fields',
            supportedAuthModes: ['agent', 'keyfile'],
            value: {
                username: 'dev',
                host: 'example.test',
                port: '22',
                authMode: 'agent',
                identityFilePath: '',
                password: '',
            },
            onChange,
        }));

        expect(screen.findByTestId('ssh-fields-sshAuthAgent')).not.toBeNull();
        expect(screen.findByTestId('ssh-fields-sshAuthKeyfile')).not.toBeNull();
        expect(screen.findByTestId('ssh-fields-sshAuthPassword')).toBeNull();
        expect(screen.findByTestId('ssh-fields-sshPasswordInput')).toBeNull();
    });

    it('does not drop rapid successive edits from different fields', async () => {
        const onChange = vi.fn();
        const { SshCredentialsFields } = await import('./SshCredentialsFields');
        const screen = await renderScreen(React.createElement(SshCredentialsFields, {
            testIDPrefix: 'ssh-fields',
            value: {
                username: '',
                host: '',
                port: '',
                authMode: 'agent',
                identityFilePath: '',
                password: '',
            },
            onChange,
        }));

        screen.changeTextByTestId('ssh-fields-sshUsernameInput', 'dev');
        screen.changeTextByTestId('ssh-fields-sshHostInput', 'relay.example.test');

        const lastCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
        expect(lastCall?.username).toBe('dev');
        expect(lastCall?.host).toBe('relay.example.test');
    });

    it('clears the password when switching away from password auth', async () => {
        const onChange = vi.fn();
        const { SshCredentialsFields } = await import('./SshCredentialsFields');
        const screen = await renderScreen(React.createElement(SshCredentialsFields, {
            testIDPrefix: 'ssh-fields',
            value: {
                username: 'dev',
                host: 'example.test',
                port: '22',
                authMode: 'password',
                identityFilePath: '/tmp/id_rsa',
                password: 'super-secret',
            },
            onChange,
        }));

        const agentAuth = screen.findByTestId('ssh-fields-sshAuthAgent')!;
        await agentAuth.props.onPress?.();

        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            authMode: 'agent',
            password: '',
        }));
    });
});
