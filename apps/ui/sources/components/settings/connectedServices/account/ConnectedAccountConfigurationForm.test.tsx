import * as z from 'zod/mini';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { SchemaFieldControl } from '@/components/settings/schemaFields/SchemaFieldControl';
import { Item } from '@/components/ui/lists/Item';
import { PluginConfigurationSettingFieldV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';

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

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const fields = z.array(PluginConfigurationSettingFieldV2Schema).parse([
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
]);

describe('ConnectedAccountConfigurationForm', () => {
    it('uses the shared schema dispatcher while retaining boolean and JSON option value models', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const configuredFields = z.array(PluginConfigurationSettingFieldV2Schema).parse([
            { id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } },
            { id: 'tier', title: 'Tier', schema: { type: 'number', enum: [1, 2] }, presentation: { control: 'select' } },
            { id: 'scopes', title: 'Scopes', schema: { type: 'array', items: { type: 'number', enum: [1, 2] } } },
        ]);
        const submitted = vi.fn();
        const screen = await renderScreen(<ConnectedAccountConfigurationForm title="Configuration"
            fields={configuredFields} values={{ enabled: false, tier: 1, scopes: [1] }} configuredSecretFieldIds={[]}
            saving={false} onSubmit={submitted} />);
        expect(screen.tree.findAllByType(SchemaFieldControl).map(node => node.props.control)).toEqual(['switch', 'multiSelect', 'select']);
        const enabled = screen.tree.findAllByType(Item).find(node => node.props.title === 'Enabled')!;
        await pressTestInstanceAsync(enabled);
        const scopeChoice = (title: string) => screen.tree.findAllByType(Item).find(node => node.props.title === title)!;
        await pressTestInstanceAsync(scopeChoice('1'));
        await pressTestInstanceAsync(scopeChoice('2'));
        await act(async () => {
            screen.tree.find(node => node.props.testID === 'connected-account-configuration:tier'
                && typeof node.props.onSelect === 'function').props.onSelect(JSON.stringify(2));
        });
        await pressTestInstanceAsync(screen.findByTestId('connected-account-configuration:save'));
        expect(submitted).toHaveBeenCalledWith({ values: { enabled: true, tier: 2, scopes: [2] }, secretValues: {} });
    });

    afterEach(async () => {
        const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        clearActiveUnsavedChangesGuard();
    });

    it('folds optional Advanced fields, reveals required or invalid fields and preserves edits', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const withAdvanced = z.array(PluginConfigurationSettingFieldV2Schema).parse([
            { id: 'accountId', title: 'Account ID', schema: { type: 'string', minLength: 1 }, required: true },
            { id: 'clientId', title: 'Client ID', schema: { type: 'string' }, required: false, presentation: { advanced: true } },
            { id: 'port', title: 'Port', schema: { type: 'integer' }, presentation: { advanced: true } },
        ]);
        const onSubmit = vi.fn(async () => {});
        const render = (values: Record<string, string>) => renderScreen(<ConnectedAccountConfigurationForm embedded title="Sign in" fields={withAdvanced}
            values={values} configuredSecretFieldIds={[]} saving={false} onSubmit={onSubmit} />);
        const disclosure = (tree: Awaited<ReturnType<typeof render>>['tree']) => tree.findAll((node) => node.props.testID === 'connected-account-advanced')[0]!;

        const empty = await render({});
        expect(disclosure(empty.tree).props.expanded).toBe(false);

        const held = await render({ clientId: 'c_mine' });
        expect(disclosure(held.tree).props.expanded).toBe(true);

        const required = await renderScreen(<ConnectedAccountConfigurationForm title="Sign in"
            fields={withAdvanced.map(field => field.id === 'clientId' ? { ...field, required: true } : field)}
            values={{}} configuredSecretFieldIds={[]} saving={false} onSubmit={onSubmit} />);
        expect(disclosure(required.tree).props.expanded).toBe(true);

        const invalid = await render({ accountId: 'acct', clientId: 'c_mine' });
        await act(async () => {
            invalid.tree.find(node => node.type === ('TextInput' as never)
                && node.props.testID === 'connected-account-configuration:port').props.onChangeText('not-a-number');
            disclosure(invalid.tree).props.onExpandedChange(false);
        });
        expect(disclosure(invalid.tree).props.expanded).toBe(false);
        await pressTestInstanceAsync(invalid.tree.find((node) => node.props.testID === 'connected-account-configuration:save'));
        expect(disclosure(invalid.tree).props.expanded).toBe(true);
        await act(async () => { disclosure(invalid.tree).props.onExpandedChange(false); });
        await pressTestInstanceAsync(invalid.tree.find((node) => node.props.testID === 'connected-account-configuration:save'));
        expect(disclosure(invalid.tree).props.expanded).toBe(true);
        await act(async () => {
            invalid.tree.find(node => node.type === ('TextInput' as never)
                && node.props.testID === 'connected-account-configuration:port').props.onChangeText('443');
        });
        await act(async () => { disclosure(invalid.tree).props.onExpandedChange(false); });
        expect(disclosure(invalid.tree).props.expanded).toBe(false);
        await pressTestInstanceAsync(invalid.tree.find((node) => node.props.testID === 'connected-account-configuration:save'));
        expect(onSubmit).toHaveBeenCalledWith({ values: { accountId: 'acct', clientId: 'c_mine', port: 443 }, secretValues: {} });
        await invalid.update(<ConnectedAccountConfigurationForm embedded title="Sign in"
            fields={withAdvanced.map(field => {
                const presentation = { ...field.presentation };
                delete presentation.advanced;
                return { ...field, required: field.id === 'clientId', presentation };
            })} values={{}} configuredSecretFieldIds={[]} saving={false} onSubmit={onSubmit} />);
        expect(invalid.tree.findAll(node => node.props.testID === 'connected-account-advanced')).toHaveLength(0);
        expect(invalid.findHostByTestId('connected-account-configuration:clientId')?.props.value).toBe('c_mine');
    });

    it('places a declared guide with the fields it explains, inside Advanced when those are folded', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const guide = { consoleUrl: 'https://provider.example/clients', steps: ['Register a client'] };
        const ownClient = (advanced: boolean) => z.array(PluginConfigurationSettingFieldV2Schema).parse([
            { id: 'accountId', title: 'Account ID', schema: { type: 'string' }, required: false },
            { id: 'clientId', title: 'Client ID', schema: { type: 'string' }, required: !advanced, ...(advanced ? { presentation: { advanced: true } } : {}) },
        ]);
        const render = (advanced: boolean) => renderScreen(<ConnectedAccountConfigurationForm embedded title="Sign in" fields={ownClient(advanced)}
            values={{}} configuredSecretFieldIds={[]} saving={false} onSubmit={vi.fn(async () => {})} guide={guide} guideFieldId="clientId" />);
        const guideIn = (node: { findAll: (p: (n: { props: { testID?: string } }) => boolean) => unknown[] }) =>
            node.findAll((n) => n.props.testID === 'connected-account-manual:guide').length > 0;

        const open = await render(false);
        expect(guideIn(open.tree)).toBe(true);
        expect(open.tree.findAll((node) => node.props.testID === 'connected-account-advanced')).toHaveLength(0);

        const folded = await render(true);
        const disclosure = folded.tree.findAll((node) => node.props.testID === 'connected-account-advanced')[0]!;
        await act(async () => { disclosure.props.onExpandedChange(true); });
        expect(guideIn(folded.tree.findAll((node) => node.props.testID === 'connected-account-advanced')[0]!)).toBe(true);
    });

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

        const endpoint = tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:endpoint');
        const secret = tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:clientSecret');
        const enabled = tree.findAllByType(Item).find((node) => node.props.title === 'Enabled');
        if (!enabled) throw new Error('Expected the enabled configuration row');
        const region = tree.find((node) => node.props.testID === 'connected-account-configuration:region');

        await act(async () => {
            endpoint.props.onChangeText('https://new.example');
            secret.props.onChangeText('replacement');
            await pressTestInstanceAsync(enabled);
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
        const schemaOnlyFields = z.array(PluginConfigurationSettingFieldV2Schema).parse([
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
        ]);
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
        const scopeChoices = tree.findAllByType(Item).filter(
            (node) => node.props.title === 'read' || node.props.title === 'write',
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

    it('associates exact invalid configuration field errors with their controls', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={fields}
                values={{ enabled: false, region: 'eu' }}
                configuredSecretFieldIds={[]}
                saving={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-configuration:save'),
        );

        const endpoint = tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:endpoint',
        );
        expect(endpoint.props.accessibilityLabel)
            .toBe('Endpoint: connectedServices.account.configurationInvalid');
        expect(endpoint.props.accessibilityHint)
            .toBe('connectedServices.account.configurationInvalid');
        const secretError = tree.find(
            (node) => node.props.testID === 'connected-account-configuration:clientSecret.error',
        );
        expect(secretError.props.accessibilityRole).toBe('alert');
        expect(secretError.props.accessibilityLiveRegion).toBe('polite');
    });

    it('registers an entered configuration secret with the shared shell-navigation guard', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={fields}
                values={{ endpoint: 'https://old.example', enabled: false, region: 'eu' }}
                configuredSecretFieldIds={['clientSecret']}
                saving={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        await act(async () => {
            tree.find(
                (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:clientSecret',
            ).props.onChangeText('replacement-secret');
        });

        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
    });

    it('retains edited values and secrets through option/read refreshes until the caller retires the target revision', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const onSubmit = vi.fn();
        const initialValues = { endpoint: 'https://old.example', enabled: false, region: 'eu' };
        const form = (key: string, refreshed: boolean) => <ConnectedAccountConfigurationForm
            key={key}
            title="Configuration"
            fields={refreshed ? fields.map(field => field.id === 'region' ? {
                ...field, schema: { ...field.schema, enum: ['eu', 'us', 'ap'] },
                presentation: { ...field.presentation, options: [
                    ...field.presentation!.options!, { value: 'ap', title: 'Asia Pacific' },
                ] },
            } : field) : fields}
            values={refreshed ? { ...initialValues, endpoint: 'https://updated.example' } : initialValues}
            configuredSecretFieldIds={['clientSecret']}
            saving={false}
            onSubmit={onSubmit}
        />;
        const screen = await renderScreen(
            form('target:revision-1', false),
        );
        await act(async () => {
            screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://unsaved.example');
            screen.changeTextByTestId('connected-account-configuration:clientSecret', 'replacement-secret');
        });
        await screen.update(form('target:revision-1', true));
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://unsaved.example');
        expect(screen.findHostByTestId('connected-account-configuration:clientSecret')?.props.value).toBe('replacement-secret');
        await act(async () => {
            screen.tree.find(node => node.props.testID === 'connected-account-configuration:region').props.onSelect(JSON.stringify('ap'));
        });
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenCalledWith({ values: {
            endpoint: 'https://unsaved.example', enabled: false, region: 'ap',
        }, secretValues: { clientSecret: 'replacement-secret' } });
        // The controller keys this form by configuration target/revision. A real
        // retirement must still clear secrets and seed the new read values.
        await screen.update(form('target:revision-2', true));
        expect(screen.findHostByTestId('connected-account-configuration:clientSecret')?.props.value).toBe('');
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://updated.example');
        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false).toBe(false);
    });
});
