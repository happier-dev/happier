import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({ pathname: '/settings/providers/cpx-moving' }));
const featureRuntimeState = vi.hoisted(() => ({
  status: 'ready' as 'loading' | 'ready',
  qualifiedAccounts: true,
}));
const connectedAccountState = vi.hoisted(() => ({
  additionalAccounts: [] as Array<Record<string, unknown>>,
  profileId: 'account-a' as string,
}));
const modalSpies = vi.hoisted(() => ({ show: vi.fn((_config: unknown) => 'purpose-target-modal'), hide: vi.fn() }));
const localizationSpies = vi.hoisted(() => ({ resolve: vi.fn((_pluginId: string, value: string | { key: string; fallback: string }) => (
  typeof value === 'string' ? value : `localized:${value.key}`
)) }));
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
  },
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, props.children),
  TextInput: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => ({ serverId: 'server-a', accountId: 'account-a' }),
  useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : 'comfortable',
  useProfile: () => ({
    id: connectedAccountState.profileId,
    connectedAccountsV4: [{
      ref: {
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
      },
      status: 'connected',
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'cred-1',
      configurationReady: true,
      configurationRevision: null,
      displayName: undefined,
      scopes: [],
    }, ...connectedAccountState.additionalAccounts],
    connectedAccountGroupsV4: [],
  }),
  useSettings: () => ({
    connectedServicesProfileLabelByKey: {
      'acme.managed.provider%2Fgateway/35f1d8ec-633c-4bda-9e0d-7055ac95b8af': 'Personal OpenAI',
    },
  }),
}));
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useProjectedConnectedServicesRegistry: () => ({
    scopeKey: 'server-a', status: 'ready', errorReason: null, entries: connectedServiceRegistryState.entries,
  }),
  useProjectedPluginLocalizedTextResolver: () => localizationSpies.resolve,
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
  getConnectedAccountAuthentication: () => ({
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      pkce: 'required',
      outcomeReconciliation: 'none',
    }],
  }),
  getQualifiedConnectedServiceRegistryEntry: () => null,
  getLegacyConnectedServiceRegistryEntry: () => ({
    serviceId: 'acme-gateway-account',
    connectCommand: 'happier connect acme-gateway-account',
    supportsOauth: true,
  }),
}));

afterEach(() => {
  featureRuntimeState.status = 'ready';
  featureRuntimeState.qualifiedAccounts = true;
  routeState.pathname = '/settings/providers/cpx-moving';
  connectedAccountState.additionalAccounts = [];
  connectedAccountState.profileId = 'account-a';
  modalSpies.show.mockClear();
  modalSpies.hide.mockClear();
  localizationSpies.resolve.mockClear();
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
  return config as CapturedPurposeTargetModalConfig;
}

function findItemByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.findAllByType('Item').find((node) => node.props?.testID === testID);
}

describe('ConnectedAccountPurposeTargetChooser', () => {
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
    expect(screen.tree.findAll((node) => (
      node.props?.testID === `${props.testID}:reload`
    ))[0]?.props.subtitle).toBe('settingsProviders.status.disabled');

    expect(modalSpies.show).toHaveBeenCalledTimes(1);

    routeState.pathname = '/settings/connected-services';
    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser {...props} />);
    });

    expect(modalSpies.hide).toHaveBeenCalledWith('purpose-target-modal');
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
      'Use OpenAI upstream account · Loading...',
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
      subtitle: 'Loading...',
      detail: 'Loading...',
    }));

    connectedAccountState.profileId = 'account-a';
    await act(async () => {
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
        subtitle: 'This server cannot show connected-account targets yet',
        detail: 'This server cannot show connected-account targets yet',
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
      credentialRevision: `cred-${index}`,
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
