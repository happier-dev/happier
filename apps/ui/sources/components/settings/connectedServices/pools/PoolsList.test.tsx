import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type {
  getConnectedServiceQuotaSnapshotSealed,
  requestConnectedServiceQuotaSnapshotRefresh,
} from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type {
  getConnectedServiceQuotaSnapshotPlain,
  requestConnectedServiceQuotaSnapshotRefreshV3,
} from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { __resetConnectedServiceQuotaSnapshotStore } from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { ConnectedServiceAuthGroupsLoadStatus } from '../model/useConnectedServiceAuthGroups';

import { PoolsList } from './PoolsList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = {
  token: 't',
  secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url'),
} as const;
let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: currentCredentials }),
}));

// Boundary mock: `react-native-svg` primitives have no host implementation under
// react-test-renderer (rendering them yields "Element type is invalid … Svg").
// `SvgXml` backs the brand glyph; `Svg`/`Circle` back the ring-avatar's
// CapacityRing. Stub each to a host element carrying its props/children.
vi.mock('react-native-svg', () => ({
  SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
  Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('Svg', props, props.children),
  Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

const {
  fetchAccountEncryptionModeSpy,
  getConnectedServiceQuotaSnapshotPlainSpy,
  getConnectedServiceQuotaSnapshotSealedSpy,
  requestConnectedServiceQuotaSnapshotRefreshSpy,
  requestConnectedServiceQuotaSnapshotRefreshV3Spy,
  machineState,
  navigationFocusState,
} = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee', updatedAt: 0 })),
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
  requestConnectedServiceQuotaSnapshotRefreshSpy: vi.fn<
    (...args: Parameters<typeof requestConnectedServiceQuotaSnapshotRefresh>) => ReturnType<typeof requestConnectedServiceQuotaSnapshotRefresh>
  >(async () => true),
  requestConnectedServiceQuotaSnapshotRefreshV3Spy: vi.fn<
    (...args: Parameters<typeof requestConnectedServiceQuotaSnapshotRefreshV3>) => ReturnType<typeof requestConnectedServiceQuotaSnapshotRefreshV3>
  >(async () => false),
  machineState: {
    machines: [{ id: 'machine-1', active: true }] as ReadonlyArray<{ id: string; active: boolean }>,
  },
  navigationFocusState: { isFocused: true },
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
  requestConnectedServiceQuotaSnapshotRefresh: requestConnectedServiceQuotaSnapshotRefreshSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
  requestConnectedServiceQuotaSnapshotRefreshV3: requestConnectedServiceQuotaSnapshotRefreshV3Spy,
}));
vi.mock('@/sync/domains/state/storage', async () => {
  const actual = await vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage');
  return {
    ...actual,
    useAllMachines: () => machineState.machines,
  };
});
vi.mock('@react-navigation/native', async () => {
  const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
  return {
    ...createReactNavigationNativeMock(),
    useIsFocused: () => navigationFocusState.isFocused,
  };
});

/** Flattens a React children tree (numbers/strings/nested nodes) to its text. */
function flattenRenderedText(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flattenRenderedText).join('');
  if (typeof value === 'object' && 'props' in value) {
    return flattenRenderedText((value as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

type RawMember = Readonly<{ profileId: string; enabled?: boolean; priority?: number; state?: Record<string, unknown> }>;
type RawGroup = Readonly<{
  groupId?: string;
  displayName?: string;
  activeProfileId?: string;
  generation?: number;
  policy?: Record<string, unknown>;
  members?: ReadonlyArray<RawMember>;
}>;

function buildGroup(overrides: RawGroup = {}): Record<string, unknown> {
  return {
    groupId: 'pool-1',
    displayName: 'Primary pool',
    activeProfileId: 'work',
    generation: 1,
    policy: { autoSwitch: true, strategy: 'priority' },
    members: [
      { profileId: 'work', enabled: true, priority: 100, state: {} },
      { profileId: 'home', enabled: true, priority: 200, state: {} },
    ],
    ...overrides,
  };
}

const profiles = [
  { profileId: 'work', label: 'Work', providerEmail: 'work@example.com', status: 'connected' },
  { profileId: 'home', label: 'Home', providerEmail: 'home@example.com', status: 'connected' },
];

function lowCapacitySnapshot(profileId: string) {
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: 'anthropic',
    profileId,
    fetchedAt: Date.now(),
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    meters: [
      {
        meterId: 'weekly',
        label: 'Weekly',
        used: 90,
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

function multiAllowanceSnapshot(profileId: string) {
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: 'anthropic',
    profileId,
    fetchedAt: Date.now(),
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    meters: [
      { meterId: 'standard:primary', providerLimitId: 'standard', label: 'Session', used: 20, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
      { meterId: 'spark:primary', providerLimitId: 'spark', label: 'Spark', used: 95, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
    ],
  });
}

let onOpenPool: ReturnType<typeof vi.fn>;
let onCreatePool: ReturnType<typeof vi.fn>;
let onRetryLoad: ReturnType<typeof vi.fn>;

type RenderOverrides = Readonly<{
  profiles?: ReadonlyArray<(typeof profiles)[number]>;
  groups?: ReadonlyArray<Record<string, unknown>>;
  loadStatus?: ConnectedServiceAuthGroupsLoadStatus;
  quotasEnabled?: boolean;
  groupConfigurationSupported?: boolean;
  profileLabelsByKey?: Readonly<Record<string, string>>;
}>;

function renderPools(overrides: RenderOverrides = {}) {
  return renderScreen(
    <PoolsList
      serviceId="anthropic"
      profiles={overrides.profiles ?? profiles}
      profileLabelsByKey={overrides.profileLabelsByKey ?? {}}
      groups={overrides.groups ?? [buildGroup()]}
      loadStatus={overrides.loadStatus}
      quotasEnabled={overrides.quotasEnabled ?? false}
      groupConfigurationSupported={overrides.groupConfigurationSupported ?? true}
      onOpenPool={onOpenPool}
      onCreatePool={onCreatePool}
      onRetryLoad={onRetryLoad}
    />,
  );
}

function renderPoolsElement(overrides: RenderOverrides = {}) {
  return (
    <PoolsList
      serviceId="anthropic"
      profiles={overrides.profiles ?? profiles}
      profileLabelsByKey={overrides.profileLabelsByKey ?? {}}
      groups={overrides.groups ?? [buildGroup()]}
      loadStatus={overrides.loadStatus}
      quotasEnabled={overrides.quotasEnabled ?? false}
      groupConfigurationSupported={overrides.groupConfigurationSupported ?? true}
      onOpenPool={onOpenPool}
      onCreatePool={onCreatePool}
      onRetryLoad={onRetryLoad}
    />
  );
}

describe('PoolsList', () => {
  beforeEach(() => {
    __resetConnectedServiceQuotaSnapshotStore();
    currentCredentials = stableCredentials;
    onOpenPool = vi.fn();
    onCreatePool = vi.fn();
    onRetryLoad = vi.fn();
    vi.clearAllMocks();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(null);
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue(null);
    requestConnectedServiceQuotaSnapshotRefreshSpy.mockResolvedValue(true);
    requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(false);
    machineState.machines = [{ id: 'machine-1', active: true }];
    navigationFocusState.isFocused = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a pool row with mode/strategy meta and drills into the pool on press', async () => {
    const tree = (await renderPools()).tree;

    expect(tree.findAllByTestId('connected-services-pool:pool-1').length).toBeGreaterThan(0);
    // The concentric capacity-gauge avatar is the row's leading element. It carries
    // no brand glyph and no status dot.
    expect(tree.findAllByTestId('connected-services-pool:pool-1:avatar').length).toBeGreaterThan(0);
    expect(tree.findAllByTestId('connected-services-pool:pool-1:avatar:health-dot')).toHaveLength(0);
    expect(tree.findByTestId('connected-services-pool:pool-1:strategy')).toBeTruthy();
    // Auto-switch pool surfaces the "Auto" mode badge (info variant marker).
    expect(tree.findByTestId('connected-services-pool:pool-1:mode:variant:info')).toBeTruthy();

    tree.pressByTestId('connected-services-pool:pool-1');
    expect(onOpenPool).toHaveBeenCalledWith('pool-1');
  });

  it('shows the manual mode badge when auto-switch is off', async () => {
    const tree = (await renderPools({
      groups: [buildGroup({ policy: { autoSwitch: false, strategy: 'manual' } })],
    })).tree;

    expect(tree.findByTestId('connected-services-pool:pool-1:mode:variant:neutral')).toBeTruthy();
    expect(tree.findAllByTestId('connected-services-pool:pool-1:mode:variant:info')).toHaveLength(0);
  });

  it('renders the empty state and the create card when there are no pools', async () => {
    const tree = (await renderPools({ groups: [] })).tree;

    expect(tree.findByTestId('connected-services-pools:empty:title')).toBeTruthy();
    expect(tree.findAllByTestId('connected-services-pool-action:create').length).toBeGreaterThan(0);
  });

  it('suppresses the empty state while the first authoritative pool load is pending', async () => {
    const tree = (await renderPools({ groups: [], loadStatus: 'loading' })).tree;

    expect(tree.findAllByTestId('connected-services-pools:empty:title')).toHaveLength(0);
    expect(tree.findAllByTestId('connected-services-pool-action:create').length).toBeGreaterThan(0);
  });

  it('shows an explicit error + retry state (not the empty state) when the pool load fails with no data', async () => {
    const tree = (await renderPools({ groups: [], loadStatus: 'error' })).tree;

    // The failure must NOT masquerade as "No pools yet".
    expect(tree.findAllByTestId('connected-services-pools:empty:title')).toHaveLength(0);
    expect(tree.findByTestId('connected-services-pools:load-error')).toBeTruthy();

    tree.pressByTestId('connected-services-pools:load-error:retry');
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps stale pool rows and offers an inline retry when a refresh fails', async () => {
    const tree = (await renderPools({ groups: [buildGroup()], loadStatus: 'error' })).tree;

    // Stale data is retained.
    expect(tree.findAllByTestId('connected-services-pool:pool-1').length).toBeGreaterThan(0);
    // ...alongside an actionable retry affordance.
    tree.pressByTestId('connected-services-pools:stale-error:retry');
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it('invokes onCreatePool when the create card is pressed', async () => {
    const tree = (await renderPools()).tree;

    tree.pressByTestId('connected-services-pool-action:create');
    expect(onCreatePool).toHaveBeenCalledTimes(1);
  });

  it('disables the create card when pool configuration is unsupported', async () => {
    const tree = (await renderPools({ groupConfigurationSupported: false })).tree;

    const createItem = tree.find((node) => (
      node.props?.testID === 'connected-services-pool-action:create'
      && typeof node.props?.disabled === 'boolean'
    ));
    expect(createItem.props.disabled).toBe(true);
    expect(createItem.props.onPress).toBeUndefined();
  });

  it('derives capacity and member warnings from the active member snapshot', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => (
      lowCapacitySnapshot(params.profileId)
    ));

    const tree = (await renderPools({
      quotasEnabled: true,
      groups: [buildGroup({ activeProfileId: 'work', members: [{ profileId: 'work', enabled: true, priority: 100, state: {} }] })],
    })).tree;

    await flushHookEffects({ turns: 6 });

    // Active member capacity (overall %) now surfaces as the center label of the
    // concentric gauge avatar rather than as a separate inline meter beside meta.
    expect(tree.findByTestId('connected-services-pool:pool-1:avatar:capacity')).toBeTruthy();
    expect(tree.findAllByTestId('connected-services-pool:pool-1:capacity:meter')).toHaveLength(0);
    // A member at 10% remaining is danger-toned ⇒ counts as a warning. The app
    // `Text` primitive nests the value below a host wrapper, so flatten the
    // rendered text of the count node rather than asserting its raw children.
    const warningCount = tree.findByTestId('connected-services-pool:pool-1:warnings:count');
    expect(flattenRenderedText(warningCount?.props.children)).toBe('1');
  });

  it('derives pool-row capacity from only the pool-selected allowance', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => (
      multiAllowanceSnapshot(params.profileId)
    ));

    const tree = (await renderPools({
      quotasEnabled: true,
      groups: [buildGroup({
        activeProfileId: 'work',
        policy: {
          autoSwitch: true,
          strategy: 'priority',
          quotaLimitSelection: { mode: 'selected', providerLimitIds: ['standard'] },
        },
        members: [{ profileId: 'work', enabled: true, priority: 100, state: {} }],
      })],
    })).tree;

    await flushHookEffects({ turns: 6 });

    expect(tree.findAllByTestId('connected-services-pool:pool-1:warnings:count')).toHaveLength(0);
    expect(flattenRenderedText(
      tree.findByTestId('connected-services-pool:pool-1:avatar:capacity')?.props.children,
    )).toContain('80');
  });

  it('keeps quota probes idle while the pools screen is unfocused and resumes them on focus', async () => {
    navigationFocusState.isFocused = false;
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => (
      lowCapacitySnapshot(params.profileId)
    ));

    const screen = await renderScreen(renderPoolsElement({
      quotasEnabled: true,
      groups: [buildGroup({
        activeProfileId: 'work',
        members: [{ profileId: 'work', enabled: true, priority: 100, state: {} }],
      })],
    }));

    await flushHookEffects({ turns: 6 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(screen.tree.findAllByTestId('connected-services-pool:pool-1:avatar:capacity')).toHaveLength(0);

    navigationFocusState.isFocused = true;
    await act(async () => {
      screen.tree.update(renderPoolsElement({
        quotasEnabled: true,
        groups: [buildGroup({
          activeProfileId: 'work',
          members: [{ profileId: 'work', enabled: true, priority: 100, state: {} }],
        })],
      }));
    });
    await flushHookEffects({ turns: 6 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
    expect(screen.tree.findByTestId('connected-services-pool:pool-1:avatar:capacity')).toBeTruthy();
  });

  it('does not poll quota snapshots for auth-invalid pool members', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(lowCapacitySnapshot('work'));

    await renderPools({
      quotasEnabled: true,
      groups: [buildGroup({
        activeProfileId: 'work',
        members: [{
          profileId: 'work',
          enabled: true,
          priority: 100,
          state: { authInvalidUntilMs: 1_800_000_040_000 },
        }],
      })],
    });

    await flushHookEffects({ turns: 4 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
  });

  it('does not poll or render quota rings for pool members whose credential needs reauth', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(lowCapacitySnapshot('work'));

    const tree = (await renderPools({
      quotasEnabled: true,
      profiles: [
        { profileId: 'work', label: 'Work', providerEmail: 'work@example.com', status: 'needs_reauth' },
      ],
      groups: [buildGroup({
        activeProfileId: 'work',
        members: [{ profileId: 'work', enabled: true, priority: 100, state: {} }],
      })],
    })).tree;

    await flushHookEffects({ turns: 4 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(tree.findAllByTestId('connected-services-pool:pool-1:avatar:capacity')).toHaveLength(0);
    expect(tree.findAllByTestId('connected-services-pool:pool-1:warnings:count').length).toBeGreaterThan(0);
  });

  it('does not surface a warning indicator while quotas are disabled', async () => {
    const tree = (await renderPools({ quotasEnabled: false })).tree;

    await flushHookEffects({ turns: 3 });

    // The gauge avatar still renders, but with no quota snapshot it shows the
    // plain track — no center capacity number and no warning chip.
    expect(tree.findAllByTestId('connected-services-pool:pool-1:avatar').length).toBeGreaterThan(0);
    expect(tree.findAllByTestId('connected-services-pool:pool-1:warnings:count')).toHaveLength(0);
    expect(tree.findAllByTestId('connected-services-pool:pool-1:avatar:capacity')).toHaveLength(0);
    expect(tree.findAllByTestId('connected-services-pool:pool-1:capacity:meter')).toHaveLength(0);
  });
});
