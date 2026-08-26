import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from '@/components/ui/forms/dropdown/dropdownTestHelpers';
import type { PopoverRenderProps } from '@/components/ui/popover/_types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({ pathname: '/settings/providers/cpx-moving' }));
const featureRuntimeState = vi.hoisted(() => ({
  status: 'ready' as 'loading' | 'ready',
}));
const connectedServiceRegistryState = vi.hoisted(() => ({
  entries: [{
    serviceId: 'acme-gateway-account',
    service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
    connectCommand: 'happier connect acme-gateway-account',
    supportsOauth: true,
    projectedTitle: 'Acme Gateway account',
  }] as Array<Record<string, unknown>>,
}));

type PopoverMockProps = Readonly<Record<string, unknown> & {
  children?: React.ReactNode | ((bounds: PopoverRenderProps) => React.ReactNode);
}>;

installDropdownCommonModuleMocks();

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ pathname: () => routeState.pathname }).module;
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: (props: PopoverMockProps) => {
    const children = props.children;
    return React.createElement(
      'Popover',
      props,
      typeof children === 'function'
        ? children({
          maxHeight: 200,
          maxWidth: 400,
          placement: 'bottom',
          requestClose: () => {},
        })
        : children ?? null,
    );
  },
  PopoverScope: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
  FloatingOverlay: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement(
    'FloatingOverlay',
    props,
    props.children,
  ),
}));

vi.mock('@/components/ui/forms/dropdown/useSelectableMenu', () => ({
  useSelectableMenu: () => ({
    searchQuery: '',
    selectedIndex: 0,
    filteredCategories: [],
    inputRef: { current: null },
    setSelectedIndex: () => {},
    handleSearchChange: () => {},
    handleKeyPress: () => {},
  }),
  CREATE_ITEM_ID: '__create__',
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
  SelectableMenuResults: (props: Record<string, unknown>) => React.createElement('SelectableMenuResults', props),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => false }));
vi.mock('@/components/ui/scroll/useScrollRectIntoView', () => ({
  useScrollRectIntoViewRegistry: () => ({
    scrollRef: { current: null },
    registerItemLayout: () => () => {},
    onViewportLayout: () => {},
    onContentSizeChange: () => {},
    onScroll: () => {},
  }),
}));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, props.children),
  TextInput: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/sync/store/hooks', () => ({
  useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : 'comfortable',
  useProfile: () => ({
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
    }],
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
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesRuntimeSnapshot: () => ({
    status: featureRuntimeState.status,
    features: { capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } },
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
  routeState.pathname = '/settings/providers/cpx-moving';
});

describe('ConnectedAccountPurposeTargetChooser', () => {
  it('closes its portal-backed menu when a retained settings screen changes route', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const props = {
      testID: 'provider-connection-managed-purpose-chooser:openai-upstream',
      declaration: {
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        title: 'Use OpenAI upstream account',
        required: true,
      },
      value: null,
      onChange: vi.fn(),
      onReload: vi.fn(),
      reloadSubtitle: 'settingsProviders.status.disabled',
    };
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser {...props} />);
    const dropdown = screen.tree.findByType(DropdownMenu);

    expect(dropdown.props.itemTrigger).toEqual(expect.objectContaining({
      title: 'Use OpenAI upstream account',
      itemProps: expect.objectContaining({
        accessibilityLabel: 'Use OpenAI upstream account · common.unavailable',
      }),
    }));
    expect(dropdown.props.itemTrigger.title).not.toContain('openai-upstream');
    expect(dropdown.props.itemTrigger.title).not.toContain('acme.managed.provider');
    expect(dropdown.props.itemTrigger.title).not.toContain('gateway');
    expect(dropdown.props.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Personal OpenAI',
        subtitle: 'Acme Gateway account',
        accessibilityLabel: 'Acme Gateway account · Personal OpenAI',
        disabled: false,
      }),
    ]));
    // The canonical accountId is routing identity, not copy: it may key the row
    // and its testID, but no field a user reads or a screen reader speaks.
    for (const item of dropdown.props.items) {
      expect(item.title).not.toContain('35f1d8ec-633c-4bda-9e0d-7055ac95b8af');
      expect(item.subtitle ?? '').not.toContain('35f1d8ec-633c-4bda-9e0d-7055ac95b8af');
      expect(item.accessibilityLabel ?? '').not.toContain('35f1d8ec-633c-4bda-9e0d-7055ac95b8af');
    }
    expect(screen.tree.findAll((node) => (
      node.props?.testID === `${props.testID}:reload`
    ))[0]?.props.subtitle).toBe('settingsProviders.status.disabled');

    await act(async () => {
      dropdown.props.onOpenChange(true);
    });
    expect(screen.root.findAllByType('Popover' as never)).toHaveLength(1);

    routeState.pathname = '/settings/connected-services';
    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser {...props} />);
    });

    expect(screen.root.findAllByType('Popover' as never)).toHaveLength(0);
  });

  it('labels a selected target and an indeterminate transport without raw purpose identifiers', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const props = {
      testID: 'provider-connection-managed-purpose-chooser:openai-upstream',
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
    const dropdown = screen.tree.findByType(DropdownMenu);

    expect(dropdown.props.itemTrigger.itemProps.accessibilityLabel).toBe(
      'Use OpenAI upstream account · Acme Gateway account · Personal OpenAI',
    );

    featureRuntimeState.status = 'loading';
    await act(async () => {
      screen.tree.update(<ConnectedAccountPurposeTargetChooser {...props} />);
    });

    expect(screen.tree.findByType(DropdownMenu).props.itemTrigger.itemProps.accessibilityLabel).toBe(
      'Use OpenAI upstream account · common.loading',
    );
  });

  it('falls back to the canonical service display name for a legacy titleless purpose', async () => {
    const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const screen = await renderScreen(<ConnectedAccountPurposeTargetChooser
      testID="provider-connection-managed-purpose-chooser:openai-upstream"
      declaration={{
        purpose: 'openai-upstream',
        service: { pluginId: 'acme.managed.provider', localId: 'gateway' },
        required: true,
      }}
      value={null}
      onChange={vi.fn()}
    />);
    const trigger = screen.tree.findByType(DropdownMenu).props.itemTrigger;

    expect(trigger).toEqual(expect.objectContaining({
      title: 'Acme Gateway account',
      itemProps: expect.objectContaining({
        accessibilityLabel: 'Acme Gateway account · common.unavailable',
      }),
    }));
  });
});
