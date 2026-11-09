import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

import {
  ProviderGatewaySections,
  partitionProviderGatewayFamilies,
  type ProviderGatewaySectionsProps,
} from './ProviderGatewaySections';

const initialStorageState = storage.getState();

const CODEX = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const MUSE = { pluginId: 'happier.agent.muse', localId: 'muse' };
const XAI = { pluginId: 'happier.service.xai', localId: 'xai' };
const DECLARATIONS = [
  { purpose: 'openai-upstream', service: CODEX, required: false },
  { purpose: 'meta-upstream', service: MUSE, required: false },
  { purpose: 'xai-upstream', service: XAI, required: false },
];

function seedAccounts(services: readonly (typeof CODEX)[]) {
  storage.setState({
    profileScope: { serverId: 'server-a', accountId: 'account-a' },
    profile: AccountProfileSchema.parse({
      ...profileDefaults,
      id: 'account-a',
      connectedAccountsV4: services.map((service, index) => ({
        ref: {
          service,
          accountId: `35f1d8ec-633c-4bda-9e0d-7055ac95b8a${index}`,
        },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        configurationReady: true,
        configurationRevision: null,
        displayName: `Account ${index}`,
        scopes: [],
      })),
      connectedAccountGroupsV4: [],
    }),
  });
}

function render(overrides: Partial<ProviderGatewaySectionsProps> = {}) {
  const props: ProviderGatewaySectionsProps = {
    localizedTextPluginId: 'happier.provider.cliproxyapi',
    declarations: DECLARATIONS,
    slots: {},
    onChangeSlot: vi.fn(),
    onConnectService: vi.fn(),
    placement: undefined,
    machines: [],
    reachability: 'not_checked',
    onChangePlacement: vi.fn(),
    helperModels: undefined,
    modelRoles: [],
    models: [],
    onChangeHelperModels: vi.fn(),
    disabled: false,
    pickerRows: null,
    nameRow: null,
    ...overrides,
  } as ProviderGatewaySectionsProps;
  return renderScreen(<ProviderGatewaySections {...props} />);
}

afterEach(() => {
  storage.setState(initialStorageState, true);
});

describe('gateway families (lab muse-accounts C1/C2)', () => {
  it('folds families with no account behind Add more, and shows every family when none is connected', () => {
    const none = partitionProviderGatewayFamilies(DECLARATIONS, {}, new Set());
    expect(none.shown.map((family) => family.purpose)).toEqual([
      'openai-upstream',
      'meta-upstream',
      'xai-upstream',
    ]);
    expect(none.folded).toEqual([]);

    const one = partitionProviderGatewayFamilies(
      DECLARATIONS,
      {},
      new Set(['happier.agent.codex/openai-codex']),
    );
    expect(one.shown.map((family) => family.purpose)).toEqual([
      'openai-upstream',
    ]);
    expect(one.folded.map((family) => family.purpose)).toEqual([
      'meta-upstream',
      'xai-upstream',
    ]);

    // A saved slot keeps its row even after its account is gone, so the person can see and change it.
    const saved = partitionProviderGatewayFamilies(
      DECLARATIONS,
      { 'xai-upstream': { kind: 'account' } },
      new Set(['happier.agent.codex/openai-codex']),
    );
    expect(saved.shown.map((family) => family.purpose)).toEqual([
      'openai-upstream',
      'xai-upstream',
    ]);
    expect(saved.folded.map((family) => family.purpose)).toEqual([
      'meta-upstream',
    ]);
  });

  it('lists every family with its Connect when nothing is connected, with no Add more row', async () => {
    seedAccounts([]);
    const screen = await render();
    expect(screen.findByTestId('provider-gateway-add-more')).toBeNull();
    for (const purpose of [
      'openai-upstream',
      'meta-upstream',
      'xai-upstream',
    ]) {
      expect(
        screen.findByTestId(`provider-gateway-slot:${purpose}:connect`),
      ).toBeTruthy();
    }
  });

  it('keeps a closed Add more free: its family rows are not mounted until it opens, then each offers Connect', async () => {
    seedAccounts([CODEX]);
    const onConnectService = vi.fn();
    const screen = await render({ onConnectService });

    expect(
      screen.findByTestId('provider-gateway-slot:openai-upstream'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('provider-gateway-add-more:header'),
    ).toBeTruthy();
    // Closed: no row of a folded family exists, so none subscribes or reads.
    expect(
      screen.findByTestId('provider-gateway-slot:meta-upstream'),
    ).toBeNull();
    expect(
      screen.findByTestId('provider-gateway-slot:xai-upstream'),
    ).toBeNull();

    await act(async () => {
      screen.findByTestId('provider-gateway-add-more:header')!.props.onPress();
    });
    const connect = screen.findByTestId(
      'provider-gateway-slot:meta-upstream:connect',
    );
    expect(connect).toBeTruthy();
    const trigger = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 24, height: 24 }) };
    await act(async () => {
      connect!.props.onPress({ currentTarget: trigger });
    });
    // Connect opens the one connect sheet at the pressed button.
    expect(onConnectService).toHaveBeenCalledWith(
      'happier.agent.muse/muse',
      { kind: 'view', ref: { current: trigger } },
    );
  });

  it("ends a restricted family's line with what it serves, and replaces what it needs with a typed reason", async () => {
    seedAccounts([]);
    const screen = await render({
      familyFacts: {
        'xai-upstream': {
          restriction: {
            summary: 'chat requests only',
            sentence:
              'xAI answers chat requests here; image and compact requests are not available.',
          },
        },
        'meta-upstream': {
          unavailableReason: 'Shared for Muse Code only · Maya can allow it',
        },
      },
    });
    const subtitleOf = (purpose: string) =>
      screen.root.findAll(
        (node) =>
          node.props?.testID === `provider-gateway-slot:${purpose}` &&
          typeof node.props?.subtitle === 'string',
      )[0]?.props.subtitle;
    expect(subtitleOf('xai-upstream')).toMatch(/ · chat requests only$/);
    expect(subtitleOf('meta-upstream')).toBe(
      'Shared for Muse Code only · Maya can allow it',
    );
    expect(subtitleOf('openai-upstream')).not.toContain(' · ');
  });
});
