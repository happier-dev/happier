import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ConnectedAccountIndexFacts } from './index/ConnectedAccountIndexRow';
import type { ConnectedServicesConnectMore } from './setup/ConnectedServicesConnectMore';

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
    useActiveServerAccountScope: () => null,
    useAllMachines: () => [],
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
    useSetting: () => undefined,
    useLocalSetting: () => undefined,
    useLocalSettingMutable: () => [undefined, vi.fn()],
}));

vi.mock('@/sync/store/settingsWriters', () => ({ useApplySettings: () => vi.fn() }));

vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
    useHomeTeamCredentialModelCatalog: () => ({
        resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: true, condition: null,
    }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ machineId: null, serverId: null }),
    useProjectedPluginLocalizedTextResolver: () => (_pluginId: string, value: unknown) => (typeof value === 'string' ? value : ''),
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
    getGeneratedLegacyConnectedServiceRegistryFallback: () => null,
    installConnectedAccountDescriptorProjection: vi.fn(),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: [],
        accountsWithoutUsage: [],
        accountsNeedingSignIn: [],
        keysWithoutLimits: 0,
        inUseAccountKeys: new Set(),
        isRefreshing: false,
        hasConnectedProfiles: false,
    }),
}));
vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadUsageSummaryWarmCache: () => null,
    saveUsageSummaryWarmCache: () => {},
}));
// The agent projection is a machine read; without it, every service stays with the agent accounts.
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'ready', inputs: null }),
}));

vi.mock('./index/ConnectedAccountIndexRow', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./index/ConnectedAccountIndexRow')>()),
    ConnectedAccountIndexLiveFacts: ({ render }: { render: (facts: ConnectedAccountIndexFacts) => React.ReactElement }) => render({
        usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
    }),
}));
vi.mock('./setup/ConnectedServicesConnectMore', () => ({
    ConnectedServicesConnectMore: (props: React.ComponentProps<typeof ConnectedServicesConnectMore>) =>
        React.createElement('ConnectedServicesConnectMore', props),
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('./ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingDisclosure: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesProviderStateSharingDisclosure', props),
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

// `Item` owns the fixed leading slot; render `leftElement` and `titleAccessory` so the brand mark
// and the state pill are actually mounted and inspectable in the tree.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { leftElement?: React.ReactNode; rightElement?: React.ReactNode }) =>
        React.createElement('Item', props, props.leftElement, props.rightElement),
}));

// The generic fallback glyph draws through Hugeicons/Phosphor primitives; a host
// stand-in keeps the resolved `name` assertable without the drawing stack.
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
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

function serviceHeaders(tree: Awaited<ReturnType<typeof renderView>>) {
    return tree.root.findAllByType('Item' as never)
        .filter((row) => String(row.props.testID ?? '').startsWith('connected-services-service:'));
}

describe('ConnectedServicesSettingsView row presentation', () => {
    // The page's module graph is large; loading it once up front keeps each case's own time honest.
    beforeAll(async () => {
        await import('./ConnectedServicesSettingsView');
    }, 180_000);

    beforeEach(() => {
        registryState.status = 'ready';
        registryState.errorReason = null;
        registryState.entries = REGISTRY_ENTRIES.map((entry) => ({ ...entry }));
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = PROFILES.map((profile) => ({ ...profile }));
        profileState.connectedAccountGroupsV4 = [];
    });

    it('orders services attention-first, then by label, leaving services without accounts to setup', async () => {
        const headers = serviceHeaders(await renderView());

        expect(headers.map((row) => row.props.title)).toEqual([
            'OpenAI Codex', // needs_reauth -> error
            'Anthropic', // refresh_failed_retryable -> attention
            'GitHub', // healthy
        ]);
    });

    it('says only on the account that needs a new sign-in that it does, never for a retrying refresh', async () => {
        const tree = await renderView();
        const signedOut = tree.root.findAll((node) => node.props.facts && node.props.accountId)
            .filter((row) => row.props.signedOut !== null)
            .map((row) => row.props.testID);

        expect(signedOut).toEqual(['connected-services-account:happier.agent.codex/openai-codex:work']);
        expect(tree.findHostByTestId(`${signedOut[0]}:sign-in-again`)).not.toBeNull();
        expect(tree.findHostByTestId('connected-services-account:happier.agent.claude/anthropic:work:sign-in-again')).toBeNull();
        // The summary line counts it once as "needs you".
        const summary = tree.root.findAll((node) => node.props?.testID === 'connected-services-summary-needs-you');
        expect(summary).not.toHaveLength(0);
    });

    it('renders the service brand mark, falling back to the generic key glyph when no mark exists', async () => {
        profileState.connectedAccountsV4 = [
            ...PROFILES.map((profile) => ({ ...profile })),
            {
                ...PROFILES[0],
                ref: { service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' }, accountId: 'vault-1' },
            },
        ];
        const headers = serviceHeaders(await renderView());
        const rowByTitle = (title: string) => headers.find((row) => row.props.title === title)!;

        expect(rowByTitle('GitHub').findAllByType('SvgXml' as never)).toHaveLength(1);
        expect(rowByTitle('OpenAI Codex').findAllByType('SvgXml' as never)).toHaveLength(1);

        const fallbackRow = rowByTitle('Acme Vault');
        expect(fallbackRow.findAllByType('SvgXml' as never)).toHaveLength(0);
        expect(fallbackRow.findAllByType('Icon' as never)[0]?.props.name).toBe('key');
    });

    it('keeps the first-run setup loading while machines are still asked for services', async () => {
        registryState.status = 'loading';
        registryState.entries = [];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        // Nothing is claimed empty while the machines are still asked: the first run says so in place.
        expect(tree.root.findAll((node) => node.props?.testID === 'connected-services-empty')).toHaveLength(0);
        const firstRun = tree.root.findByType('ConnectedServicesConnectMore' as never);
        expect(firstRun.props).toMatchObject({ layout: 'firstRun', loading: true });
    });

    it('explains a failed service read instead of claiming there is nothing to connect', async () => {
        registryState.status = 'error';
        registryState.errorReason = 'daemon_unreachable';
        registryState.entries = [];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        expect(tree.root.findAll((node) => node.props?.testID === 'connected-services-empty')).toHaveLength(0);
        expect(tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-projection-error',
        )).not.toHaveLength(0);
    });

    it('says truthfully that services come from online machines when none is offering any', async () => {
        registryState.entries = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        expect(tree.root.findAll((node) => node.props?.testID === 'connected-services-empty')).not.toHaveLength(0);
    });
});
