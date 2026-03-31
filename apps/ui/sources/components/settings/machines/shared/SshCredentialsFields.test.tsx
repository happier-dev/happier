import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '../machinesSettingsTestHelpers';

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
