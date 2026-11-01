import React from 'react';
import renderer from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  ConnectedServicesProviderStateSharingSettingsV1Schema,
} from '@happier-dev/protocol';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { modalConfirmSpy } = vi.hoisted(() => ({
  modalConfirmSpy: vi.fn(async () => true),
}));

installConnectedServicesCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalConfirmSpy } }).module;
  },
});

// The provider rows now render the brand mark via `SvgXml`; mock the native svg
// boundary to a host element so the test renderer can mount it (mirrors AccountBlock).
vi.mock('react-native-svg', () => ({
  SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
  Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('Svg', props, props.children),
  Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

function createDefaultSettings() {
  return {
  connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
  connectedServicesProfileLabelByKey: {},
  connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
  connectedServicesQuotaSummaryStrategyByKey: {},
  };
}

const useSettingsSpy = vi.fn(() => createDefaultSettings());
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

vi.mock('@/sync/store/hooks', () => ({
  useProfile: () => ({
    connectedServicesV2: [
      {
        serviceId: 'anthropic',
        profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
      },
    ],
  }),
  useSettings: () => useSettingsSpy(),
  useLocalSetting: () => 1,
  useSettingMutable: (name: string) => [
    name === 'connectedServicesProviderStateSharingSettingsV1'
      ? providerStateSharingSetting.current
      : undefined,
    setSettingMutableSpy,
  ],
}));

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
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

function expectRowSwitchOutsidePressables(row: ReactTestInstance): void {
  const switches = row.findAll((node) => String(node.type) === 'Switch');
  expect(switches).toHaveLength(1);
  let ancestor = switches[0].parent;
  while (ancestor) {
    expect(String(ancestor.type)).not.toBe('Pressable');
    ancestor = ancestor.parent;
  }
}

function findItemWithRightElement(root: ReactTestInstance, testID: string): ReactTestInstance {
  const items = root.findAllByProps({ testID }).filter((node) => node.props.rightElement != null);
  if (items.length !== 1) {
    throw new Error(`Expected one right-element Item for ${testID}, found ${items.length}`);
  }
  return items[0];
}

function getSwitchValueChangeHandler(root: ReactTestInstance, testID: string): (value: boolean) => void {
  const rightElement = findItemWithRightElement(root, testID).props.rightElement;
  if (!React.isValidElement<{ onValueChange?: (value: boolean) => void }>(rightElement)) {
    throw new Error(`Expected ${testID} to render a Switch rightElement`);
  }
  if (typeof rightElement.props.onValueChange !== 'function') {
    throw new Error(`Expected ${testID} Switch rightElement to expose onValueChange`);
  }
  return rightElement.props.onValueChange;
}

describe('ConnectedServicesSettingsView quotas', () => {
  beforeEach(() => {
    setSettingMutableSpy.mockClear();
    modalConfirmSpy.mockClear();
    useFeatureEnabledSpy.mockReset();
    useFeatureEnabledSpy.mockReturnValue(true);
    useSettingsSpy.mockReset();
    useSettingsSpy.mockReturnValue(createDefaultSettings());
    fetchAccountEncryptionModeSpy.mockReset();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockReset();
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(null);
    getConnectedServiceQuotaSnapshotSealedSpy.mockReset();
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue(null);
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };
  });

  it('shows quota badges on service rows when pinned meters exist', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    useSettingsSpy.mockReturnValue({
      connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly', 'daily'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
    });

    const secretBytes = new Uint8Array(32).fill(3);
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 82,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
        {
          meterId: 'daily',
          label: 'Daily',
          used: 60,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    });
    const ciphertext = sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
      material: { type: 'legacy', secret: secretBytes },
      payload: snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
    });

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;

    await flushHookEffects({ cycles: 4, turns: 1 });

    expect(tree.findAll((n) => n.props?.children === 'Weekly 18%')).not.toHaveLength(0);
    expect(tree.findAll((n) => n.props?.children === 'Daily 40%')).not.toHaveLength(0);
  });

  it('renders the brand mark and a derived health dot on provider rows (not key-outline)', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
    await flushHookEffects({ cycles: 2, turns: 1 });

    // Provider rows now resolve themed brand marks (-> SvgXml) instead of a
    // uniform generic key-outline glyph (the index unification win).
    expect(tree.root.findAll((n) => String(n.type) === 'SvgXml').length).toBeGreaterThan(0);
    // The connected anthropic account drives a derived health dot.
    expect(
      tree.root.findAll((n) => n.props?.testID === 'connected-services-index:anthropic:health-dot').length,
    ).toBeGreaterThan(0);
  });

  it('requires acknowledgement before enabling shared provider state as a global default', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
    await flushHookEffects({ cycles: 2, turns: 1 });

    await getSwitchValueChangeHandler(tree.root, 'connected-services-provider-state-sharing-state-default')(true);
    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'shared' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {
        agy: { sharedStatePrivacy: true },
        claude: { sharedStatePrivacy: true },
        codex: { sharedStatePrivacy: true },
        pi: { sharedStatePrivacy: true },
      },
    });
    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
  });

  it('shows the default state-sharing toggle ON without requiring acknowledgement when shared is the default', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    // Parsed default after the product change: shared session state is on by default.
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'shared' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
    await flushHookEffects({ cycles: 2, turns: 1 });

    const stateRow = findItemWithRightElement(tree.root, 'connected-services-provider-state-sharing-state-default');
    const rightElement = stateRow.props.rightElement;
    if (!React.isValidElement<{ value?: boolean }>(rightElement)) {
      throw new Error('Expected default state-sharing row to render a Switch');
    }
    // Default-on must not require an interaction or an acknowledgement modal.
    expect(rightElement.props.value).toBe(true);
    expect(modalConfirmSpy).not.toHaveBeenCalled();
    expect(setSettingMutableSpy).not.toHaveBeenCalled();
  });

  it('surfaces the shared-state privacy note when shared is the active default', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'shared' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
    await flushHookEffects({ cycles: 2, turns: 1 });

    const note = tree.root.findAll(
      (n) => n.props?.testID === 'connected-services-provider-state-sharing-privacy-note',
    );
    expect(note.length).toBeGreaterThan(0);
  });

  it('persists the isolated opt-out when the global default toggle is turned off', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'shared' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
    await flushHookEffects({ cycles: 2, turns: 1 });

    await getSwitchValueChangeHandler(tree.root, 'connected-services-provider-state-sharing-state-default')(false);
    // Turning the default off is the opt-out: it persists isolated and never prompts.
    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
    expect(modalConfirmSpy).not.toHaveBeenCalled();
  });

  it('selects copied provider config sharing as a distinct mode', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'copied', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);

    const configModeControl = tree.root.findAllByProps({ selectedId: 'copied' }).find(
      (node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-provider-state-sharing-config-default',
    );
    expect(configModeControl).toBeDefined();
    if (!configModeControl) throw new Error('Missing global provider config mode control');
    configModeControl.props.onSelect('isolated');

    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'isolated', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });

    configModeControl.props.onSelect('linked');
    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('renders provider state sharing rows from agent capabilities', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);

    expect(tree.root.findByProps({ testID: 'connected-services-provider-state-sharing-backend-overrides' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-agent-codex-state' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-agent-pi-state' })).toHaveLength(0);
  });

  it('keeps provider state sharing switches outside row pressables on web', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
    const { ConnectedServicesProviderStateSharingBackendGroups } = await import('./ConnectedServicesProviderStateSharingSettings');

    // Mount the real Switch after its Deferred clock boundary settles.
    vi.useFakeTimers();
    try {
      const { tree: settingsTree } = await renderScreen(<ConnectedServicesSettingsView />);
      await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
      const defaultStateRow = findItemWithRightElement(
        settingsTree.root,
        'connected-services-provider-state-sharing-state-default',
      );
      expectRowSwitchOutsidePressables(defaultStateRow);
      expect(defaultStateRow.props.mode).toBe('info');
      expect(defaultStateRow.props.onPress).toBeUndefined();

      const { tree: backendTree } = await renderScreen(
        <ConnectedServicesProviderStateSharingBackendGroups
          settings={ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSetting.current)}
          setSettings={setSettingMutableSpy}
          agentIds={['codex']}
        />,
      );
      await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
      const backendStateRow = findItemWithRightElement(
        backendTree.root,
        'connected-services-provider-state-sharing-agent-codex-state',
      );
      expectRowSwitchOutsidePressables(backendStateRow);
      expect(backendStateRow.props.mode).toBe('info');
      expect(backendStateRow.props.onPress).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    await flushHookEffects({ cycles: 2, turns: 1 });

    await getSwitchValueChangeHandler(tree.root, 'connected-services-provider-state-sharing-agent-codex-state')(true);

    expect(setSettingMutableSpy).toHaveBeenCalledWith({
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

  it('does not render provider-state-sharing controls when connectedServices is disabled', async () => {
    useFeatureEnabledSpy.mockReturnValue(false);

    const { ConnectedServicesProviderStateSharingSettingsView } = await import('./ConnectedServicesProviderStateSharingSettings');
    const { tree } = await renderScreen(<ConnectedServicesProviderStateSharingSettingsView />);

    expect(tree.toJSON()).toBeNull();
  });
});
