import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  type ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol';
import {
  connectedServicesModuleState,
  installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { modalAlertSpy, modalConfirmSpy } = vi.hoisted(() => ({
  modalAlertSpy: vi.fn(async () => undefined),
  modalConfirmSpy: vi.fn(async () => true),
}));

installConnectedServicesCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertSpy,
        confirm: modalConfirmSpy,
      },
    }).module;
  },
});

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
  useActiveServerSnapshot: () => ({
    serverId: 'server-a',
    serverUrl: 'https://server-a.example.test',
    generation: 1,
  }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesRuntimeSnapshot: () => ({
    status: 'ready',
    features: {
      capabilities: {
        connectedServices: {
          qualifiedAccounts: { protocolVersion: 4 },
          credentialDelete: { revisionGuard: true },
        },
      },
    },
  }),
}));

vi.mock('@/sync/ops/connectedAccounts/connectedAccountDaemon', () => ({
  runConnectedAccountControlCommand: vi.fn(async () => ({
    status: 'described',
    service: {
      pluginId: 'happier.agent.claude',
      localId: 'anthropic',
    },
    operationTransport: {
      kind: 'legacy',
      peerClass: 'revisioned_v2_v3',
      serviceId: 'anthropic',
    },
  })),
}));

const useSettingsSpy = vi.fn(() => ({
  connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
  connectedServicesProfileLabelByKey: {},
  connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
  connectedServicesQuotaSummaryStrategyByKey: {},
}));
const useProfileSpy = vi.fn(() => ({
  connectedAccountsV4: [],
  connectedServicesV2: [
    {
      serviceId: 'anthropic',
      profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
    },
  ],
}));
const connectedServicesRegistryState = vi.hoisted(() => ({
  entries: [{
    serviceId: 'anthropic',
    legacyServiceId: 'anthropic',
    service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
    connectCommand: 'happier connect anthropic',
    supportsOauth: true,
    executable: true,
    projectedTitle: 'Anthropic',
  }] as Array<Record<string, unknown>>,
}));
const { setSettingMutableSpy } = vi.hoisted(() => ({
  setSettingMutableSpy: vi.fn(),
}));
const { providerStateSharingSetting } = vi.hoisted(() => ({
  providerStateSharingSetting: {
    current: {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    },
  },
}));

function buildExpectedSharedStateRiskAcknowledgements(): Partial<Record<AgentId, { sharedStatePrivacy: true }>> {
  const acknowledgements: Partial<Record<AgentId, { sharedStatePrivacy: true }>> = {};
  for (const agentId of AGENT_IDS) {
    const stateCapability = getAgentCore(agentId).connectedServices?.providerStateSharing?.state;
    if (
      stateCapability?.supported === true
      && stateCapability.modes.includes('shared')
      && stateCapability.sharedStatePrivacyRiskAcknowledgementRequired === true
    ) {
      acknowledgements[agentId] = { sharedStatePrivacy: true };
    }
  }
  return acknowledgements;
}

function expectSharingSettingChange(expected: ConnectedServicesProviderStateSharingSettingsV1) {
  const change: unknown = setSettingMutableSpy.mock.lastCall?.[0];
  const next = typeof change === 'function'
    ? change(ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSetting.current))
    : change;
  expect(next).toEqual(expected);
}

vi.mock('@/sync/store/hooks', () => ({
  useActiveServerAccountScope: () => null,
  useAllMachines: () => [{ id: 'machine-a', active: true }],
  useProfile: () => useProfileSpy(),
  useSettings: () => useSettingsSpy(),
  // Device-local preferences keep their defaults (the page rows read the list density).
  useLocalSetting: (name: string) => (name === 'uiItemDensity' ? 'comfortable' : undefined),
  // Read by the segmented control's motion preferences; defaults apply.
  useSetting: () => undefined,
  useSettingMutable: (name: string) => [
    name === 'connectedServicesProviderStateSharingSettingsV1'
      ? providerStateSharingSetting.current
      : undefined,
    setSettingMutableSpy,
  ],
}));

vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
  useHomeTeamCredentialModelCatalog: () => ({
    resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: true, condition: null,
  }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useAppShellPluginUiProjection: () => ({ machineId: null, serverId: null }),
  useProjectedPluginLocalizedTextResolver: () => (_pluginId: string, value: unknown) => (typeof value === 'string' ? value : ''),
  useProjectedConnectedServicesRegistry: () => ({
    scopeKey: 'server-a', status: 'ready', errorReason: null,
    entries: connectedServicesRegistryState.entries,
  }),
}));

// The machine projection is a daemon read; sharing uses the real bundled agent capabilities.
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => ({ phase: 'ready', inputs: null }),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/domains/connectedServices/connectedServiceRegistry')>();
  return {
    ...actual,
    getLegacyConnectedServiceRegistryEntry: (serviceId: string) => (
      connectedServicesRegistryState.entries.find((entry) => entry.legacyServiceId === serviceId)
        ?? actual.getLegacyConnectedServiceRegistryEntry(serviceId)
    ),
  };
});

const {
  fetchAccountEncryptionModeSpy,
  getConnectedServiceQuotaSnapshotPlainSpy,
  getConnectedServiceQuotaSnapshotSealedSpy,
} = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee' as const, updatedAt: 0 })),
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
  ConnectedServicesDefaultAuthRow: (props: Record<string, unknown>) => React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('@/sync/store/settingsWriters', () => ({ useApplySettings: () => vi.fn() }));

describe('ConnectedServicesAgentSignInView sharing and legacy routing', () => {
  beforeEach(async () => {
    setSettingMutableSpy.mockClear();
    modalAlertSpy.mockClear();
    modalConfirmSpy.mockClear();
    // Bind the spies to the modal module the view actually loaded. The shared helper's factory can
    // run before this file's options are installed (when a static import reaches `@/modal` first),
    // which would leave the view on a default modal that declines every confirmation.
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockImplementation(modalConfirmSpy);
    vi.mocked(Modal.alert).mockImplementation(modalAlertSpy);
    connectedServicesModuleState.routerPushSpy.mockClear();
    connectedServicesRegistryState.entries = [{
      serviceId: 'anthropic',
      legacyServiceId: 'anthropic',
      service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
      connectCommand: 'happier connect anthropic',
      supportsOauth: true,
      executable: true,
      projectedTitle: 'Anthropic',
    }];
    useProfileSpy.mockReset();
    useProfileSpy.mockReturnValue({
      connectedAccountsV4: [],
      connectedServicesV2: [
        {
          serviceId: 'anthropic',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
        },
      ],
    });
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };
  });

  it('updates global provider state sharing settings from connected services controls', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

    const screen = await renderScreen(<ConnectedServicesAgentSignInView />);
    await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');

    await screen.tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-state-default' })[0]!.props.onPress();
    // Sharing state asks for the privacy acknowledgement first; the write follows the answer.
    await vi.waitFor(() => expect(modalConfirmSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(setSettingMutableSpy).toHaveBeenCalled());
    expectSharingSettingChange({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'shared' },
      byAgentId: {},
      acknowledgedRisksByAgentId: buildExpectedSharedStateRiskAcknowledgements(),
    });
    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
  });

  it('selects copied provider config sharing as a distinct mode', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'copied', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };

    const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

    const screen = await renderScreen(<ConnectedServicesAgentSignInView />);
    await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');

    const configModeControl = screen.tree.root.findAllByProps({
      testID: 'connected-services-provider-state-sharing-config-default',
    })[0]!;
    expect(configModeControl.props.value).toBe('copied');
    configModeControl.props.onChange('isolated');

    expectSharingSettingChange({
      v: 1,
      defaults: { configMode: 'isolated', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });

    configModeControl.props.onChange('linked');
    expectSharingSettingChange({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('renders provider state sharing rows from agent capabilities', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

    const screen = await renderScreen(<ConnectedServicesAgentSignInView />);
    const tree = screen.tree;
    await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');

    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-backend-overrides' })).not.toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-agent-codex-state' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-agent-pi-state' })).toHaveLength(0);
  });

  it('withholds legacy default-auth recovery without a projected qualified owner', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    useSettingsSpy.mockReturnValue({
      connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': [] },
      connectedServicesQuotaSummaryStrategyByKey: {},
    });
    connectedServicesRegistryState.entries = [];
    useProfileSpy.mockReturnValue({
      connectedAccountsV4: [],
      connectedServicesV2: [
        {
          serviceId: 'anthropic',
          profiles: [{ profileId: 'work', status: 'needs_reauth', providerEmail: null }],
        },
      ],
    });

    const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
    const { tree } = await renderScreen(<ConnectedServicesAgentSignInView />);

    expect(tree.root.findAllByType('ConnectedServicesDefaultAuthRow' as never)).toHaveLength(0);
    expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
  });

  it('keeps provider state sharing settings available when optional Connected Accounts features are disabled', async () => {
    useFeatureEnabledSpy.mockReturnValue(false);

    const { ConnectedServicesProviderStateSharingSettingsView } = await import('./ConnectedServicesProviderStateSharingSettings');
    const { tree } = await renderScreen(<ConnectedServicesProviderStateSharingSettingsView />);

    expect(tree.toJSON()).not.toBeNull();
    expect(tree.root.findByProps({
      testID: 'connected-services-provider-state-sharing-agent-codex-state',
    })).toBeTruthy();
  });

  it('writes provider state sharing overrides by agent id', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesProviderStateSharingBackendGroups } = await import('./ConnectedServicesProviderStateSharingSettings');

    const { tree } = await renderScreen(
      <ConnectedServicesProviderStateSharingBackendGroups
        settings={ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSetting.current)}
        setSettings={setSettingMutableSpy}
        agentIds={['codex']}
      />,
    );

    await tree.root
      .findByProps({ testID: 'connected-services-provider-state-sharing-agent-codex-state' })
      .props.onPress();

    await vi.waitFor(() => expect(modalConfirmSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(setSettingMutableSpy).toHaveBeenCalled());
    expectSharingSettingChange({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {
        codex: { stateMode: 'shared' },
      },
      acknowledgedRisksByAgentId: {
        codex: { sharedStatePrivacy: true },
      },
    });
    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
  });
});
