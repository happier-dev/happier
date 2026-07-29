import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type {
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

const modalAlertMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => styles },
    useUnistyles: () => ({
        theme: { colors: { accent: { blue: 'blue' }, text: { secondary: 'secondary' } } },
    }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertMock,
        confirm: modalConfirmMock,
        prompt: modalPromptMock,
    },
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot', () => ({
    useConnectedServiceQuotaSnapshot: () => ({
        snapshot: null,
        loading: false,
        error: null,
        canRefresh: false,
        isRefreshing: false,
        refresh: vi.fn(),
    }),
}));
vi.mock('@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota', () => ({
    useQualifiedConnectedAccountQuota: () => ({
        supported: false,
        snapshot: null,
        loading: false,
        refreshing: false,
        error: null,
        refresh: vi.fn(),
    }),
}));
vi.mock('@/components/settings/connectedServices/detail/ConnectedServiceSegmentedShell', () => ({
    ConnectedServiceSegmentedShell: (props: Readonly<{
        accountsContent: React.ReactNode;
        poolsContent: React.ReactNode;
        activeSegment: 'accounts' | 'pools';
        poolsAvailable: boolean;
    }>) => React.createElement(
        'ConnectedServiceSegmentedShell',
        props,
        props.activeSegment === 'pools' && props.poolsAvailable
            ? props.poolsContent
            : props.accountsContent,
    ),
}));

const service = { pluginId: 'acme.accounts', localId: 'work' } as const;
const modes = [
    {
        id: 'manual',
        kind: 'manual',
        title: 'Access token',
        outcomeReconciliation: 'none',
        fields: [{
            id: 'token',
            title: 'Token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
        }],
    },
    {
        id: 'device',
        kind: 'oauthDeviceCode',
        title: 'Device authorization',
        outcomeReconciliation: 'providerCheck',
    },
] satisfies PluginConnectedAccountAuthenticationModeV2[];
const accounts = [{
    ref: { service, accountId: 'account-a' },
    status: 'needs_reauth',
    authenticationModeId: 'device',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true,
    configurationRevision: 'config-1',
    displayName: 'Work account',
    scopes: [],
}] satisfies QualifiedConnectedAccountProfileV4[];

describe('ConnectedAccountServiceContent', () => {
    it('lists every descriptor mode and reconnects only the exact qualified account', async () => {
        const onBeginConnect = vi.fn();
        const onBeginReconnect = vi.fn();
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                busy={false}
                onBeginConnect={onBeginConnect}
                onBeginReconnect={onBeginReconnect}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const modeRows = tree.findAll((node) =>
            String(node.type) === 'Item'
            &&
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-mode:'),
        );
        expect(modeRows.map((row) => row.props.title)).toEqual([
            'Access token',
            'Device authorization',
        ]);

        await pressTestInstanceAsync(modeRows[1]!);
        expect(onBeginConnect).toHaveBeenCalledWith({
            service,
            modeId: 'device',
        });

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        await pressTestInstanceAsync(account);
        expect(onBeginReconnect).toHaveBeenCalledWith({
            service,
            accountId: 'account-a',
        });
    });

    it('keeps reconnect available for a non-null public mode unknown to this descriptor snapshot', async () => {
        const onBeginReconnect = vi.fn();
        const futureModeAccount = {
            ...accounts[0],
            authenticationModeId: 'future-oauth',
            configurationReady: false,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[futureModeAccount]}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={onBeginReconnect}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        expect(account.props.disabled).toBe(false);
        expect(account.props.subtitle).toContain('common.blocked');
        await pressTestInstanceAsync(account);
        expect(onBeginReconnect).toHaveBeenCalledWith({
            service,
            accountId: 'account-a',
        });
    });

    it('shows configuration blocking from the current service or account scope owner', async () => {
        const configuredAccount = {
            ...accounts[0],
            status: 'connected' as const,
            authenticationModeId: 'manual',
            configurationReady: false,
            configurationRevision: null,
        } satisfies QualifiedConnectedAccountProfileV4;
        const configuredMode = {
            ...modes[0],
            configuration: {
                scope: 'service' as const,
                changeBehavior: 'reconnect' as const,
                fields: [{
                    id: 'origin',
                    title: 'Origin',
                    schema: { type: 'string' as const, minLength: 1 },
                    required: true as const,
                    semantic: 'connectedAccountOrigin' as const,
                    secret: false as const,
                }],
            },
        } satisfies PluginConnectedAccountAuthenticationModeV2;
        const { ConnectedAccountServiceContent } = await import(
            './ConnectedAccountServiceContent'
        );
        const rendered = await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={[configuredMode]}
                accounts={[configuredAccount]}
                serviceConfigurationStatusByModeId={{ manual: 'ready' }}
                busy={false}
                onBeginReconnect={vi.fn()}
                onConfigureService={vi.fn()}
            />,
        );
        const accountRow = () => rendered.tree.find((node) => (
            node.props.testID === 'connected-account:account-a'
        ));

        expect(accountRow().props.subtitle).not.toContain('common.blocked');
        expect(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )).props.detail).toBe('Access token');

        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={[configuredMode]}
                accounts={[configuredAccount]}
                serviceConfigurationStatusByModeId={{
                    manual: 'configurationRequired',
                }}
                busy={false}
                onBeginReconnect={vi.fn()}
                onConfigureService={vi.fn()}
            />,
        );

        expect(accountRow().props.subtitle).toContain('common.blocked');
        expect(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )).props.detail).toContain('common.blocked');

        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={[{
                    ...configuredMode,
                    configuration: {
                        ...configuredMode.configuration,
                        scope: 'account',
                    },
                }]}
                accounts={[configuredAccount]}
                serviceConfigurationStatusByModeId={{ manual: 'ready' }}
                busy={false}
                onBeginReconnect={vi.fn()}
            />,
        );

        expect(accountRow().props.subtitle).toContain('common.blocked');
    });

    it('keeps the account usable when its qualified service has no quota leaf', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded',
                    source: { protocol: 'v4' },
                }}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        )).tree;

        expect(tree.findAll((node) => (
            node.props.testID === 'connected-account:account-a'
        )).length).toBeGreaterThan(0);
        expect(tree.findAll((node) => (
            node.props.testID === 'qualified-connected-account-quota:account-a'
        ))).toHaveLength(0);
    });

    it('offers public setup modes without reconnecting an account whose public mode is unavailable', async () => {
        const onBeginConnect = vi.fn();
        const onBeginReconnect = vi.fn();
        const supportedSetupModes = [{
            id: 'api-key',
            kind: 'manual',
            title: 'Gemini API key',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Gemini API key',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
        }, {
            id: 'service-account',
            kind: 'manual',
            title: 'Google service account',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'credentialsJson',
                title: 'Service-account JSON',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
        }] satisfies PluginConnectedAccountAuthenticationModeV2[];
        const unsupportedLegacyAccount = {
            ...accounts[0],
            authenticationModeId: null,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={supportedSetupModes}
                accounts={[unsupportedLegacyAccount]}
                busy={false}
                onBeginConnect={onBeginConnect}
                onBeginReconnect={onBeginReconnect}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        expect(account.props.subtitle).toContain('connectedServices.detail.profiles.needsReauth');
        expect(account.props.disabled).toBe(true);
        expect(account.props.onPress).toBeUndefined();

        const modeRows = tree.findAll((node) =>
            String(node.type) === 'Item'
            && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-mode:'),
        );
        expect(modeRows.map((row) => row.props.title)).toEqual([
            'Gemini API key',
            'Google service account',
        ]);
        await pressTestInstanceAsync(modeRows[0]!);
        expect(onBeginConnect).toHaveBeenCalledWith({
            service,
            modeId: 'api-key',
        });
        expect(onBeginReconnect).not.toHaveBeenCalled();
    });

    it('owns the qualified pool policy, exact-member, reorder, and cooldown-override controls', async () => {
        const policy = {
            v: 1 as const,
            strategy: 'least_limited' as const,
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            preTurnProbeMode: 'when_stale' as const,
            preTurnProbeOrder: 'current_first_then_candidates' as const,
            recoveryMode: 'switch_or_wait' as const,
            resumePromptMode: 'standard' as const,
        };
        const group = {
            ref: { service, groupId: 'team' },
            displayName: 'Team',
            policy,
            activeAccountId: 'account-a',
            revision: {
                protocol: 'v4' as const,
                generation: 4,
                runtimeStateRevision: 7,
            },
            state: {},
            members: [{
                ref: { service, accountId: 'account-a' },
                priority: 100,
                enabled: true,
                state: {},
            }, {
                ref: { service, accountId: 'account-b' },
                priority: 200,
                enabled: true,
                state: {},
            }],
        };
        const patch = vi.fn(async () => group);
        const patchMember = vi.fn()
            .mockResolvedValueOnce({
                ...group,
                members: [{
                    ...group.members[0],
                    priority: 100,
                }, {
                    ...group.members[1],
                    priority: 100,
                }],
                revision: {
                    ...group.revision,
                    runtimeStateRevision: 8,
                },
            })
            .mockResolvedValueOnce({
                ...group,
                members: [{
                    ...group.members[0],
                    priority: 200,
                }, {
                    ...group.members[1],
                    priority: 100,
                }],
                revision: {
                    ...group.revision,
                    runtimeStateRevision: 9,
                },
            });
        const cooldownError = Object.assign(
            new Error('connect_group_profile_runtime_cooldown'),
            {
                code: 'connect_group_profile_runtime_cooldown',
                resetAtMs: Date.now() + 10_000,
            },
        );
        const setActiveAccount = vi.fn()
            .mockRejectedValueOnce(cooldownError)
            .mockResolvedValueOnce(group);
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValueOnce(true);
        const groups = {
            status: 'loaded' as const,
            source: { protocol: 'v4' as const },
            groups: [group],
            error: null,
            mutating: false,
            refresh: vi.fn(),
            create: vi.fn(),
            patch,
            delete: vi.fn(),
            addMember: vi.fn(),
            patchMember,
            removeMember: vi.fn(),
            setActiveAccount,
        };
        const secondAccount = {
            ...accounts[0],
            ref: { service, accountId: 'account-b' },
            status: 'connected' as const,
        };
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'group', groupId: 'team' }}
                modes={[]}
                accounts={[accounts[0], secondAccount]}
                groups={groups}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const requiredControlSuffixes = [
            'edit-name',
            'auto-switch',
            'strategy',
            'recovery-mode',
            'auto-restore-primary',
            'switch-on:usageLimit',
            'switch-on:authExpired',
            'switch-on:accountChanged',
            'switch-on:refreshFailure',
            'soft-switch-percent',
            'stale-probe',
            'cooldown',
            'max-switches-turn',
            'max-switches-hour',
            'add-member',
            'remove:account-a',
            'move-up:account-b',
            'move-down:account-a',
            'delete',
        ];
        const renderedTestIds = new Set(tree.findAll((node) => (
            typeof node.props.testID === 'string'
        )).map((node) => node.props.testID as string));
        for (const suffix of requiredControlSuffixes) {
            expect(renderedTestIds.has(
                `qualified-connected-account-group:team:${suffix}`,
            )).toBe(true);
        }

        await pressTestInstanceAsync(tree.find((node) => (
            node.props.testID
            === 'qualified-connected-account-group:team:recovery-mode'
        )));
        expect(patch).toHaveBeenCalledWith({
            group,
            policy: { recoveryMode: 'off' },
        });

        await pressTestInstanceAsync(tree.find((node) => (
            node.props.testID
            === 'qualified-connected-account-group:team:move-down:account-a'
        )));
        expect(patchMember).toHaveBeenNthCalledWith(1, {
            group,
            account: { service, accountId: 'account-b' },
            priority: 100,
        });
        expect(patchMember).toHaveBeenNthCalledWith(2, {
            group: expect.objectContaining({
                revision: expect.objectContaining({
                    runtimeStateRevision: 8,
                }),
            }),
            account: { service, accountId: 'account-a' },
            priority: 200,
        });

        await pressTestInstanceAsync(tree.find((node) => (
            node.props.testID
            === 'qualified-connected-account-group:team:member:account-b'
        )));
        await vi.waitFor(() => expect(setActiveAccount).toHaveBeenCalledTimes(2));
        expect(setActiveAccount).toHaveBeenLastCalledWith({
            group,
            account: { service, accountId: 'account-b' },
            overrideRuntimeCooldown: true,
        });
    });

    it('resets pool selection when route focus changes to an account', async () => {
        const group = {
            ref: { service, groupId: 'team' },
            displayName: 'Team',
            policy: {
                v: 1 as const,
                strategy: 'least_limited' as const,
                autoSwitch: false,
                switchOn: {
                    usageLimit: true,
                    authExpired: true,
                    accountChanged: true,
                    refreshFailure: false,
                },
                cooldownMs: 30_000,
                honorProviderResetsAt: true,
                autoRestorePrimaryWhenReset: false,
                maxSwitchesPerTurn: 1,
                maxSwitchesPerSessionHour: 3,
                softSwitchRemainingPercent: 15,
                probeIfSnapshotOlderThanMs: 300_000,
                preTurnProbeMode: 'when_stale' as const,
                preTurnProbeOrder: 'current_first_then_candidates' as const,
                recoveryMode: 'switch_or_wait' as const,
                resumePromptMode: 'standard' as const,
            },
            activeAccountId: null,
            revision: {
                protocol: 'v4' as const,
                generation: 1,
                runtimeStateRevision: 1,
            },
            state: {},
            members: [],
        };
        const groups = {
            ...EMPTY_GROUPS_FOR_TEST,
            status: 'loaded' as const,
            source: { protocol: 'v4' as const },
            groups: [group],
        };
        const { ConnectedAccountServiceContent } = await import(
            './ConnectedAccountServiceContent'
        );
        const rendered = await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'group', groupId: 'team' }}
                modes={modes}
                accounts={accounts}
                groups={groups}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        );
        expect(rendered.tree.findAll((node) => (
            node.props.testID
            === 'qualified-connected-account-group:team:edit-name'
        )).length).toBeGreaterThan(0);

        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'account', accountId: 'account-a' }}
                modes={modes}
                accounts={accounts}
                groups={groups}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        );

        expect(rendered.tree.findAll((node) => (
            node.props.testID
            === 'qualified-connected-account-group:team:edit-name'
        ))).toHaveLength(0);
        expect(rendered.tree.find(
            (node) => String(node.type)
                === 'ConnectedServiceSegmentedShell',
        ).props.activeSegment).toBe('accounts');
    });

    it.each([0, 2])(
        'renders one service configuration action with %i accounts',
        async (accountCount) => {
            const onConfigureService = vi.fn();
            const configuredModes = [{
                ...modes[0]!,
                configuration: {
                    scope: 'service' as const,
                    changeBehavior: 'refresh' as const,
                    fields: [{
                        id: 'origin',
                        title: 'Origin',
                        schema: { type: 'string' as const, minLength: 1 },
                        required: true as const,
                        secret: false as const,
                        semantic: 'connectedAccountOrigin' as const,
                    }],
                },
            }];
            const configuredAccounts = Array.from(
                { length: accountCount },
                (_, index) => ({
                    ...accounts[0]!,
                    ref: {
                        service,
                        accountId: `account-${index + 1}`,
                    },
                    authenticationModeId: 'manual',
                }),
            );
            const { ConnectedAccountServiceContent } = await import(
                './ConnectedAccountServiceContent'
            );
            const tree = (await renderScreen(
                <ConnectedAccountServiceContent
                    title="Acme"
                    service={service}
                    modes={configuredModes}
                    accounts={configuredAccounts}
                    busy={false}
                    onConfigureService={onConfigureService}
                />,
            )).tree;

            const rows = tree.findAll((node) => (
                node.props.testID
                === 'connected-service-configuration-settings:manual'
            ));
            expect(rows).toHaveLength(2);
            await pressTestInstanceAsync(rows[0]!);
            expect(onConfigureService).toHaveBeenCalledOnce();
            expect(onConfigureService).toHaveBeenCalledWith('manual');
        },
    );
});

const EMPTY_GROUPS_FOR_TEST = {
    source: null,
    groups: [],
    error: null,
    mutating: false,
    refresh: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    addMember: vi.fn(),
    patchMember: vi.fn(),
    removeMember: vi.fn(),
    setActiveAccount: vi.fn(),
} as const;
