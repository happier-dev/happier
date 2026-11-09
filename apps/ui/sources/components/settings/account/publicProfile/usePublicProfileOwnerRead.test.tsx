import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileOwnerReadV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { publishHomeAccountChange, publishHomeAccountChangeWake, getHomeAccountChangeDemandedServerIds } from '@/sync/runtime/orchestration/homeAccountChange';
import { applyUsageSocketUpdate } from '@/sync/engine/socket/usageUpdates';

const context = { handle: 'leeroy', identity: {}, service: null, urls: null };

function Probe(props: Readonly<{ read: (actionId: string, input: unknown) => Promise<unknown> }>) {
  const [, rerender] = React.useState(0);
  // The mounted Action owner hands out a fresh callback on each render; the read must not follow it.
  const execution = { ready: true, executeValue: (actionId: string, input: unknown) => props.read(actionId, input) } as never;
  const { state } = usePublicProfileOwnerRead(execution, null);
  React.useEffect(() => { if (state.kind === 'ready') rerender(value => value + 1); }, [state]);
  return null;
}

describe('usePublicProfileOwnerRead', () => {
  it('updates two open owner sessions from publication pushes, ignoring unrelated changes and retiring demand on close', async () => {
    const scope = { serverId: 'profile-push-home', accountId: 'owner' };
    let stored: PublicProfileOwnerReadV1 = { kind: 'ready', context, record: {
      state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
      query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { relative: '90days' } }),
      snapshot: { v: 1, computedAtMs: 1, period: { startMs: 0, endMs: 1, timeZoneOffsetMinutes: 0 },
        coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {} },
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      updatedAtMs: 1, publishedAtMs: 1, restriction: null,
    } };
    const published = stored;
    // The Action transport is the external boundary; both mounted readers and Home routing are real.
    const read = vi.fn(async () => stored);
    const seen = new Map<string, string>();
    function Session({ id }: Readonly<{ id: string }>) {
      const { state } = usePublicProfileOwnerRead({ ready: true, executeValue: read }, scope);
      React.useEffect(() => { seen.set(id, state.kind === 'ready' ? state.read.kind : state.kind); }, [id, state]);
      return null;
    }
    const screen = await renderScreen(<><Session id="settings" /><Session id="editor" /></>);
    try {
      await vi.waitFor(() => expect([...seen.values()]).toEqual(['ready', 'ready']));
      expect(read).toHaveBeenCalledTimes(2);
      const wake = (serverId: string, entityId: string) => publishHomeAccountChangeWake(serverId,
        { t: 'account-change', changeKinds: ['account'], entityIds: [entityId], sessionSystemRecords: [] }, 'socket');
      await act(async () => {
        wake('another-home', 'public-profile');
        for (let i = 0; i < 20; i++) {
          publishHomeAccountChange(scope.serverId, undefined, { source: 'connected', changesCatchUp: true });
          wake(scope.serverId, `workflow-run:${i}`);
          applyUsageSocketUpdate({ type: 'usage', id: null, key: 'native', tokens: { total: i + 1 },
            cost: { total: 0 }, timestamp: i + 1 }, scope.serverId, scope.accountId);
          applyUsageSocketUpdate({ type: 'usage-sources-invalidated', machineId: 'machine', installationId: 'installation' },
            scope.serverId, scope.accountId);
          publishHomeAccountChangeWake(scope.serverId, { t: 'account-settings-changed', settingsVersion: i + 1 }, 'socket');
        }
      });
      expect(read).toHaveBeenCalledTimes(2);
      stored = { kind: 'absent', context };
      await act(async () => { wake(scope.serverId, 'public-profile'); });
      await vi.waitFor(() => expect([...seen.values()]).toEqual(['absent', 'absent']));
      expect(read).toHaveBeenCalledTimes(4);
      stored = published;
      await act(async () => { wake(scope.serverId, 'public-profile'); });
      await vi.waitFor(() => expect([...seen.values()]).toEqual(['ready', 'ready']));
      expect(read).toHaveBeenCalledTimes(6);
      expect(getHomeAccountChangeDemandedServerIds()).toContain(scope.serverId);
    } finally { await screen.unmount(); }
    expect(getHomeAccountChangeDemandedServerIds()).not.toContain(scope.serverId);
  });
  it('recovers a failed read on primary reconnect without re-reading a successful edition on the next reconnect', async () => {
    const scope = { serverId: 'profile-recovery-home', accountId: 'owner' };
    const read = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue({ kind: 'absent', context });
    let seen = '';
    function Session() {
      const { state } = usePublicProfileOwnerRead({ ready: true, executeValue: read }, scope);
      seen = state.kind;
      return null;
    }
    const screen = await renderScreen(<Session />);
    const reconnect = () => publishHomeAccountChange(scope.serverId, undefined, { source: 'connected', changesCatchUp: true });
    try {
      await vi.waitFor(() => expect(seen).toBe('failed'));
      await act(async () => { reconnect(); });
      await vi.waitFor(() => expect(seen).toBe('ready'));
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => { reconnect(); });
      expect(read).toHaveBeenCalledTimes(2);
      // A refresh failure retains the edition, but still needs the same recovery delivery.
      read.mockRejectedValueOnce(new TypeError('offline'));
      await act(async () => {
        publishHomeAccountChangeWake(scope.serverId, { t: 'account-change', changeKinds: ['account'],
          entityIds: ['public-profile'], sessionSystemRecords: [] }, 'socket');
      });
      expect(seen).toBe('ready');
      expect(read).toHaveBeenCalledTimes(3);
      await act(async () => { reconnect(); });
      expect(read).toHaveBeenCalledTimes(4);
      await act(async () => { reconnect(); });
      expect(read).toHaveBeenCalledTimes(4);
    } finally { await screen.unmount(); }
  });
  it('reads the owner record once per mounted Account, even while its host re-renders', async () => {
    const read = vi.fn(async () => ({ kind: 'absent', context }));
    await renderScreen(<Probe read={read} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('account.public_profile.get', {});
  });
});
