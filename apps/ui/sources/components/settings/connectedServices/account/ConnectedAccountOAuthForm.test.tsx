import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));

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
                text: { secondary: 'secondary' },
            },
        },
    }),
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
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

describe('ConnectedAccountOAuthForm', () => {
    it('opens the daemon-provided authorization URL and returns only callback completion facts', async () => {
        const onSubmit = vi.fn(async (_completion: Readonly<{
            code: string;
            callbackUrl: string;
            state: string;
        }>) => {});
        const { ConnectedAccountOAuthForm } = await import('./ConnectedAccountOAuthForm');
        const tree = (await renderScreen(
            <ConnectedAccountOAuthForm
                authorizationUrl="https://provider.example/authorize"
                callbackUrl="http://127.0.0.1:1455/auth/callback"
                submitting={false}
                onSubmit={onSubmit}
            />,
        )).tree;

        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-oauth:open'),
        );
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://provider.example/authorize');

        const callback = tree.find(
            (node) => node.props.testID === 'connected-account-oauth:callback',
        );
        await act(async () => {
            callback.props.onChangeText(
                'http://127.0.0.1:1455/auth/callback?code=code-1&state=state-1',
            );
        });
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-oauth:submit'),
        );

        expect(onSubmit).toHaveBeenCalledWith({
            code: 'code-1',
            callbackUrl: 'http://127.0.0.1:1455/auth/callback',
            state: 'state-1',
        });
        expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('pkceVerifier');
    });
});
