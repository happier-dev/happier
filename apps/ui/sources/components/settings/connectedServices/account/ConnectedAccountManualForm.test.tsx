import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAccountManualForm } from './ConnectedAccountManualForm';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { PluginSettingFieldV2 } from '@happier-dev/protocol';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    // The row stand-in keeps its control mounted so the field inside it can be exercised.
    Item: (props: Record<string, unknown> & { rightElement?: React.ReactNode }) =>
        React.createElement('Item', props, props.rightElement),
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
    afterEach(async () => {
        const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        clearActiveUnsavedChangesGuard();
    });

    it('submits an optional account label separately from the descriptor secret fields in guided key setup', async () => {
        const onSubmit = vi.fn();
        const screen = await renderScreen(<ConnectedAccountManualForm embedded title="API key" submitting={false}
            fields={[fields[1]]} guided={{ consoleUrl: 'https://provider.example/keys', createKeyTitle: 'Create a key', billingNote: 'Billed by the service' }}
            onSubmit={onSubmit} />);
        await act(async () => {
            screen.tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token').props.onChangeText('secret-key');
            screen.tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:name').props.onChangeText('Build server');
        });
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(onSubmit).toHaveBeenCalledWith({ fields: { token: 'secret-key' }, displayName: 'Build server' });
    });

    it('submits every descriptor field as a string without retaining prior secret values', async () => {
        const onSubmit = vi.fn(async () => {});
        const tree = (await renderScreen(
            <ConnectedAccountManualForm
                title="Manual authentication"
                fields={fields}
                submitting={false}
                onSubmit={onSubmit}
            />,
        )).tree;

        const identity = tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:identity');
        const token = tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token');

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
        expect(tree.findByType('ItemGroup').props.description).toBe('common.error');
        const token = tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token',
        );
        expect(token.props.accessibilityLabel).toBe('API token: common.error');
        expect(token.props.accessibilityHint).toBe('common.error');
        const error = tree.find(
            (node) => node.props.testID === 'connected-account-manual:token.error',
        );
        expect(error.props.accessibilityRole).toBe('alert');
        expect(error.props.accessibilityLiveRegion).toBe('polite');
    });

    it('registers a dirty manual secret draft with the shared shell-navigation guard', async () => {
        const tree = (await renderScreen(
            <ConnectedAccountManualForm
                title="Manual authentication"
                fields={fields}
                submitting={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        await act(async () => {
            tree.find(
                (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token',
            ).props.onChangeText('secret-token');
        });

        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
    });

    it('clears a secret draft when the same mounted attempt receives a changed manual descriptor', async () => {
        const screen = await renderScreen(
            <ConnectedAccountManualForm
                title="Manual authentication"
                fields={fields}
                submitting={false}
                onSubmit={vi.fn()}
            />,
        );

        await act(async () => {
            screen.tree.find(
                (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token',
            ).props.onChangeText('secret-token');
        });
        const refreshedFields = fields.map((field) => (
            field.id === 'token' ? { ...field, title: 'Replacement token' } : field
        ));
        await act(async () => {
            screen.tree.update(
                <ConnectedAccountManualForm
                    title="Manual authentication"
                    fields={refreshedFields}
                    submitting={false}
                    onSubmit={vi.fn()}
                />,
            );
        });

        expect(screen.tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token',
        ).props.value).toBe('');
        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false).toBe(false);
    });
});
