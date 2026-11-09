import * as React from 'react';
import * as purposeChoices from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import * as metadataEngine from '@/sync/engine/settings/connectedMetadataCatalogEngine';
import { SelectionList } from '@/components/ui/selectionList';
import { Item } from '@/components/ui/lists/Item';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderBaseScreen } from '@/dev/testkit';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';

const initialStorageState = storage.getState();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({ pathname: '/settings/providers/cpx-moving' }));
const featureRuntimeState = vi.hoisted(() => ({
  status: 'ready' as 'loading' | 'ready',
  qualifiedAccounts: true,
}));
const connectedAccountState = vi.hoisted(() => ({
  additionalAccounts: [] as Array<Record<string, unknown>>,
  profileId: 'account-a' as string,
  serverId: 'server-a',
}));
type ModalBoundaryConfig = Readonly<{
  component: React.ComponentType<Record<string, unknown>>;
  props: Record<string, unknown>;
}>;
const modalBoundary = vi.hoisted(() => ({
  config: null as ModalBoundaryConfig | null,
  listeners: new Set<() => void>(),
}));
const modalSpies = vi.hoisted(() => ({
  show: vi.fn((config: unknown) => {
    modalBoundary.config = config as ModalBoundaryConfig;
    for (const listener of modalBoundary.listeners) listener();
    return 'purpose-target-modal';
  }),
  hide: vi.fn(() => {
    modalBoundary.config = null;
    for (const listener of modalBoundary.listeners) listener();
  }),
  update: vi.fn((_id: string, props: Record<string, unknown>) => {
    if (modalBoundary.config) modalBoundary.config = { ...modalBoundary.config, props };
    for (const listener of modalBoundary.listeners) listener();
  }),
}));
function ModalBoundaryHost() {
  const config = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => { modalBoundary.listeners.add(listener); return () => { modalBoundary.listeners.delete(listener); }; }, []),
    () => modalBoundary.config,
    () => modalBoundary.config,
  );
  return config ? React.createElement(config.component, { ...config.props, onClose: () => modalSpies.hide() }) : null;
}
let modalScreen: Awaited<ReturnType<typeof renderBaseScreen>>;
beforeEach(async () => { modalScreen = await renderBaseScreen(<ModalBoundaryHost />); });
const localizationSpies = vi.hoisted(() => ({ resolve: vi.fn((_pluginId: string, value: string | { key: string; fallback: string }) => (
  typeof value === 'string' ? value : `localized:${value.key}`
)) }));
const descriptorReload = vi.hoisted(() => vi.fn());
const descriptorSource = vi.hoisted(() => ({ readable: true, status: 'ready' as 'ready' | 'loading' }));
const connectedServiceRegistryState = vi.hoisted(() => ({
  entries: [{
    serviceId: 'acme-gateway-account',
    service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
    connectCommand: 'happier connect acme-gateway-account',
    supportsOauth: true,
    projectedTitle: 'Acme Gateway account',
  }] as Array<Record<string, unknown>>,
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ pathname: () => routeState.pathname }).module;
});

vi.mock('@/modal', () => ({
  Modal: {
    show: modalSpies.show,
    hide: modalSpies.hide,
    update: modalSpies.update,
  },
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));


function seedAccountProfile() {
  storage.setState({
    profileScope: { serverId: connectedAccountState.serverId, accountId: 'account-a' },
    profile: AccountProfileSchema.parse({
      ...profileDefaults,
      id: connectedAccountState.profileId,
      connectedAccountsV4: [{
        ref: {
          service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
          accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
        },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        configurationReady: true,
        configurationRevision: null,
        displayName: 'Personal OpenAI',
        scopes: [],
      }, ...connectedAccountState.additionalAccounts],
      connectedAccountGroupsV4: [],
    }),
    settings: {
      ...settingsDefaults,
    },
  });
}

async function renderScreen(element: React.ReactElement) {
  seedAccountProfile();
  return renderBaseScreen(element);
}
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useProjectedConnectedServicesRegistry: () => ({
    scopeKey: 'server-a', status: descriptorSource.status, errorReason: null, entries: connectedServiceRegistryState.entries,
  }),
  useProjectedPluginLocalizedTextResolver: () => localizationSpies.resolve,
  useAppShellPluginUiProjection: () => ({ reloadConnectedAccountProjection: descriptorReload }),
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesRuntimeSnapshot: () => ({
    status: featureRuntimeState.status,
    features: { capabilities: { connectedServices: {
      qualifiedAccounts: featureRuntimeState.qualifiedAccounts ? { protocolVersion: 4 } : undefined,
    } } },
  }),
}));
vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
  getConnectedAccountAuthentication: () => (descriptorSource.readable ? {
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      callbackUrl: 'http://127.0.0.1:4000/auth/callback',
      pkce: 'required',
      outcomeReconciliation: 'none',
    }],
  } : null),
  getQualifiedConnectedServiceRegistryEntry: () => null,
  getGeneratedLegacyConnectedServiceRegistryFallback: () => null,
  getLegacyConnectedServiceRegistryEntry: () => ({
    serviceId: 'acme-gateway-account',
    connectCommand: 'happier connect acme-gateway-account',
    supportsOauth: true,
  }),
}));

afterEach(async () => {
  await modalScreen.unmount();
  modalBoundary.config = null;
  storage.setState(initialStorageState, true);
  featureRuntimeState.status = 'ready';
  featureRuntimeState.qualifiedAccounts = true;
  routeState.pathname = '/settings/providers/cpx-moving';
  connectedAccountState.additionalAccounts = [];
  connectedAccountState.profileId = 'account-a';
  connectedAccountState.serverId = 'server-a';
  modalSpies.show.mockClear();
  modalSpies.hide.mockClear();
  modalSpies.update.mockClear();
  localizationSpies.resolve.mockClear();
  descriptorReload.mockReset();
  descriptorSource.readable = true;
  descriptorSource.status = 'ready';
});

type CapturedPurposeTargetModalConfig = Readonly<{
  props: Readonly<{
    rootStep: Readonly<{
      sections: readonly [Readonly<{
        virtualization?: string;
        options: ReadonlyArray<Readonly<{
          id: string;
          label: string;
          subtitle?: string;
          accessibilityLabel?: string;
          disabled?: boolean;
        }>>;
      }>];
    }>;
  }>;
}>;

function latestPurposeTargetModalConfig(): CapturedPurposeTargetModalConfig {
  const config = modalSpies.show.mock.calls.at(-1)?.[0];
  if (!config) throw new Error('Expected the purpose-target modal to be shown');
  const captured = config as ModalBoundaryConfig;
  return { ...captured, props: { ...captured.props, ...modalScreen.findByType(SelectionList).props } } as CapturedPurposeTargetModalConfig;
}

function findItemByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.findAllByType(Item).find((node) => node.props?.testID === testID);
}

describe('ConnectedAccountPurposeTargetChooser', () => {
  it('keeps eight closed slots free of option builds and label demand across a 200-account update', async () => {
    const choices = vi.spyOn(purposeChoices, 'buildConnectedAccountPurposeTargetChoices');
    const demand = vi.spyOn(metadataEngine, 'observeConnectedMetadataCatalog');
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previousApplied = runtime.getAppliedActiveServerSnapshot();
    const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
    const activeServer = getActiveServerSnapshot();
    connectedAccountState.serverId = activeServer.serverId;
    runtime.publishAppliedActiveServerSnapshot(activeServer);
    connectedAccountState.additionalAccounts = Array.from({ length: 199 }, (_, index) => ({
      ref: { service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, accountId: `account-${index}` },
      status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true,
      configurationRevision: null, displayName: `Other ${index}`, scopes: [],
    }));
    const commits = vi.fn();
    const screen = await renderScreen(<View>{Array.from({ length: 8 }, (_, index) => (
      <React.Profiler key={index} id={`slot-${index}`} onRender={commits}>
        <ConnectedAccountPurposeTargetChooser testID={`slot-${index}`} localizedTextPluginId="acme.provider.author"
          declaration={{ purpose: `slot-${index}`, service: { pluginId: 'acme.managed.provider', localId: 'gateway' } }}
          value={{ kind: 'account', account: {
            service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
            accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
          } }} onChange={() => undefined} />
      </React.Profiler>
    ))}</View>);
    try {
      expect(choices).toHaveBeenCalledTimes(0);
      expect(demand).toHaveBeenCalledTimes(0);
      commits.mockClear();
      await act(async () => {
        const profile = storage.getState().profile;
        storage.setState({ profile: { ...profile, connectedAccountsV4: (profile.connectedAccountsV4 ?? []).map((account, index) =>
          index === 199 ? { ...account, displayName: 'Changed unrelated account' } : account) } });
      });
      expect(commits).toHaveBeenCalledTimes(0);
      expect(choices).toHaveBeenCalledTimes(0);
      expect(demand).toHaveBeenCalledTimes(0);
      await act(async () => { findItemByTestId(screen, 'slot-0')?.props.onPress(); });
      expect(choices).toHaveBeenCalledTimes(1);
      expect(demand).toHaveBeenCalledTimes(1);
      expect(latestPurposeTargetModalConfig().props.rootStep.sections[0].options).toHaveLength(201);
      await act(async () => {
        const profile = storage.getState().profile;
        storage.setState({ profile: { ...profile, connectedAccountsV4: (profile.connectedAccountsV4 ?? []).map((account, index) =>
          index === 0 ? { ...account, displayName: 'Current personal account' } : account) } });
      });
      expect(latestPurposeTargetModalConfig().props.rootStep.sections[0].options.some(option => option.label === 'Current personal account')).toBe(true);
      expect(findItemByTestId(screen, 'slot-0')?.props.detail).toBe('Current personal account');
      await act(async () => { modalScreen.findByType(SelectionList).props.onRequestClose(); });
      expect(modalScreen.findAllByType(SelectionList)).toHaveLength(0);
      choices.mockClear();
      await act(async () => {
        const profile = storage.getState().profile;
        storage.setState({ profile: { ...profile, connectedAccountsV4: [...(profile.connectedAccountsV4 ?? [])] } });
      });
      expect(choices).toHaveBeenCalledTimes(0);
      expect(demand).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      choices.mockRestore(); demand.mockRestore();
      runtime.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    }
  });

  it('keeps an Account-scoped purpose target inert when its enclosing Administration target is foreign', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const onChange = vi.fn();
    const screen = await renderScreen(
      <ConnectedAccountPurposeTargetChooser
        testID="agent-connected-account-purpose:primary"
        localizedTextPluginId="acme.provider.author"
        declaration={{
          purpose: 'primary',
          service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
          required: false,
        }}
        value={null}
        onChange={onChange}
        disabled
        disabledReason="Switch server Accounts to continue"
      />,
    );

    const trigger = findItemByTestId(screen, 'agent-connected-account-purpose:primary');
    expect(trigger?.props).toMatchObject({
      disabled: true,
      subtitle: 'Switch server Accounts to continue',
      onPress: undefined,
    });
    expect(modalSpies.show).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes its portal-backed menu when a retained settings screen changes route', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const props = {
      testID: 'provider-connection-managed-purpose-chooser:openai-upstream',
      localizedTextPluginId: 'acme.provider.author',
      declaration: {
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        title: { key: 'managed.openaiPurpose', fallback: 'Use OpenAI upstream account' },
        required: true,
      },
      value: null,
      onChange: vi.fn(),
      onReload: vi.fn(),
      reloadSubtitle: 'settingsProviders.status.disabled',
    };
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser {...props} />);
    const trigger = findItemByTestId(screen, props.testID);

    expect(trigger?.props).toEqual(expect.objectContaining({
      title: 'localized:managed.openaiPurpose',
      accessibilityLabel: 'localized:managed.openaiPurpose · Choose an account or group',
    }));
    expect(localizationSpies.resolve).toHaveBeenCalledWith('acme.provider.author', props.declaration.title);
    expect(trigger?.props.title).not.toContain('openai-upstream');
    expect(trigger?.props.title).not.toBe('Use OpenAI upstream account');
    expect(trigger?.props.title).not.toContain('acme.managed.provider');
    expect(trigger?.props.title).not.toContain('gateway');
    await act(async () => {
      trigger?.props.onPress();
    });
    const options = latestPurposeTargetModalConfig().props.rootStep.sections[0].options;
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Personal OpenAI',
        subtitle: 'Acme Gateway account',
        accessibilityLabel: 'Acme Gateway account · Personal OpenAI',
        disabled: false,
      }),
    ]));
    // The canonical accountId is routing identity, not copy: it may key the row
    // and its testID, but no field a user reads or a screen reader speaks.
    for (const item of options) {
      expect(item.label).not.toContain('35f1d8ec-633c-4bda-9e0d-7055ac95b8af');
      expect(item.subtitle ?? '').not.toContain('35f1d8ec-633c-4bda-9e0d-7055ac95b8af');
      expect(item.accessibilityLabel ?? '').not.toContain('35f1d8ec-633c-4bda-9e0d-7055ac95b8af');
    }
    expect(modalSpies.show).toHaveBeenCalledTimes(1);

    routeState.pathname = '/settings/connected-services';
    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser {...props} />);
    });

    expect(modalSpies.hide).toHaveBeenCalledWith('purpose-target-modal');
  });

  it('offers the entitled Team selections only when its surface supplies the Team catalog', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const { TeamCredentialResourceCatalogEntryV1Schema } = await import('@happier-dev/protocol/teams');
    const service = { pluginId: 'acme.managed.provider', localId: 'gateway' };
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'resource-pool',
      teamId: 'team-acme',
      displayName: 'Acme shared pool',
      resourceRevision: 3,
      readiness: { kind: 'available' },
      recoveryAction: null,
      mayBroker: true,
      mayReceiveDirect: false,
      directMaterialState: 'never_delivered',
      sessionUsePolicy: 'personal_allowed',
      providerModels: [],
      connectedServiceSelections: [
        { source: 'team_resource', resourceId: 'resource-pool', deliveryMode: 'brokered' },
      ],
      sourcePresentation: { kind: 'connected_service', service },
    });
    const onChange = vi.fn();
    const props = {
      testID: 'agent-connected-account-purpose:subscription',
      localizedTextPluginId: 'acme.provider.author',
      declaration: { purpose: 'subscription', service, required: true },
      value: null,
      onChange,
    };
    const withoutCatalog = await renderScreen(<ConnectedAccountPurposeTargetChooser {...props} />);
    await act(async () => {
      findItemByTestId(withoutCatalog, props.testID)?.props.onPress();
    });
    expect(latestPurposeTargetModalConfig().props.rootStep.sections[0].options
      .some((option) => option.label === 'Acme shared pool')).toBe(false);

    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      {...props}
      teamCredentialCatalog={{
        resources: [resource],
        teamNameById: { 'team-acme': 'Acme' },
        resourceStatusByKey: new Map([['team-acme:resource-pool', { kind: 'current' as const }]]),
      }}
    />);
    await act(async () => {
      findItemByTestId(screen, props.testID)?.props.onPress();
    });
    const config = latestPurposeTargetModalConfig() as Readonly<{
      props: Readonly<{
        rootStep: CapturedPurposeTargetModalConfig['props']['rootStep'];
        onSelect: (id: string) => void;
      }>;
    }>;
    const teamOption = config.props.rootStep.sections[0].options
      .find((option) => option.label === 'Acme shared pool');
    expect(teamOption).toEqual(expect.objectContaining({ disabled: false }));
    await act(async () => {
      config.props.onSelect(teamOption!.id);
    });
    // The Team choice reaches the writer as the canonical Team selection of
    // its Team, never as a purpose target (lane 10 child 02 :271).
    expect(onChange).toHaveBeenCalledWith(null, {
      teamId: 'team-acme',
      selection: { source: 'team_resource', resourceId: 'resource-pool', deliveryMode: 'brokered' },
    });
  });

  it('labels a selected target and an indeterminate transport without raw purpose identifiers', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const props = {
      testID: 'provider-connection-managed-purpose-chooser:openai-upstream',
      localizedTextPluginId: 'acme.provider.author',
      declaration: {
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        title: 'Use OpenAI upstream account',
        required: true,
      },
      value: {
        kind: 'account' as const,
        account: {
          service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
          accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
        },
      },
      onChange: vi.fn(),
    };
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser {...props} />);
    const trigger = findItemByTestId(screen, props.testID);

    expect(trigger?.props.accessibilityLabel).toBe(
      'Use OpenAI upstream account · Acme Gateway account · Personal OpenAI',
    );

    featureRuntimeState.status = 'loading';
    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser {...props} />);
    });

    expect(findItemByTestId(screen, props.testID)?.props.accessibilityLabel).toBe(
      `Use OpenAI upstream account · ${t('common.loading')}`,
    );
  });

  it('keeps a saved qualified target loading until the Account profile is hydrated', async () => {
    connectedAccountState.profileId = '';
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const selected = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
      },
    };
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID="provider-connection-managed-purpose-chooser:hydrating"
      localizedTextPluginId="acme.provider.author"
      declaration={{
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        required: true,
      }}
      value={selected}
      onChange={vi.fn()}
    />);

    const trigger = findItemByTestId(screen, 'provider-connection-managed-purpose-chooser:hydrating');
    expect(trigger?.props).toEqual(expect.objectContaining({
      subtitle: t('common.loading'),
      detail: t('common.loading'),
    }));

    connectedAccountState.profileId = 'account-a';
    await act(async () => {
      seedAccountProfile();
      screen.tree.update(<ConnectedAccountPurposeTargetChooser
        testID="provider-connection-managed-purpose-chooser:hydrating"
        localizedTextPluginId="acme.provider.author"
        declaration={{
          purpose: 'openai-upstream',
          service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
          required: true,
        }}
        value={selected}
        onChange={vi.fn()}
      />);
    });
    expect(findItemByTestId(screen, 'provider-connection-managed-purpose-chooser:hydrating')?.props.detail)
      .toBe('Personal OpenAI');
  });

  it('distinguishes legacy transport from a deleted target and required-unset prompt', async () => {
    featureRuntimeState.qualifiedAccounts = false;
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const selected = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
      },
    };
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID="provider-connection-managed-purpose-chooser:legacy"
      localizedTextPluginId="acme.provider.author"
      declaration={{
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        required: true,
      }}
      value={selected}
      onChange={vi.fn()}
    />);

    expect(findItemByTestId(screen, 'provider-connection-managed-purpose-chooser:legacy')?.props).toEqual(
      expect.objectContaining({
        subtitle: t('connectedServices.purposeTargets.legacyUnavailable'),
        detail: t('connectedServices.purposeTargets.legacyUnavailable'),
      }),
    );

    featureRuntimeState.qualifiedAccounts = true;
    connectedAccountState.additionalAccounts = [];
  connectedAccountState.profileId = 'account-a';
    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser
        testID="provider-connection-managed-purpose-chooser:legacy"
        localizedTextPluginId="acme.provider.author"
        declaration={{
          purpose: 'openai-upstream',
          service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
          required: true,
        }}
        value={{ ...selected, account: { ...selected.account, accountId: 'deleted' } }}
        onChange={vi.fn()}
      />);
    });
    expect(findItemByTestId(screen, 'provider-connection-managed-purpose-chooser:legacy')?.props.detail).toBe('Unavailable');
  });

  it('keeps Refresh inside its picker sheet and reflects the reload there', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    let finishReload: () => void = () => undefined;
    const onReload = vi.fn(() => new Promise<void>((resolve) => { finishReload = resolve; }));
    const testID = 'agent-connected-account-purpose:primary';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{
        purpose: 'primary',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        required: false,
      }}
      value={null}
      onChange={vi.fn()}
      onReload={onReload}
      reloadSubtitle="Ready"
    />);

    // The page carries one row per purpose: the choice itself, never a bare Refresh row.
    expect(screen.findAllByType(Item).map((node) => node.props.testID)).toEqual([testID]);

    await act(async () => {
      findItemByTestId(screen, testID)?.props.onPress();
    });
    type RefreshProps = Readonly<{ refresh?: Readonly<{ status?: string; refreshing: boolean; onRefresh: () => void }> | null }>;
    const shown = (latestPurposeTargetModalConfig() as { props: RefreshProps }).props.refresh;
    expect(shown).toEqual(expect.objectContaining({ status: 'Ready', refreshing: false }));

    await act(async () => {
      shown?.onRefresh();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    const latestUpdate = () => modalSpies.update.mock.calls.at(-1)?.[1] as RefreshProps | undefined;
    expect(modalSpies.update.mock.calls.at(-1)?.[0]).toBe('purpose-target-modal');
    expect(latestUpdate()?.refresh?.refreshing).toBe(true);

    await act(async () => {
      finishReload();
    });
    expect(latestUpdate()?.refresh?.refreshing).toBe(false);
  });

  it('re-reads the connected-account descriptors together with the owner reload from the same open sheet', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const onReload = vi.fn(async () => undefined);
    const testID = 'agent-connected-account-purpose:primary';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{ purpose: 'primary', service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, required: false }}
      value={null}
      onChange={vi.fn()}
      onReload={onReload}
    />);
    await act(async () => { findItemByTestId(screen, testID)?.props.onPress(); });
    const shown = (latestPurposeTargetModalConfig() as { props: { refresh: { onRefresh: () => void } } }).props.refresh;
    await act(async () => { shown.onRefresh(); });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(descriptorReload).toHaveBeenCalledTimes(1);
  });

  it('turns an unreadable-descriptor choice usable in the same open sheet once Refresh re-reads a recovered source', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    descriptorSource.readable = false;
    descriptorReload.mockImplementation(() => { descriptorSource.readable = true; });
    const testID = 'agent-connected-account-purpose:primary';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{ purpose: 'primary', service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, required: false }}
      value={null}
      onChange={vi.fn()}
      onReload={() => new Promise<void>((resolve) => { setTimeout(resolve, 0); })}
    />);
    await act(async () => { findItemByTestId(screen, testID)?.props.onPress(); });
    type Opts = Readonly<{ rootStep: { sections: ReadonlyArray<{ options: ReadonlyArray<{ id: string; subtitle?: string; disabled?: boolean }> }> };
      refresh: { onRefresh: () => void } }>;
    const account = (props: Opts) => props.rootStep.sections[0]!.options.find((option) => option.subtitle?.includes('Personal OpenAI') || option.id.includes('35f1d8ec'))!;
    const opened = latestPurposeTargetModalConfig() as { props: Opts };
    expect(account(opened.props).disabled).toBe(true);
    expect(account(opened.props).subtitle).toContain(t('connectedServices.purposeTargets.serviceLookupFailed'));
    await act(async () => { opened.props.refresh.onRefresh(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const refreshed = latestPurposeTargetModalConfig().props as Opts;
    expect(account(refreshed).disabled).toBe(false);
    expect(modalSpies.show).toHaveBeenCalledTimes(1);
  });

  it('says Loading, not a failed check, while the descriptor registry is still answering', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    descriptorSource.readable = false;
    descriptorSource.status = 'loading';
    const testID = 'agent-connected-account-purpose:primary';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{ purpose: 'primary', service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, required: false }}
      value={null}
      onChange={vi.fn()}
    />);
    await act(async () => { findItemByTestId(screen, testID)?.props.onPress(); });
    const opened = latestPurposeTargetModalConfig() as { props: { rootStep: { sections: ReadonlyArray<{ options: ReadonlyArray<{ subtitle?: string }> }> } } };
    const subtitles = opened.props.rootStep.sections[0]!.options.map((option) => option.subtitle ?? '').join('|');
    expect(subtitles).toContain(t('common.loading'));
    expect(subtitles).not.toContain(t('connectedServices.purposeTargets.serviceLookupFailed'));
  });

  it('does not reload another registry scope when the surface supplies its own registry', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const testID = 'agent-connected-account-purpose:scoped';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{ purpose: 'primary', service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, required: false }}
      value={null}
      onChange={vi.fn()}
      onReload={vi.fn(async () => undefined)}
      registry={{ scopeKey: 'other', status: 'ready', errorReason: null, entries: [] }}
    />);
    await act(async () => { findItemByTestId(screen, testID)?.props.onPress(); });
    const shown = (latestPurposeTargetModalConfig() as { props: { refresh: { onRefresh: () => void } } }).props.refresh;
    await act(async () => { shown.onRefresh(); });
    expect(descriptorReload).not.toHaveBeenCalled();
  });

  it('draws a page row as the shared field select, saying the pool summary or what repairs it', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
    const service = { pluginId: 'acme.managed.provider', localId: 'gateway' };
    const pool = (groupId: string, displayName: string, members: string[]) => ({
      v: 1, ref: { service, groupId }, incarnation: `row-${groupId}`, displayName,
      policy: { v: 2, strategy: 'expiry_first', autoSwitch: true },
      activeConnectedAccountId: members[0] ?? null, generation: 1, runtimeStateRevision: 1, state: { status: 'ready' },
      createdAt: 1, updatedAt: 1,
      members: members.map((connectedAccountId) => ({ v: 1, connectedAccountId, priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
    });
    const testID = 'provider-gateway-slot:openai';
    const render = (groupId: string) => (
      <ListPresentationProvider value="page">
        <ConnectedAccountPurposeTargetChooser testID={testID} localizedTextPluginId="acme.provider.author"
          declaration={{ purpose: 'openai', service, required: false }}
          value={{ kind: 'group', service, groupId }} onChange={vi.fn()} />
      </ListPresentationProvider>
    );
    seedAccountProfile();
    const screen = await renderBaseScreen(<View />);
    await act(async () => {
      storage.setState({ profile: { ...storage.getState().profile,
        connectedAccountGroupsV4: [pool('work', 'Work pool', ['35f1d8ec-633c-4bda-9e0d-7055ac95b8af']), pool('codex', 'Codex pool', [])] } as never });
      screen.tree.update(render('work'));
    });
    const row = () => findItemByTestId(screen, testID)!;
    // The value lives in the bordered field (lab GW1), not as a navigation row's detail.
    expect(row().props).toMatchObject({ fieldAccessory: true, accessoryLayout: 'adaptive', showChevron: false });
    expect(row().props.detail).toBeUndefined();
    expect(row().props.rightElement).toBeTruthy();
    expect(row().props.subtitle).toBe('1 account · using Personal OpenAI');
    // A saved pool that cannot serve (D14) keeps its value and says what fixes it.
    await act(async () => { screen.tree.update(render('codex')); });
    expect(row().props.subtitle).toBe(t('connectedServices.purposeTargets.poolEmpty'));
    await act(async () => { row().props.onPress(); });
    expect(latestPurposeTargetModalConfig().props.rootStep.sections[0].options.length).toBeGreaterThan(0);
  });

  it('offers accounts only, and asks for an account, when its consumer stores one exact account', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const service = { pluginId: 'acme.managed.provider', localId: 'gateway' };
    const testID = 'relay-access:credential:tunnel.manage';
    const render = (accountsOnly: boolean) => (
      <ConnectedAccountPurposeTargetChooser testID={testID} localizedTextPluginId="acme.provider.author"
        declaration={{ purpose: 'tunnel.manage', service, required: true }}
        value={null} onChange={vi.fn()} accountsOnly={accountsOnly} />
    );
    seedAccountProfile();
    const screen = await renderBaseScreen(<View />);
    await act(async () => {
      storage.setState({ profile: { ...storage.getState().profile,
        connectedAccountGroupsV4: [{
          v: 1, ref: { service, groupId: 'work' }, incarnation: 'row-work', displayName: 'Work pool',
          policy: { v: 2, strategy: 'expiry_first', autoSwitch: true },
          activeConnectedAccountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af', generation: 1, runtimeStateRevision: 1,
          state: { status: 'ready' }, createdAt: 1, updatedAt: 1,
          members: [{ v: 1, connectedAccountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }],
        }] } as never });
      screen.tree.update(render(false));
    });
    const row = () => findItemByTestId(screen, testID)!;
    const offeredLabels = async () => {
      await act(async () => { row().props.onPress(); });
      return latestPurposeTargetModalConfig().props.rootStep.sections[0].options.map((option) => option.label);
    };
    expect(await offeredLabels()).toEqual(expect.arrayContaining(['Personal OpenAI', 'Work pool']));

    await act(async () => { screen.tree.update(render(true)); });
    expect(row().props.subtitle).toBe(t('connectedServices.purposeTargets.requiredAccountPrompt'));
    const accountsOnly = await offeredLabels();
    expect(accountsOnly).toContain('Personal OpenAI');
    expect(accountsOnly).not.toContain('Work pool');
  });

  it('names an unset optional purpose in words, from the consumer when it knows what unset means', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const declaration = {
      purpose: 'primary',
      service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
      required: false,
    };
    const testID = 'agent-connected-account-purpose:primary';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={declaration}
      value={null}
      onChange={vi.fn()}
    />);
    expect(findItemByTestId(screen, testID)?.props.detail).toBe('Not set');

    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser
        testID={testID}
        localizedTextPluginId="acme.provider.author"
        declaration={declaration}
        value={null}
        noneLabel="Claude’s own sign-in"
        onChange={vi.fn()}
      />);
    });
    expect(findItemByTestId(screen, testID)?.props.detail).toBe('Claude’s own sign-in');
    await act(async () => {
      findItemByTestId(screen, testID)?.props.onPress();
    });
    const options = latestPurposeTargetModalConfig().props.rootStep.sections[0].options;
    expect(options[0]).toEqual(expect.objectContaining({ id: 'none', label: 'Claude’s own sign-in' }));
  });

  it('falls back to the canonical service display name for a legacy titleless purpose', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID="provider-connection-managed-purpose-chooser:openai-upstream"
      localizedTextPluginId="acme.provider.author"
      declaration={{
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        required: true,
      }}
      value={null}
      onChange={vi.fn()}
    />);
    const trigger = findItemByTestId(screen, 'provider-connection-managed-purpose-chooser:openai-upstream');

    expect(trigger?.props).toEqual(expect.objectContaining({
      title: 'Acme Gateway account',
      accessibilityLabel: 'Acme Gateway account · Choose an account or group',
    }));
  });

  it('hands 601 account rows to the shared automatic virtualization owner without a local limit', async () => {
    connectedAccountState.additionalAccounts = Array.from({ length: 600 }, (_, index) => ({
      ref: {
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        accountId: `scale-account-${String(index).padStart(4, '0')}`,
      },
      status: 'connected',
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: `csr_${String(index).padStart(22, '0')}`,
      configurationReady: true,
      configurationRevision: null,
      displayName: `Scale account ${index}`,
      scopes: [],
    }));
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const testID = 'provider-connection-managed-purpose-chooser:scale';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        title: 'Use OpenAI upstream account',
        required: true,
      }}
      value={null}
      onChange={vi.fn()}
    />);

    await act(async () => {
      findItemByTestId(screen, testID)?.props.onPress();
    });

    const section = latestPurposeTargetModalConfig().props.rootStep.sections[0];
    expect(section.options).toHaveLength(601);
    expect(section.virtualization).toBeUndefined();
    expect(section.options[0]?.label).toBe('Personal OpenAI');
    expect(section.options.map((option) => option.label)).toContain('Scale account 599');
  });
});
