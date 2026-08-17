import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { resolveAccountHealthDotColor } from './account/accountBlockModel';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks();

const profileState = vi.hoisted(() => ({
    connectedServicesV2: [] as Array<Record<string, unknown>>,
    connectedAccountsV4: [] as Array<Record<string, unknown>>,
    connectedAccountGroupsV4: [] as Array<Record<string, unknown>>,
}));
const registryState = vi.hoisted(() => ({
    status: 'ready' as 'loading' | 'ready' | 'stale' | 'error' | 'conflict',
    errorReason: null as string | null,
    entries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () => ({
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
            },
        },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({
        connectedServicesV2: profileState.connectedServicesV2,
        connectedAccountsV4: profileState.connectedAccountsV4,
        connectedAccountGroupsV4: profileState.connectedAccountGroupsV4,
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

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => ({
        scopeKey: 'server-1',
        status: registryState.status,
        errorReason: registryState.errorReason,
        entries: registryState.entries,
    }),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    getLegacyConnectedServiceRegistryEntry: (serviceId: string) => registryState.entries
        .find((entry) => entry.legacyServiceId === serviceId)
        ?? { serviceId, connectCommand: `happier connect ${serviceId}`, supportsOauth: false, executable: false },
    getConnectedServiceRegistrySnapshot: () => ({
        scopeKey: 'server-1',
        status: 'ready',
        errorReason: null,
        entries: registryState.entries,
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

vi.mock('./ConnectedServiceQuotaSummaryCardSection', () => ({
    ConnectedServiceQuotaSummaryCardSection: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServiceQuotaSummaryCardSection', props),
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('./ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingDefaultsGroup: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesProviderStateSharingDefaultsGroup', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

// Keep the group props on the host stand-in so the screen's section headings
// stay inspectable (the list group and the dev-only usage summary must not
// present the same heading twice in a row).
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, children),
}));

// `Item` owns the fixed leading slot; render `leftElement` so the brand mark and
// the overlaid health dot are actually mounted and inspectable in the tree.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { leftElement?: React.ReactNode }) => React.createElement('Item', props, props.leftElement),
}));

// The generic fallback glyph draws through Hugeicons/Phosphor primitives; a host
// stand-in keeps the resolved `name` assertable without the drawing stack.
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

const REGISTRY_ENTRIES: Array<Record<string, unknown>> = [
    // Registry order deliberately does NOT match the expected attention-first order.
    {
        serviceId: 'github', legacyServiceId: 'github',
        service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
        connectCommand: 'happier connect github', supportsOauth: true, executable: true, projectedTitle: 'GitHub',
    },
    {
        serviceId: 'anthropic', legacyServiceId: 'anthropic',
        service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
        connectCommand: 'happier connect anthropic', supportsOauth: true, executable: true, projectedTitle: 'Anthropic',
    },
    {
        serviceId: 'vault',
        service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' },
        connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
        supportsOauth: true,
        executable: true,
        projectedTitle: 'Acme Vault',
    },
    {
        serviceId: 'openai-codex', legacyServiceId: 'openai-codex',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        connectCommand: 'happier connect openai-codex', supportsOauth: true, executable: true, projectedTitle: 'OpenAI Codex',
    },
];

const PROFILES = [
    {
        ref: { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'personal' },
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'cred-github', configurationReady: true, configurationRevision: null, scopes: [],
    },
    {
        ref: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' },
        status: 'refresh_failed_retryable', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'cred-anthropic', configurationReady: true, configurationRevision: null, scopes: [],
    },
    {
        ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
        status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'cred-codex', configurationReady: true, configurationRevision: null, scopes: [],
    },
];

async function renderView() {
    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
    return tree;
}

async function renderRows() {
    return (await renderView()).root.findAllByType('Item' as never);
}

describe('ConnectedServicesSettingsView row presentation', () => {
    beforeEach(() => {
        registryState.status = 'ready';
        registryState.errorReason = null;
        registryState.entries = REGISTRY_ENTRIES.map((entry) => ({ ...entry }));
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = PROFILES.map((profile) => ({ ...profile }));
        profileState.connectedAccountGroupsV4 = [];
    });

    it('orders provider rows attention-first, then by label', async () => {
        const rows = await renderRows();

        expect(rows.map((row) => row.props.title)).toEqual([
            'OpenAI Codex', // needs_reauth -> error
            'Anthropic', // refresh_failed_retryable -> attention
            'Acme Vault', // healthy, alphabetically before GitHub
            'GitHub', // healthy
        ]);
    });

    it('overlays a health dot colored by the worst-of account health, and only for services with accounts', async () => {
        const { theme } = (await import('react-native-unistyles')).useUnistyles();
        const rows = await renderRows();

        const dotFor = (serviceKey: string) => rows
            .flatMap((row) => row.findAllByProps({ testID: `connected-services-index:${serviceKey}:health-dot` } as never))
            .at(0);

        expect(dotFor('happier.agent.codex/openai-codex')?.props.color).toBe(resolveAccountHealthDotColor(theme, 'error'));
        expect(dotFor('happier.agent.claude/anthropic')?.props.color).toBe(resolveAccountHealthDotColor(theme, 'attention'));
        expect(dotFor('happier.scm.forge.github/github-account')?.props.color).toBe(resolveAccountHealthDotColor(theme, 'healthy'));
        // No accounts at all is "not connected", not a health signal.
        expect(dotFor('vault')).toBeUndefined();
    });

    it('renders the service brand mark, falling back to the generic key glyph when no mark exists', async () => {
        const rows = await renderRows();
        const rowByTitle = (title: string) => rows.find((row) => row.props.title === title)!;

        expect(rowByTitle('GitHub').findAllByType('SvgXml' as never)).toHaveLength(1);
        expect(rowByTitle('OpenAI Codex').findAllByType('SvgXml' as never)).toHaveLength(1);

        const fallbackRow = rowByTitle('Acme Vault');
        expect(fallbackRow.findAllByType('SvgXml' as never)).toHaveLength(0);
        expect(fallbackRow.findAllByType('Icon' as never)[0]?.props.name).toBe('key');
    });

    it('heads the usage summary separately from the services group instead of repeating one title', async () => {
        const tree = await renderView();

        const servicesGroupTitle = tree.root.findAllByType('ItemGroup' as never)[0]?.props.title;
        const summaryTitle = tree.root
            .findAllByType('ConnectedServiceQuotaSummaryCardSection' as never)[0]?.props.title;

        expect(servicesGroupTitle).toBe('connectedServices.title');
        expect(summaryTitle).toBeTruthy();
        expect(summaryTitle).not.toBe(servicesGroupTitle);
    });

    it('withholds the empty copy while the projected registry is still loading', async () => {
        registryState.status = 'loading';
        registryState.entries = [];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        expect(tree.root.findAll((node) => node.children.includes('connectedServices.list.empty'))).toHaveLength(0);
        expect(tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-projection-loading',
        )).not.toHaveLength(0);
    });

    it('withholds the empty copy when the projection failed, keeping the failure row alone', async () => {
        registryState.status = 'error';
        registryState.errorReason = 'daemon_unreachable';
        registryState.entries = [];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        expect(tree.root.findAll((node) => node.children.includes('connectedServices.list.empty'))).toHaveLength(0);
        expect(tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-projection-error',
        )).not.toHaveLength(0);
    });
});
