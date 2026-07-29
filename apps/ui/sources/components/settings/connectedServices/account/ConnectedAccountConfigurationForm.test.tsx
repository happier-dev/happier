import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { PluginConfigurationSettingFieldV2 } from '@happier-dev/protocol';

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
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
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
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string', minLength: 1 },
        required: true,
    },
    {
        id: 'enabled',
        title: 'Enabled',
        schema: { type: 'boolean' },
        default: false,
    },
    {
        id: 'region',
        title: 'Region',
        schema: { type: 'string', enum: ['eu', 'us'] },
        presentation: {
            control: 'select',
            options: [
                { value: 'eu', title: 'Europe' },
                { value: 'us', title: 'United States' },
            ],
        },
    },
    {
        id: 'clientSecret',
        title: 'Client secret',
        schema: { type: 'string', minLength: 1 },
        secret: true,
        required: true,
    },
] satisfies PluginConfigurationSettingFieldV2[];

describe('ConnectedAccountConfigurationForm', () => {
    it('submits descriptor-derived values and only explicit secret replacements', async () => {
        const onSubmit = vi.fn(async () => {});
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={fields}
                values={{ endpoint: 'https://old.example', enabled: false, region: 'eu' }}
                configuredSecretFieldIds={['clientSecret']}
                saving={false}
                onSubmit={onSubmit}
            />,
        )).tree;

        const endpoint = tree.find((node) => node.props.testID === 'connected-account-configuration:endpoint');
        const secret = tree.find((node) => node.props.testID === 'connected-account-configuration:clientSecret');
        const enabled = tree.find((node) => String(node.type) === 'Item' && node.props.title === 'Enabled');
        const region = tree.find((node) => node.props.testID === 'connected-account-configuration:region');

        await act(async () => {
            endpoint.props.onChangeText('https://new.example');
            secret.props.onChangeText('replacement');
            enabled.props.rightElement.props.onValueChange(true);
            region.props.onSelect(JSON.stringify('us'));
        });

        const save = tree.find((node) => node.props.testID === 'connected-account-configuration:save');
        await pressTestInstanceAsync(save);

        expect(onSubmit).toHaveBeenCalledWith({
            values: {
                endpoint: 'https://new.example',
                enabled: true,
                region: 'us',
            },
            secretValues: { clientSecret: 'replacement' },
        });
    });

    it('renders schema-only scalar and array enum choices without duplicate presentation metadata', async () => {
        const schemaOnlyFields = [
            {
                id: 'tier',
                title: 'Tier',
                schema: { type: 'string', enum: ['free', 'pro'] },
                default: 'free',
            },
            {
                id: 'scopes',
                title: 'Scopes',
                schema: {
                    type: 'array',
                    items: { type: 'string', enum: ['read', 'write'] },
                },
                default: ['read'],
            },
        ] satisfies PluginConfigurationSettingFieldV2[];
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={schemaOnlyFields}
                values={{}}
                configuredSecretFieldIds={[]}
                saving={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        const tier = tree.find(
            (node) => node.props.testID === 'connected-account-configuration:tier',
        );
        expect(tier.props.items).toEqual([
            { id: JSON.stringify('free'), title: 'free', subtitle: undefined },
            { id: JSON.stringify('pro'), title: 'pro', subtitle: undefined },
        ]);
        const scopeChoices = tree.findAll(
            (node) => String(node.type) === 'Item'
                && (node.props.title === 'read' || node.props.title === 'write'),
        );
        expect(scopeChoices.map((choice) => ({
            testID: choice.props.rightElement.props.testID,
            value: choice.props.rightElement.props.value,
        }))).toEqual([
            {
                testID: 'connected-account-configuration:scopes:\"read\"',
                value: true,
            },
            {
                testID: 'connected-account-configuration:scopes:\"write\"',
                value: false,
            },
        ]);
    });
});
