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
  primaryStatus: 'connected' as 'connected' | 'needs_reauth',
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
        status: connectedAccountState.primaryStatus,
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
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', async () => {
  const { ConnectedAccountUiProjectionEntryV1Schema } = await import('@happier-dev/protocol/connect/connectedAccountUiProjectionV1');
  const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({
    id: 'gateway', serviceId: 'gateway', pluginId: 'acme.managed.provider',
    provenance: 'external', sourceKind: 'test', title: 'Acme Gateway account',
    authentication: { defaultModeId: 'oauth', modes: [{
      id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback',
      pkce: 'required', outcomeReconciliation: 'none',
    }] },
    capabilities: [], availability: { state: 'available', reason: 'ready' }, diagnostics: [],
  });
  return {
    useProjectedConnectedServicesRegistry: () => ({
      scopeKey: 'server-a', status: descriptorSource.status, errorReason: null,
      entries: connectedServiceRegistryState.entries.map(entry => ({ ...entry,
        ...(descriptorSource.readable ? { projectedDescriptor: descriptor } : {}),
      })),
    }),
    useProjectedPluginLocalizedTextResolver: () => localizationSpies.resolve,
    useAppShellPluginUiProjection: (select: (value: { reloadConnectedAccountProjection: typeof descriptorReload }) => unknown) =>
        select({ reloadConnectedAccountProjection: descriptorReload }),
  };
});
vi.mock('@/sync/domains/features/featureDecisionRuntime', async importOriginal => {
  const actual = await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>();
  const snapshot = () => ({
    status: featureRuntimeState.status,
    features: { capabilities: { connectedServices: {
      qualifiedAccounts: featureRuntimeState.qualifiedAccounts ? { protocolVersion: 4 } : undefined,
    } } },
  });
  // The connect sheet this case opens reads the same Home features by server id.
  return { ...actual, useServerFeaturesRuntimeSnapshot: snapshot, useServerFeaturesSnapshotForServerId: snapshot };
});

afterEach(async () => {
  await modalScreen.unmount();
  modalBoundary.config = null;
  storage.setState(initialStorageState, true);
  featureRuntimeState.status = 'ready';
  featureRuntimeState.qualifiedAccounts = true;
  routeState.pathname = '/settings/providers/cpx-moving';
  connectedAccountState.additionalAccounts = [];
  connectedAccountState.primaryStatus = 'connected';
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
    onSelect: React.ComponentProps<typeof SelectionList>['onSelect'];
    refresh: Readonly<{ onRefresh: () => void }> | null;
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
  const props = modalScreen.findByType(SelectionList).props;
  const section = props.rootStep?.sections[0];
  if (!section || section.kind !== 'static') throw new Error('Expected a static purpose-target list');
  const refresh = captured.props.refresh;
  const refreshProps = refresh && typeof refresh === 'object' ? refresh : null;
  const onRefresh = refreshProps ? Reflect.get(refreshProps, 'onRefresh') : null;
  return { ...captured, props: { ...captured.props, ...props, onSelect: props.onSelect, rootStep: { sections: [section] },
    refresh: typeof onRefresh === 'function' ? { ...refreshProps, onRefresh: () => { onRefresh(); } } : null } };
}

function findItemByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.findAllByType(Item).find((node) => node.props?.testID === testID);
}

// The sign-in-again case lives beside the owner's suite while that file carries another lane's unfinished harness edits.
describe('ConnectedAccountPurposeTargetChooser signed-out rows', () => {
  it.each(['needs_reauth', 'connected'] as const)('offers a new credential only if the retained sign-ins all need reconnect (%s)', async status => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    connectedAccountState.primaryStatus = status;
    connectedAccountState.additionalAccounts = [{
      ref: { service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, accountId: '6b0f2c1e-8d1a-4c55-9a3e-2f7f0c9b1d42' },
      status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb', configurationReady: true, configurationRevision: null,
      displayName: 'Work OpenAI', scopes: [],
    }];
    const testID = 'agent-connected-account-purpose:primary';
    const onAddAccount = vi.fn();
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{ purpose: 'primary', service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, required: true }}
      value={null}
      accountsOnly
      onChange={vi.fn()}
      addAccount={{ label: 'Add token', onPress: onAddAccount }}
    />);
    await act(async () => { findItemByTestId(screen, testID)?.props.onPress(); });
    if (status === 'connected') {
      expect(modalScreen.findByTestId(`${testID}:add-account`)).toBeNull();
    } else {
      await modalScreen.pressByTestIdAsync(`${testID}:add-account`);
      expect(onAddAccount).toHaveBeenCalledOnce();
      expect(modalBoundary.config).toBeNull();
    }
  });

  it('lets a signed-out account sign in again from the picker through the shared connect sheet (PAGE-ACCEPT-176 R8-D6)', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    connectedAccountState.additionalAccounts = [{
      ref: { service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, accountId: '6b0f2c1e-8d1a-4c55-9a3e-2f7f0c9b1d42' },
      status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb', configurationReady: true, configurationRevision: null,
      displayName: 'Work OpenAI', scopes: [],
    }];
    const testID = 'agent-connected-account-purpose:primary';
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID={testID}
      localizedTextPluginId="acme.provider.author"
      declaration={{ purpose: 'primary', service: { pluginId: 'acme.managed.provider', localId: 'gateway' }, required: false }}
      value={null}
      accountsOnly
      onChange={vi.fn()}
    />);
    await act(async () => { findItemByTestId(screen, testID)?.props.onPress(); });
    const opened = latestPurposeTargetModalConfig();
    const signedOut = opened.props.rootStep.sections[0].options.find(option => option.id.includes('6b0f2c1e'))!;
    // The row says what fixes it and is the way to do it, not a disabled dead end.
    expect({ disabled: signedOut.disabled ?? false, subtitle: signedOut.subtitle }).toEqual({ disabled: false,
      subtitle: expect.stringContaining(t('connectedServices.purposeTargets.accountReconnect')) });
    const shownBefore = modalSpies.show.mock.calls.length;
    await act(async () => { opened.props.onSelect(signedOut.id); });
    const sheet = modalSpies.show.mock.calls.slice(shownBefore).map(([config]) => (config as { chrome?: { testID?: string } }).chrome?.testID);
    expect(sheet).toContain('connect-sheet');
  });
});
