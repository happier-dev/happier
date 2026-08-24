import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetConnectedServiceQuotaSnapshotStore } from '@/hooks/server/connectedServices/connectedServiceQuotaSnapshotStore';

import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { renderScreen } from '@/dev/testkit';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import {
  __resetProviderAccountUsageSnapshotCache,
  writeProviderAccountUsageSnapshotToCache,
} from '@/sync/domains/connectedServices/accountUsage/cache';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();
const setOptionsSpy = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: backSpy, push: pushSpy },
        params: { serviceId: 'openai-codex' },
        navigation: { setOptions: setOptionsSpy },
    });
    return routerMock.module;
});

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));

// `openai-codex` exposes the Pools segment, so the redesigned shell mounts the
// segmented tab bar (needs theme tokens the global test theme lacks) and the
// AccountBlock renders brand icons via `<SvgXml>` / member avatars. Pass these
// UI-primitive boundaries through.
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => {
    const React = require('react');
    type Tab = { id: string; label: string };
    type Props = { tabs: ReadonlyArray<Tab>; activeTabId: string; onSelectTab: (id: string) => void; testIDPrefix?: string };
    return {
        SegmentedTabBar: (props: Props) =>
            React.createElement(
                'SegmentedTabBar',
                { testID: props.testIDPrefix },
                props.tabs.map((tab) =>
                    React.createElement('Pressable', {
                        key: tab.id,
                        testID: props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}` : undefined,
                        onPress: () => props.onSelectTab(tab.id),
                    }, tab.label),
                ),
            ),
    };
});

vi.mock('react-native-svg', () => {
    const React = require('react');
    return {
        SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
        Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Svg', props, props.children),
        Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
    };
});

vi.mock('@/components/ui/avatar/Avatar', () => {
    const React = require('react');
    return { Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', props) };
});

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const useFeatureEnabledSpy = vi.fn((featureId: string) => featureId !== 'connectedServices.accountGroups');
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

const { fetchAccountEncryptionModeSpy } = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee', updatedAt: 0 })),
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

const { getConnectedServiceQuotaSnapshotPlainSpy } = vi.hoisted(() => ({
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
}));
const profileState = vi.hoisted(() => ({
  current: {
    connectedServicesV2: [
      {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null }],
      },
    ],
  },
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
  requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => profileState.current,
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

const { applySettingsSpy } = vi.hoisted(() => ({ applySettingsSpy: vi.fn(async (_update: unknown) => {}) }));
vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: applySettingsSpy },
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

const { getConnectedServiceQuotaSnapshotSealedSpy } = vi.hoisted(() => ({
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

describe('ConnectedServiceDetailView quotas', () => {
  beforeEach(() => {
    // The quota snapshot store is a module-level cache keyed by scope; reset it so
    // each scenario re-runs the plain/sealed endpoint decision from a clean slate.
    __resetConnectedServiceQuotaSnapshotStore();
    __resetProviderAccountUsageSnapshotCache();
    useFeatureEnabledSpy.mockReset();
    useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId !== 'connectedServices.accountGroups');
    applySettingsSpy.mockClear();
    getConnectedServiceQuotaSnapshotSealedSpy.mockReset();
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue(null);
    getConnectedServiceQuotaSnapshotPlainSpy.mockReset();
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(null);
    fetchAccountEncryptionModeSpy.mockReset();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null }],
        },
      ],
    };
  });

  const setFeatureFlags = (flags: Record<string, boolean>) => {
    useFeatureEnabledSpy.mockImplementation((featureId: string) => {
      if (featureId in flags) return Boolean(flags[featureId]);
      if (featureId === 'connectedServices.accountGroups') return false;
      return true;
    });
  };

  function buildWeeklySnapshot() {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
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
      ],
    });
  }

  function buildAccountUsageSnapshot(): ProviderAccountUsageSnapshotV1 {
    const recordKey = {
      providerId: 'codex',
      accountSubjectId: 'codex-account-1',
      subjectKind: 'account',
      quotaScope: 'account',
    } as const;
    return ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'codex-account-1' },
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 60_000,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: 'Pro',
      accountLabel: 'Codex account',
      meters: [
        {
          meterId: 'account-usage-weekly',
          label: 'Account usage weekly',
          used: 82,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: { limitCategory: 'usage_limit' },
        },
      ],
    });
  }

  it('renders the AccountBlock USAGE meter when the quotas feature is enabled', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(buildWeeklySnapshot());

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    // USAGE now lives in the shared AccountBlock (expanded-by-default).
    expect(screen.findByTestId('account-block:work:usage')).toBeTruthy();
    expect(screen.findByTestId('account-block:work:meter:weekly')).toBeTruthy();
  });

  it('keeps usage visible for a missing/empty credential status (UI-1)', async () => {
    // The usage-DISPLAY gate fails OPEN (shouldHideQuotaForCredentialStatus) and must receive the
    // RAW status: pre-normalizing '' -> needs_reauth before the gate silently blanks a healthy
    // account's usage in the detail block while the badge surfaces (which gate on raw) keep showing
    // it. Display fails open end to end — no reauth pill for an unrecognized status either; the
    // fail-closed normalization stays for the row actions/ordering only.
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(buildWeeklySnapshot());
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: '', kind: 'oauth', providerEmail: null }],
        },
      ],
    };

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    expect(screen.findByTestId('account-block:work:usage')).toBeTruthy();
    expect(screen.findByTestId('account-block:work:meter:weekly')).toBeTruthy();
    // Display fails open: no reauth pill for an unrecognized status (matches the
    // AccountBlock block-level contract).
    expect(screen.findAllByTestId('account-block:work:reauth-badge')).toHaveLength(0);
  });

  it('does not render AccountBlock USAGE meters when the quotas feature is disabled', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': false });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    // The account block still renders, but the quota snapshot hook is never mounted.
    expect(screen.findByTestId('account-block:work:header')).toBeTruthy();
    expect(screen.findAllByTestId('account-block:work:usage')).toHaveLength(0);
    expect(screen.findAllByTestId('account-block:work:meter:weekly')).toHaveLength(0);
  });

  it('does not repeat an unlabeled token profile id in the account subtitle', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': false });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'native-token', status: 'connected', kind: 'token', providerEmail: null }],
        },
      ],
    };

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);

    const header = screen.findByTestId('account-block:native-token:header');
    expect(header?.props.accessibilityLabel).toBe('native-token');
    expect(header?.props.subtitle).toBeUndefined();
  });

  it('does not expose connected services detail when the feature is disabled', async () => {
    setFeatureFlags({ connectedServices: false, 'connectedServices.quotas': true });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    const screen = await renderScreen(<ConnectedServiceDetailView />);

    // The whole shell is gated off — no account blocks render.
    expect(screen.findAllByTestId('account-block:work:header')).toHaveLength(0);
    expect(screen.findAllByTestId('connected-services-detail-shell')).toHaveLength(0);
    const items = screen.tree.findAll((n) => typeof n.props?.title === 'string' && typeof n.props?.onPress === 'function');
    expect(items.length).toBe(0);
  });

  it('persists pinned meter ids via settings when the AccountBlock pin is toggled', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(buildWeeklySnapshot());

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    await screen.pressByTestIdAsync('account-block:work:pin:weekly');

    expect(applySettingsSpy).toHaveBeenCalledWith({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'openai-codex/work': ['weekly'] },
    });
  });

  it('renders the AccountBlock usage meter from the connected-service quota view without duplicating cached provider account usage', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(buildWeeklySnapshot());
    writeProviderAccountUsageSnapshotToCache({
      credentialScope: resolveAuthCredentialsScopeKey(stableCredentials),
      snapshot: buildAccountUsageSnapshot(),
    });

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await act(async () => {
      await flushHookEffects({ cycles: 4, turns: 4 });
    });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalled();
    expect(screen.findByTestId('account-block:work:usage')).toBeTruthy();
    expect(screen.findByTestId('account-block:work:meter:weekly')).toBeTruthy();
    expect(screen.findAllByTestId('account-block:work:meter:account-usage-weekly')).toHaveLength(0);
  });

  it('loads plaintext quota snapshots for plaintext accounts', async () => {
    setFeatureFlags({ connectedServices: true, 'connectedServices.quotas': true });
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(buildWeeklySnapshot());

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await act(async () => {
      await flushHookEffects({ cycles: 4, turns: 4 });
    });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalled();
    expect(screen.findByTestId('account-block:work:meter:weekly')).toBeTruthy();
  });
});
