import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { PluginSettingFieldV2 } from '@happier-dev/protocol';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { text: 'text', background: 'background', placeholder: 'placeholder' },
                border: { default: 'border' },
                text: { primary: 'primary', secondary: 'secondary' },
            },
        },
    }),
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

const fields = [
    {
        id: 'identity',
        title: 'Email or username',
        schema: { type: 'string', minLength: 1 },
    },
    {
        id: 'token',
        title: 'API token',
        schema: { type: 'string', minLength: 1 },
        secret: true,
    },
] satisfies PluginSettingFieldV2[];

describe('ConnectedAccountManualForm', () => {
    it('submits every descriptor field as a string without retaining prior secret values', async () => {
        const onSubmit = vi.fn(async () => {});
        const { ConnectedAccountManualForm } = await import('./ConnectedAccountManualForm');
        const tree = (await renderScreen(
            <ConnectedAccountManualForm
                title="Manual authentication"
                fields={fields}
                submitting={false}
                onSubmit={onSubmit}
            />,
        )).tree;

        const identity = tree.find((node) => node.props.testID === 'connected-account-manual:identity');
        const token = tree.find((node) => node.props.testID === 'connected-account-manual:token');

        expect(identity.props.value).toBe('');
        expect(token.props.value).toBe('');
        expect(token.props.secureTextEntry).toBe(true);

        await act(async () => {
            identity.props.onChangeText('alice@example.test');
            token.props.onChangeText('secret-token');
        });
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-manual:submit'),
        );

        expect(onSubmit).toHaveBeenCalledWith({
            fields: {
                identity: 'alice@example.test',
                token: 'secret-token',
            },
        });
    });

    it('does not submit when a required descriptor string is empty', async () => {
        const onSubmit = vi.fn();
        const { ConnectedAccountManualForm } = await import('./ConnectedAccountManualForm');
        const tree = (await renderScreen(
            <ConnectedAccountManualForm
                title="Manual authentication"
                fields={fields}
                submitting={false}
                onSubmit={onSubmit}
            />,
        )).tree;

        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-manual:submit'),
        );

        expect(onSubmit).not.toHaveBeenCalled();
        expect(tree.findByType('ItemGroup').props.footer).toBe('common.error');
    });
});
