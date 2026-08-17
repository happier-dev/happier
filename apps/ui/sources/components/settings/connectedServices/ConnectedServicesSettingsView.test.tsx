import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn((..._args: Parameters<IModal['alert']>) => undefined));

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Platform: {
                OS: 'web',
                select: (options?: Readonly<{ default?: unknown }>) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const profileState = vi.hoisted(() => ({
    connectedServicesV2: [
        {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        },
    ] as Array<Record<string, unknown>>,
}));
const connectedServiceRegistryState = vi.hoisted(() => ({
    status: 'ready' as 'loading' | 'ready' | 'stale' | 'error' | 'conflict',
    errorReason: null as string | null,
    entries: [{
        serviceId: 'openai-codex',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        legacyServiceId: 'openai-codex',
        connectCommand: 'happier connect codex',
        supportsOauth: true,
        executable: true,
    }] as Array<Record<string, any>>,
    legacyEntriesByServiceId: {
        'openai-codex': {
            serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: true,
            executable: false,
            projectedTitle: 'OpenAI Codex',
        },
    } as Record<string, Record<string, any>>,
}));
const serverFeaturesState = vi.hoisted(() => ({
    qualifiedAccounts: undefined as { protocolVersion: number } | undefined,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () => ({
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: {
                    qualifiedAccounts: serverFeaturesState.qualifiedAccounts,
                },
            },
        },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({
        connectedServicesV2: profileState.connectedServicesV2,
    }),
    useSettings: () => ({
        connectedServicesDefaultProfileByServiceId: {},
        connectedServicesProfileLabelByKey: {},
        connectedServicesProviderStateSharingSettingsV1: {},
        connectedServicesDefaultAuthByAgentIdV1: {},
    }),
    useSettingMutable: () => [{}, vi.fn()],
    useLocalSetting: () => 1,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: any) => React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('./ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingDefaultsGroup: (props: any) => React.createElement('ConnectedServicesProviderStateSharingDefaultsGroup', props),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    getLegacyConnectedServiceRegistryEntry: (serviceId: string) => connectedServiceRegistryState.entries.find((entry) => entry.legacyServiceId === serviceId)
        ?? connectedServiceRegistryState.legacyEntriesByServiceId[serviceId]
        ?? { serviceId, connectCommand: `happier connect ${serviceId}`, supportsOauth: false },
    getConnectedServiceRegistrySnapshot: () => ({
        scopeKey: 'server-1', status: connectedServiceRegistryState.status, errorReason: connectedServiceRegistryState.errorReason,
        entries: connectedServiceRegistryState.entries,
    }),
    installConnectedAccountDescriptorProjection: vi.fn(),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: [],
        isRefreshing: false,
        hasConnectedProfiles: false,
    }),
}));

describe('ConnectedServicesSettingsView', () => {
    beforeEach(() => {
        serverFeaturesState.qualifiedAccounts = undefined;
        connectedServiceRegistryState.status = 'ready';
        connectedServiceRegistryState.errorReason = null;
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect codex',
            supportsOauth: true,
            executable: true,
        }];
        modalAlertSpy.mockClear();
        connectedServicesModuleState.routerPushSpy.mockClear();
        connectedServicesModuleState.options.text = async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                translate: (key, params) => {
                    if (key === 'connectedServices.list.connectedCount') {
                        return `${(params as { count?: number } | undefined)?.count ?? 0} connected`;
                    }
                    return key;
                },
            });
        };
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            },
        ];
    });

    it('keeps boundary diagnostics out of the primary row and exposes only bounded product-safe support detail', async () => {
        const longDiagnostic = `unexpected-${'x'.repeat(512)}`;
        connectedServiceRegistryState.entries = [{
            serviceId: 'bitbucket', connectCommand: 'happier connect bitbucket', supportsOauth: false, supportsToken: false,
            service: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account' },
            legacyServiceId: 'bitbucket',
            executable: false, projectedDescriptor: { id: 'account' }, projectedTitle: 'Bitbucket Cloud',
            projectionStatus: 'ready', availability: { state: 'blocked', reason: '/private/plugin/error' },
            diagnostics: ['missing_runtime', '/unexpected/path-shaped-diagnostic', 'token=never-render-this-primary', longDiagnostic],
        }];
        profileState.connectedServicesV2 = [];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const row = screen.tree.findAllByType('Item' as never).find((item) => item.props.title === 'Bitbucket Cloud');

        expect(row).toBeTruthy();
        expect(row?.props).toMatchObject({ disabled: true, onPress: undefined });
        expect(row?.props.subtitle).toContain('common.blocked');
        expect(row?.props.subtitle).toContain('common.unavailable');
        expect(row?.props.subtitle).not.toContain('missing_runtime');
        expect(row?.props.subtitle).not.toContain('/private/plugin/error');
        expect(row?.props.subtitle).not.toContain('/unexpected/path-shaped-diagnostic');
        expect(row?.props.subtitle).not.toContain('token=never-render-this-primary');
        expect(row?.props.subtitle).not.toContain(longDiagnostic);

        const details = screen.tree.root.findByProps({
            testID: 'connected-services-index:happier.scm.forge.bitbucket/bitbucket-account:support-details',
        } as never);
        await pressTestInstanceAsync(details);
        const supportBody = String(modalAlertSpy.mock.calls[0]?.[1] ?? '');
        expect(supportBody).toContain('common.unavailable');
        expect(supportBody).toContain('connectedServices.errors.generic');
        expect(supportBody).not.toContain('missing_runtime');
        expect(supportBody).not.toContain('/private/plugin/error');
        expect(supportBody).not.toContain('/unexpected/path-shaped-diagnostic');
        expect(supportBody).not.toContain('token=never-render-this-primary');
        expect(supportBody).not.toContain(longDiagnostic);
    });

    it('keeps projection failure detail product-safe when support details are opened', async () => {
        connectedServiceRegistryState.status = 'error';
        connectedServiceRegistryState.errorReason = '/private/plugin/registry?token=never-render-this';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const error = screen.tree.root.findByProps({
            testID: 'connected-services-projection-error',
        } as never);

        await pressTestInstanceAsync(error);
        const supportBody = String(modalAlertSpy.mock.calls[0]?.[1] ?? '');
        expect(supportBody).toContain('connectedServices.errors.generic');
        expect(supportBody).not.toContain('/private/plugin/registry');
        expect(supportBody).not.toContain('token=never-render-this');
    });

    it('does not render empty copy when registry-backed provider rows are available on first run', async () => {
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        const tree = (await renderScreen(React.createElement(ConnectedServicesSettingsView))).tree;

        expect(tree.root.findAll((node) =>
            node.children.includes('connectedServices.list.empty'),
        )).toHaveLength(0);
        expect(tree.findAllByType('Item' as any).length).toBeGreaterThan(0);
    });

    it('does not route a default-auth connect action without an executable projected service owner', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;

        await tree.root
            .findAllByType('ConnectedServicesDefaultAuthRow' as never)[0]
            .props.onOpenConnectedServicesSettings('not-a-released-service');

        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'errors.daemonUnavailableTitle',
            'errors.daemonUnavailableBody',
        );
    });

    it('routes a default-auth connect action through its exact projected qualified owner', async () => {
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: true,
            executable: true,
        }];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;

        await tree.root
            .findAllByType('ConnectedServicesDefaultAuthRow' as never)[0]
            .props.onOpenConnectedServicesSettings('openai-codex');

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
        });
    });

    it('routes a released legacy fallback through its generated exact identity', async () => {
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: true,
            executable: true,
            projectedTitle: 'OpenAI Codex',
        }];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;

        expect(tree.root.findAllByType('Item' as never).some(
            (item) => item.props.title === 'OpenAI Codex',
        )).toBe(true);
        await tree.root
            .findAllByType('ConnectedServicesDefaultAuthRow' as never)[0]
            .props.onOpenConnectedServicesSettings('openai-codex');

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
        });
    });

    it('renders a released V2 profile through the generated adapter without making a scalar row owner', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [{
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        }];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;
        const row = tree.root.findAllByType('Item' as never).find(
            (item) => item.props.title === 'OpenAI Codex',
        );

        expect(row?.props.disabled).toBe(false);
        await pressTestInstanceAsync(row!);
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
        });
    });

    it('keeps built-in and projected Connected Accounts available when the retired master feature is disabled', async () => {
        // A novel descriptor has no scalar compatibility authority. It is
        // visible once the server advertises the qualified V4 contract, while
        // the built-in row remains available through its generated adapter.
        serverFeaturesState.qualifiedAccounts = { protocolVersion: 4 };
        profileState.connectedServicesV2 = [];
        connectedServiceRegistryState.entries = [
            {
                serviceId: 'openai-codex',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                legacyServiceId: 'openai-codex',
                connectCommand: 'happier connect codex',
                supportsOauth: true,
                executable: true,
                displayNameKey: 'connectedServices.names.openaiCodex',
            },
            {
                serviceId: 'vault',
                service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' },
                connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
                supportsOauth: true,
                executable: true,
                projectedDescriptor: { id: 'vault' },
                projectedTitle: 'Acme Vault',
            },
        ];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;
        const rows = tree.findAllByType('Item' as never);
        const builtInRow = rows.find((item) => item.props.title === 'connectedServices.names.openaiCodex');
        const projectedRow = rows
            .find((item) => item.props.title === 'Acme Vault');

        expect(builtInRow).toBeTruthy();
        expect(projectedRow).toBeTruthy();
        await pressTestInstanceAsync(projectedRow!);

        expect(ConnectedServiceIdSchema.safeParse('vault').success).toBe(false);
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'acme.connected-accounts-conformance',
                localId: 'vault',
            },
        });
    });

    it('counts retryable refresh-failure profiles as connected on the provider summary row', async () => {
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'connected', status: 'connected', kind: 'oauth' },
                    { profileId: 'retryable', status: 'refresh_failed_retryable', kind: 'oauth' },
                    { profileId: 'reauth', status: 'needs_reauth', kind: 'oauth' },
                ],
            },
        ];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        const tree = (await renderScreen(React.createElement(ConnectedServicesSettingsView))).tree;

        const row = tree.findAllByType('Item' as any)
            .find((node) => node.props?.subtitle === '2 connected');
        expect(row?.props?.subtitle).toBe('2 connected');
    });
});
