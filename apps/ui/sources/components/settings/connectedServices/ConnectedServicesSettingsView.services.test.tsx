import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { ConnectedAccountIndexFacts } from './index/ConnectedAccountIndexRow';
import type { ConnectedServicesConnectMore } from './setup/ConnectedServicesConnectMore';

import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks();

const profileState = vi.hoisted(() => ({
    connectedServicesV2: [] as Array<Record<string, unknown>>,
    connectedAccountsV4: [] as Array<Record<string, unknown>>,
    connectedAccountGroupsV4: [] as Array<Record<string, unknown>>,
}));
const registryState = vi.hoisted(() => ({
    status: 'ready' as 'loading' | 'ready' | 'stale' | 'error' | 'conflict',
    entries: [] as Array<Record<string, unknown>>,
}));

const CLAUDE = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
const CODEX = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const VAULT = { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' };

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

// Saving settings crosses the sync/persistence boundary; model and presentation stay real.
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
        errorReason: null,
        entries: registryState.entries,
    }),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/connectedServices/connectedServiceRegistry')>()),
    getLegacyConnectedServiceRegistryEntry: (serviceId: string) => ({
        serviceId, connectCommand: `happier connect ${serviceId}`, supportsOauth: false, executable: false,
    }),
    getConnectedServiceRegistrySnapshot: () => ({
        scopeKey: 'server-1', status: 'ready', errorReason: null, entries: registryState.entries,
    }),
    installConnectedAccountDescriptorProjection: vi.fn(),
}));

// Quota reads are server requests; the index's account list does not depend on them.
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: [], accountsWithoutUsage: [], accountsNeedingSignIn: [], keysWithoutLimits: 0,
        inUseAccountKeys: new Set(), isRefreshing: false, hasConnectedProfiles: false,
    }),
}));
vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadUsageSummaryWarmCache: () => null,
    saveUsageSummaryWarmCache: () => {},
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'ready', inputs: null }),
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('./ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingDisclosure: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesProviderStateSharingDisclosure', props),
}));

// The account row owns its own quota subscription (a network read); the index only decides which
// accounts it lists and what each says, so a host stand-in keeps the props assertable.
vi.mock('./index/ConnectedAccountIndexRow', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./index/ConnectedAccountIndexRow')>()),
    ConnectedAccountIndexLiveFacts: ({ render }: { render: (facts: ConnectedAccountIndexFacts) => React.ReactElement }) => render({
        usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
    }),
}));
// The setup panel signs in on a machine (daemon RPCs); the page decides where it opens and on what.
vi.mock('./setup/ConnectedServicesConnectMore', () => ({
    ConnectedServicesConnectMore: (props: React.ComponentProps<typeof ConnectedServicesConnectMore>) =>
        React.createElement('ConnectedServicesConnectMore', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { rightElement?: React.ReactNode; leftElement?: React.ReactNode }) =>
        React.createElement('Item', props, props.leftElement, props.rightElement),
}));

function account(service: { pluginId: string; localId: string }, accountId: string, status: string) {
    return {
        ref: { service, accountId },
        status,
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: `cred-${accountId}`,
        configurationReady: true,
        configurationRevision: null,
        scopes: [],
        providerIdentity: { email: `${accountId}@example.com` },
    };
}

function entry(service: { pluginId: string; localId: string }, title: string) {
    return {
        serviceId: service.localId,
        service,
        connectCommand: `happier connect ${service.localId}`,
        supportsOauth: true,
        executable: true,
        projectedTitle: title,
    };
}

async function renderView() {
    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
    return (await renderScreen(<ConnectedServicesSettingsView />)).tree;
}

function byTestId(tree: Awaited<ReturnType<typeof renderView>>, testID: string) {
    return tree.root.findAll((node) => node.props?.testID === testID);
}

describe('ConnectedServicesSettingsView services', () => {
    beforeEach(() => {
        registryState.status = 'ready';
        registryState.entries = [entry(CLAUDE, 'Claude subscription'), entry(CODEX, 'ChatGPT subscription'), entry(VAULT, 'Acme Vault')];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [
            account(CLAUDE, 'work', 'connected'),
            account(CLAUDE, 'personal', 'needs_reauth'),
        ];
        profileState.connectedAccountGroupsV4 = [];
        connectedServicesModuleState.routerPushSpy.mockClear();
    });

    it('lists a service with its accounts attention-first and keeps unconnected services in the setup catalog', async () => {
        const tree = await renderView();

        const header = byTestId(tree, 'connected-services-service:happier.agent.claude/anthropic')[0]!;
        expect(header.props.mode).toBe('info');
        expect(header.props.onPress).toBeUndefined();
        expect(header.props.showChevron).toBe(false);
        let claudeSheet = header.parent;
        while (claudeSheet && claudeSheet.type !== ('ItemGroup' as never)) claudeSheet = claudeSheet.parent;
        expect(claudeSheet).toBeTruthy();
        const rows = claudeSheet!.findAll((node) => node.props.facts && node.props.accountId);
        // Attention first: the account that needs a new sign-in leads.
        expect(rows.map((row) => row.props.accountId)).toEqual(['personal', 'work']);

        expect(byTestId(tree, 'connected-services-service:happier.agent.codex/openai-codex')).toHaveLength(0);
        const panel = tree.root.findByType('ConnectedServicesConnectMore' as never);
        expect(panel.props.layout).toBe('section');
        // The catalog offers what can be added, by exact qualified identity.
        expect(panel.props.model.connectable.map((candidate: { label: string }) => candidate.label))
            .toEqual(['Acme Vault', 'ChatGPT subscription']);
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    });

    it('keeps accounts listed when no online machine publishes their service', async () => {
        registryState.entries = [];

        const tree = await renderView();

        const header = byTestId(tree, 'connected-services-service:happier.agent.claude/anthropic');
        expect(header).not.toHaveLength(0);
        expect(header[0]!.props.title).toBeTruthy();
        expect(tree.root.findAll((node) => node.props.facts && node.props.accountId)).toHaveLength(2);
    });

    it('puts the fix on the account that needs it, and grows the setup inside that service', async () => {
        const tree = await renderView();

        const rows = tree.root.findAll((node) => node.props.facts && node.props.accountId);
        const signedOut = rows.find((row) => row.props.accountId === 'personal')!;
        const healthy = rows.find((row) => row.props.accountId === 'work')!;
        expect(healthy.props.signedOut).toBeNull();
        expect(signedOut.props.fixProminence).toBe('primary');

        await pressTestInstanceAsync(byTestId(tree, `${signedOut.props.testID}:sign-in-again`)[0]!);
        const panel = tree.root.findByType('ConnectedServicesConnectMore' as never);
        expect(panel.props.request).toEqual({
            kind: 'reconnect', serviceKey: 'happier.agent.claude/anthropic', accountId: 'personal',
        });
        // The machine leaf reports that setup is open: the row's fix steps down.
        const { act } = await import('react-test-renderer');
        await act(async () => panel.props.onOpenChange(true));
        expect(tree.root.findAll((node) => node.props.facts && node.props.accountId)
            .every((row) => row.props.fixProminence === 'secondary')).toBe(true);

        await pressTestInstanceAsync(byTestId(tree, 'connected-services-service:happier.agent.claude/anthropic:add-account')[0]!);
        expect(tree.root.findByType('ConnectedServicesConnectMore' as never).props.request)
            .toEqual({ kind: 'service', serviceKey: 'happier.agent.claude/anthropic' });
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    });
});
