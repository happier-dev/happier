import * as z from 'zod/mini';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAccountManualForm } from './ConnectedAccountManualForm';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { PluginConfigurationSettingFieldV2Schema, PluginSettingFieldV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';

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

const fields = z.array(PluginSettingFieldV2Schema).parse([
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
]).map(field => ({ ...field, secret: Boolean(field.secret) }));

describe('ConnectedAccountManualForm', () => {
    afterEach(async () => {
        const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        clearActiveUnsavedChangesGuard();
    });

    it('submits an optional account label separately from the descriptor secret fields in guided key setup', async () => {
        const onSubmit = vi.fn();
        const screen = await renderScreen(<ConnectedAccountManualForm embedded title="API key" submitting={false}
            fields={[fields[1]]} guided={{ consoleUrl: 'https://provider.example/keys', steps: ['Create a key'], billingNote: 'Billed by the service' }}
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

    it('keeps the primary disabled until every required descriptor field has a value', async () => {
        const onSubmit = vi.fn();
        const screen = await renderScreen(
            <ConnectedAccountManualForm title="Manual authentication" fields={fields} submitting={false} onSubmit={onSubmit} />,
        );
        const submit = () => screen.tree.find((node) => node.props.testID === 'connected-account-manual:submit');
        expect(submit().props.disabled).toBe(true);
        await act(async () => {
            screen.tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:identity').props.onChangeText('ada');
        });
        expect(submit().props.disabled).toBe(true);
        await act(async () => {
            screen.tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token').props.onChangeText('secret');
        });
        expect(submit().props.disabled).toBe(false);
    });

    it('says on the field why a filled value does not match its declared shape, and does not submit', async () => {
        const onSubmit = vi.fn();
        const shaped = z.array(PluginSettingFieldV2Schema).parse([
            { id: 'token', title: 'API token', schema: { type: 'string', pattern: '^tok_' }, secret: true },
        ]).map(field => ({ ...field, secret: Boolean(field.secret) }));
        const screen = await renderScreen(
            <ConnectedAccountManualForm title="Manual authentication" fields={shaped} submitting={false} onSubmit={onSubmit} />,
        );
        await act(async () => {
            screen.tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token').props.onChangeText('nope');
        });
        await screen.pressByTestIdAsync('connected-account-manual:submit');

        expect(onSubmit).not.toHaveBeenCalled();
        // The field says what is wrong, once; the section does not add a second, vaguer "Error".
        expect(screen.tree.findByType(ItemGroup).props.description).toBeUndefined();
        const token = screen.tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-manual:token',
        );
        expect(token.props.accessibilityLabel).toBe('API token: connectedServicesSettings.manualFieldInvalid');
        const error = screen.tree.find(
            (node) => node.props.testID === 'connected-account-manual:token.error',
        );
        expect(error.props.accessibilityRole).toBe('alert');
    });

    it('leads a guided key with the declared steps and one console link, not a link per field', async () => {
        const screen = await renderScreen(<ConnectedAccountManualForm embedded title="API key" submitting={false}
            fields={fields} guided={{ consoleUrl: 'https://provider.example/keys', steps: ['Open API tokens.', 'Create a token with Read & Write.', 'Copy it.'], billingNote: 'Billed by the service' }}
            onSubmit={vi.fn()} />);
        const stepIds = [...new Set(screen.tree.findAll((node) => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-manual:step:')).map((node) => node.props.testID as string))];
        expect(stepIds).toEqual(['connected-account-manual:step:0', 'connected-account-manual:step:1', 'connected-account-manual:step:2']);
        expect(screen.tree.findAll((node) => node.props.testID === 'connected-account-manual:open-console').length).toBeGreaterThan(0);
        // The link closes the steps; no field row carries its own "create one" line or link.
        expect(screen.tree.findAll((node) => node.type === Item && node.props.subtitleAccessory)).toHaveLength(0);
    });

    it('lists per-feature permissions in the guide', async () => {
        const screen = await renderScreen(<ConnectedAccountManualForm embedded title="API token" submitting={false} fields={[fields[1]]}
            guided={{ consoleUrl: 'https://provider.example/keys', steps: ['Create a token.'], permissions: [{ feature: 'Workers', items: ['Scripts: Edit', 'CI: Edit'] }, { feature: 'Pages', items: ['Pages: Edit'] }] }}
            onSubmit={vi.fn()} />);
        expect(screen.findHostByTestId('connected-account-manual:permission:0')).toBeTruthy();
        expect(screen.findHostByTestId('connected-account-manual:permission:1')).toBeTruthy();
    });

    it('folds Advanced fields until opened and still submits what they hold', async () => {
        const onSubmit = vi.fn();
        const withAdvanced = z.array(PluginSettingFieldV2Schema).parse([
            { id: 'token', title: 'API token', schema: { type: 'string', minLength: 1 }, secret: true },
            { id: 'clientId', title: 'Client ID', schema: { type: 'string' }, presentation: { advanced: true } },
        ]).map(field => ({ ...field, secret: Boolean(field.secret) }));
        const screen = await renderScreen(<ConnectedAccountManualForm embedded title="API token" submitting={false} fields={withAdvanced} onSubmit={onSubmit} />);
        const input = (id: string) => screen.tree.findAll((node) => node.type === ('TextInput' as never) && node.props.testID === `connected-account-manual:${id}`);
        const disclosure = screen.tree.findAll((node) => node.props.testID === 'connected-account-advanced');
        expect(disclosure.length).toBeGreaterThan(0);
        expect(disclosure[0]!.props.expanded).toBe(false);
        await act(async () => { disclosure[0]!.props.onExpandedChange(true); });
        await act(async () => {
            input('token')[0]!.props.onChangeText('secret');
            input('clientId')[0]!.props.onChangeText('own-client');
        });
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(onSubmit).toHaveBeenCalledWith({ fields: { token: 'secret', clientId: 'own-client' } });
    });

    it('asks for the secret first, then the settings it needs, then the optional name', async () => {
        const configurationFields = z.array(PluginConfigurationSettingFieldV2Schema).parse([
            { id: 'accountId', title: 'Account ID', schema: { type: 'string', minLength: 1 }, required: true },
        ]);
        const screen = await renderScreen(<ConnectedAccountManualForm embedded title="API token" submitting={false} fields={[fields[1]]}
            guided={{ consoleUrl: 'https://provider.example/keys', steps: ['Open API tokens'] }}
            configuration={{ fields: configurationFields, values: {}, configuredSecretFieldIds: [] }}
            onSubmit={vi.fn()} />);
        const inputs = screen.tree.findAll((node) => node.type === ('TextInput' as never)).map((node) => node.props.testID as string);
        const at = (id: string) => inputs.indexOf(id);
        expect(at('connected-account-manual:token')).toBeGreaterThanOrEqual(0);
        expect(at('connected-account-manual:token')).toBeLessThan(at('connected-account-configuration:accountId'));
        expect(at('connected-account-configuration:accountId')).toBeLessThan(at('connected-account-manual:name'));
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
