import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

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
    beforeEach(() => {
        openExternalUrlMock.mockReset();
        openExternalUrlMock.mockResolvedValue(true);
    });

    afterEach(async () => {
        const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        clearActiveUnsavedChangesGuard();
    });

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
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-oauth:callback',
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

    it.each([
        { label: 'registered raw code', input: '4/0synthetic-code', allowRawAuthorizationCode: true, authorizationState: 'attempt-state', accepted: true },
        { label: 'raw code without provider permission', input: '4/0synthetic-code', allowRawAuthorizationCode: false, authorizationState: 'attempt-state', accepted: false },
        { label: 'raw code without current attempt state', input: '4/0synthetic-code', allowRawAuthorizationCode: true, authorizationState: null, accepted: false },
        { label: 'foreign callback', input: 'https://foreign.example.test/callback?code=synthetic-code&state=attempt-state', allowRawAuthorizationCode: true, authorizationState: 'attempt-state', accepted: false },
        { label: 'callback missing returned state', input: 'https://antigravity.google/oauth-callback?code=synthetic-code', allowRawAuthorizationCode: true, authorizationState: 'attempt-state', accepted: false },
        { label: 'code with another returned state', input: 'synthetic-code#another-attempt', allowRawAuthorizationCode: true, authorizationState: 'attempt-state', accepted: false },
    ])('validates $label before completion effects', async ({ input, allowRawAuthorizationCode, authorizationState, accepted }) => {
        const onSubmit = vi.fn();
        const { ConnectedAccountOAuthForm } = await import('./ConnectedAccountOAuthForm');
        const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        if (authorizationState) authorizationUrl.searchParams.set('state', authorizationState);
        const tree = (await renderScreen(
            <ConnectedAccountOAuthForm
                authorizationUrl={authorizationUrl.toString()}
                callbackUrl="https://antigravity.google/oauth-callback"
                allowRawAuthorizationCode={allowRawAuthorizationCode}
                submitting={false}
                onSubmit={onSubmit}
            />,
        )).tree;
        await act(async () => {
            tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-oauth:callback')
                .props.onChangeText(input);
        });
        await pressTestInstanceAsync(tree.find((node) => node.props.testID === 'connected-account-oauth:submit'));
        if (accepted) {
            expect(onSubmit).toHaveBeenCalledWith({
                code: '4/0synthetic-code', callbackUrl: 'https://antigravity.google/oauth-callback', state: 'attempt-state',
            });
        } else {
            expect(onSubmit).not.toHaveBeenCalled();
        }
    });

    it('keeps OAuth recovery visible when the external authorization page cannot open', async () => {
        openExternalUrlMock.mockResolvedValueOnce(false);
        const { ConnectedAccountOAuthForm } = await import('./ConnectedAccountOAuthForm');
        const tree = (await renderScreen(
            <ConnectedAccountOAuthForm
                authorizationUrl="https://provider.example/authorize"
                callbackUrl="http://127.0.0.1:1455/auth/callback"
                submitting={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-oauth:open'),
        );

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://provider.example/authorize');
        const failure = tree.find(
            (node) => node.props.testID === 'connected-account-oauth:open-error',
        );
        expect(failure.props.accessibilityRole).toBe('alert');
        expect(failure.props.accessibilityLiveRegion).toBe('assertive');
    });

    it('associates an invalid callback with its exact recoverable field error', async () => {
        const { ConnectedAccountOAuthForm } = await import('./ConnectedAccountOAuthForm');
        const tree = (await renderScreen(
            <ConnectedAccountOAuthForm
                authorizationUrl="https://provider.example/authorize"
                callbackUrl="http://127.0.0.1:1455/auth/callback"
                submitting={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        const callback = tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-oauth:callback',
        );
        await act(async () => {
            callback.props.onChangeText('https://untrusted.example/callback?code=code-1&state=state-1');
        });
        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-oauth:submit'),
        );

        expect(callback.props.accessibilityLabel)
            .toBe('connectedServices.oauthPaste.pasteRedirectUrl: connectedServices.oauthPaste.invalidConfig');
        expect(callback.props.accessibilityHint)
            .toBe('connectedServices.oauthPaste.invalidConfig');
        const error = tree.find(
            (node) => node.props.testID === 'connected-account-oauth:callback.error',
        );
        expect(error.props.accessibilityRole).toBe('alert');
        expect(error.props.accessibilityLiveRegion).toBe('polite');
    });

    it('confirms locally that a pasted answer has the shape a sign-in returns, before anything is sent (G5)', async () => {
        const onSubmit = vi.fn();
        const { ConnectedAccountOAuthForm } = await import('./ConnectedAccountOAuthForm');
        const tree = (await renderScreen(
            <ConnectedAccountOAuthForm
                authorizationUrl="https://claude.example/oauth/authorize"
                callbackUrl="https://platform.claude.example/oauth/code/callback"
                submitting={false}
                onSubmit={onSubmit}
            />,
        )).tree;
        const callback = tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-oauth:callback',
        );
        const shapeOk = () => tree.findAll((node) => node.props.testID === 'connected-account-oauth:callback.shape-ok');

        await act(async () => {
            callback.props.onChangeText('not a code');
        });
        expect(shapeOk()).toHaveLength(0);
        expect(onSubmit).not.toHaveBeenCalled();

        // The page Claude shows after approval: "<code>#<state>".
        await act(async () => {
            callback.props.onChangeText('Xk3p9QwZt7#a9f2c1');
        });
        expect(shapeOk()).not.toHaveLength(0);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('registers a pasted OAuth callback draft with the shared shell-navigation guard', async () => {
        const { ConnectedAccountOAuthForm } = await import('./ConnectedAccountOAuthForm');
        const tree = (await renderScreen(
            <ConnectedAccountOAuthForm
                authorizationUrl="https://provider.example/authorize"
                callbackUrl="http://127.0.0.1:1455/auth/callback"
                submitting={false}
                onSubmit={vi.fn()}
            />,
        )).tree;
        await act(async () => {
            tree.find(
                (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-oauth:callback',
            ).props.onChangeText('http://127.0.0.1:1455/auth/callback?code=code-1&state=state-1');
        });

        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
    });
});
