import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { publishHomeAccountChange, publishHomeAccountChangeWake, getHomeAccountChangeDemandedServerIds } from '@/sync/runtime/orchestration/homeAccountChange';
import { applyUsageSocketUpdate } from '@/sync/engine/socket/usageUpdates';

const context = { handle: 'leeroy', identity: {}, service: null, urls: null };

// Metro's deferred module boundary only; mounted Action admission and transport stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const account = createProviderSettingsAccountHarness();
const disposeLoader = await installRealActionExecutorModuleLoader();
let stored = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context });
let reads = 0;
let failNextRead = false;
const scope = () => ({ serverId: account.serverId, accountId: 'account-a' });
beforeEach(async () => {
  reads = 0;
  failNextRead = false;
  stored = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context });
  await account.restore({ currentAccount: true,
    features: createRootLayoutFeaturesResponse({ features: { account: { publicProfiles: { enabled: true } } } }),
    httpAnswers: { 'GET /v1/account/public-profile': { select: () => {
      reads++;
      if (failNextRead) { failNextRead = false; throw new TypeError('offline'); }
      return { body: stored };
    } } },
  });
});
afterEach(async () => { standardCleanup(); await account.reset(); });
afterAll(() => disposeLoader());

function Probe() {
  const [, rerender] = React.useState(0);
  const execution = useMountedActionExecution(scope());
  const { state } = usePublicProfileOwnerRead(execution, scope());
  React.useEffect(() => { if (state.kind === 'ready') rerender(value => value + 1); }, [state]);
  return null;
}

describe('usePublicProfileOwnerRead', () => {
  it('updates two open owner sessions from publication pushes, ignoring unrelated changes and retiring demand on close', async () => {
    const currentScope = scope();
    stored = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context, record: {
      state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
      query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { relative: '90days' } }),
      snapshot: { v: 1, computedAtMs: 1, period: { startMs: 0, endMs: 1, timeZoneOffsetMinutes: 0 },
        coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {} },
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      updatedAtMs: 1, publishedAtMs: 1, restriction: null,
    } });
    const published = stored;
    const seen = new Map<string, string>();
    function Session({ id }: Readonly<{ id: string }>) {
      const execution = useMountedActionExecution(currentScope);
      const { state } = usePublicProfileOwnerRead(execution, currentScope);
      React.useEffect(() => { seen.set(id, state.kind === 'ready' ? state.read.kind : state.kind); }, [id, state]);
      return null;
    }
    const screen = await renderScreen(<><Session id="settings" /><Session id="editor" /></>);
    try {
      await vi.waitFor(() => expect([...seen.values()]).toEqual(['ready', 'ready']));
      expect(reads).toBe(2);
      const wake = (serverId: string, entityId: string) => publishHomeAccountChangeWake(serverId,
        { t: 'account-change', changeKinds: ['account'], entityIds: [entityId], sessionSystemRecords: [] }, 'socket');
      await act(async () => {
        wake('another-home', 'public-profile');
        for (let i = 0; i < 20; i++) {
          publishHomeAccountChange(currentScope.serverId, undefined, { source: 'connected', changesCatchUp: true });
          wake(currentScope.serverId, `workflow-run:${i}`);
          applyUsageSocketUpdate({ type: 'usage', id: null, key: 'native', tokens: { total: i + 1 },
            cost: { total: 0 }, timestamp: i + 1 }, currentScope.serverId, currentScope.accountId);
          applyUsageSocketUpdate({ type: 'usage-sources-invalidated', machineId: 'machine', installationId: 'installation' },
            currentScope.serverId, currentScope.accountId);
          publishHomeAccountChangeWake(currentScope.serverId, { t: 'account-settings-changed', settingsVersion: i + 1 }, 'socket');
        }
      });
      expect(reads).toBe(2);
      stored = { kind: 'absent', context };
      await act(async () => { wake(currentScope.serverId, 'public-profile'); });
      await vi.waitFor(() => expect([...seen.values()]).toEqual(['absent', 'absent']));
      expect(reads).toBe(4);
      stored = published;
      await act(async () => { wake(currentScope.serverId, 'public-profile'); });
      await vi.waitFor(() => expect([...seen.values()]).toEqual(['ready', 'ready']));
      expect(reads).toBe(6);
      expect(getHomeAccountChangeDemandedServerIds()).toContain(currentScope.serverId);
    } finally { await screen.unmount(); }
    expect(getHomeAccountChangeDemandedServerIds()).not.toContain(currentScope.serverId);
  });
  it('recovers a failed read on primary reconnect without re-reading a successful edition on the next reconnect', async () => {
    const currentScope = scope();
    failNextRead = true;
    let seen = '';
    function Session() {
      const execution = useMountedActionExecution(currentScope);
      const { state } = usePublicProfileOwnerRead(execution, currentScope);
      seen = state.kind;
      return null;
    }
    const screen = await renderScreen(<Session />);
    const reconnect = () => publishHomeAccountChange(currentScope.serverId, undefined, { source: 'connected', changesCatchUp: true });
    try {
      await vi.waitFor(() => expect(seen).toBe('failed'));
      await act(async () => { reconnect(); });
      await vi.waitFor(() => expect(seen).toBe('ready'));
      expect(reads).toBe(2);
      await act(async () => { reconnect(); });
      expect(reads).toBe(2);
      // A refresh failure retains the edition, but still needs the same recovery delivery.
      failNextRead = true;
      await act(async () => {
        publishHomeAccountChangeWake(currentScope.serverId, { t: 'account-change', changeKinds: ['account'],
          entityIds: ['public-profile'], sessionSystemRecords: [] }, 'socket');
      });
      expect(seen).toBe('ready');
      expect(reads).toBe(3);
      await act(async () => { reconnect(); });
      await vi.waitFor(() => expect(reads).toBe(4));
      await act(async () => { reconnect(); });
      expect(reads).toBe(4);
    } finally { await screen.unmount(); }
  });
  it('reads the owner record once per mounted Account, even while its host re-renders', async () => {
    await renderScreen(<Probe />);
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(account.home.requests.filter(request => request.path === '/v1/account/public-profile')).toHaveLength(1);
  });
});
