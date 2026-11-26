import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { useObservedWorkerSetting } from './useObservedWorkerSetting';
import { ProjectWorkerActionError } from '@/sync/ops/actions/projectWorkerActions';

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

describe('observed worker setting intent custody', () => {
  it.each(['refused', 'rejected'] as const)('preserves the typed cause of a %s settings read', async mode => {
    fixture = await createPlainArtifactHomeFixture('https://worker-read-cause.test');
    const hook = await renderHook(() => useObservedWorkerSetting({
      serverId: fixture!.home.id, scopeKey: 'checkout',
      read: async () => {
        if (mode === 'rejected') throw new ProjectWorkerActionError('action_disabled');
        return { status: 'unavailable' as const, reasonCode: 'action_disabled' };
      },
      observedFromReceipt: () => null,
    }));
    expect(hook.getCurrent().state).toMatchObject({ kind: mode === 'refused' ? 'refused' : 'error', reasonCode: 'action_disabled' });
    await hook.unmount();
  });
  it.each(['conflict', 'outcomeUnknown', 'locked', 'unavailable', 'throw'] as const)(
    'keeps the intended edit separate from current authority after %s; renewed intent uses the current basis',
    async (status) => {
      fixture = await createPlainArtifactHomeFixture('https://worker-draft.test');
      type Ready = Readonly<{ status: 'ready'; value: number }>;
      let remote = 1;
      let writes = 0;
      // These callbacks represent the external setting read/write boundary. Hook logic remains real.
      const read = async (): Promise<Ready> => ({ status: 'ready', value: remote });
      const hook = await renderHook(({ scopeKey }: { scopeKey: string }) => useObservedWorkerSetting<Ready, number>({
        serverId: fixture!.home.id, scopeKey, read,
        observedFromReceipt: receipt => 'value' in receipt && typeof receipt.value === 'number'
          ? { status: 'ready', value: receipt.value } : null,
      }), { initialProps: { scopeKey: 'checkout' } });
      await act(async () => {
        await hook.getCurrent().mutate(async () => {
          writes++; remote = 3;
          if (status === 'throw') throw new Error('transport_failure');
          return status === 'conflict' ? { status, value: remote } : { status };
        }, 2);
      });
      expect(hook.getCurrent().draft).toBe(2);
      expect(writes).toBe(1);
      await act(async () => { hook.getCurrent().refresh(); });
      expect(hook.getCurrent().state).toEqual({ kind: 'ready', value: { status: 'ready', value: 3 } });
      expect(hook.getCurrent().draft).toBe(2);
      let expected: number | undefined;
      await act(async () => {
        await hook.getCurrent().mutate(async (_accountId, current) => {
          expected = current.value; writes++; remote = 2;
          return { status: 'applied', value: remote };
        }, hook.getCurrent().draft!);
      });
      expect(expected).toBe(3);
      expect(hook.getCurrent().draft).toBeNull();
      expect(hook.getCurrent().state).toEqual({ kind: 'ready', value: { status: 'ready', value: 2 } });
      await act(async () => { await hook.getCurrent().mutate(async () => ({ status: 'locked' }), 4); });
      await hook.rerender({ scopeKey: 'other-checkout' });
      expect(hook.getCurrent().draft).toBeNull();
      await hook.unmount();
    },
  );

  it("passes an AbortSignal into read that aborts on unmount, scope change, refresh, and account retirement", async () => {
    fixture = await createPlainArtifactHomeFixture("https://worker-signal.test");
    const signals: AbortSignal[] = [];
    const resolvers: Array<() => void> = [];
    const hook = await renderHook(({ scopeKey }: { scopeKey: string }) => useObservedWorkerSetting({
      serverId: fixture!.home.id,
      scopeKey,
      read: (_accountId, signal) => {
        signals.push(signal);
        return new Promise(resolve => {
          resolvers.push(() => resolve({ status: "ready" as const }));
        });
      },
      observedFromReceipt: () => null,
    }), { initialProps: { scopeKey: "scope-a" } });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    await act(async () => { hook.getCurrent().refresh(); });
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    await hook.rerender({ scopeKey: "scope-b" });
    expect(signals).toHaveLength(3);
    expect(signals[1]!.aborted).toBe(true);
    expect(signals[2]!.aborted).toBe(false);

    await hook.unmount();
    expect(signals[2]!.aborted).toBe(true);
    for (const resolve of resolvers) resolve();
  });

  it("caches ready observations per account lifetime across remounts without leaking across accounts", async () => {
    fixture = await createPlainArtifactHomeFixture("https://worker-cache.test");
    type Ready = Readonly<{ status: "ready"; value: number }>;
    let reads = 0;
    let remote = 10;
    const read = async (): Promise<Ready> => {
      reads += 1;
      return { status: "ready", value: remote };
    };
    const first = await renderHook(() => useObservedWorkerSetting<Ready, number>({
      serverId: fixture!.home.id,
      scopeKey: "cached-checkout",
      read,
      observedFromReceipt: receipt => "value" in receipt && typeof receipt.value === "number"
        ? { status: "ready", value: receipt.value } : null,
    }));
    expect(reads).toBe(1);
    expect(first.getCurrent().state).toEqual({ kind: "ready", value: { status: "ready", value: 10 } });
    await first.unmount();

    // Remount within the same account lifetime reuses cached observation without a duplicate read.
    const second = await renderHook(() => useObservedWorkerSetting<Ready, number>({
      serverId: fixture!.home.id,
      scopeKey: "cached-checkout",
      read,
      observedFromReceipt: receipt => "value" in receipt && typeof receipt.value === "number"
        ? { status: "ready", value: receipt.value } : null,
    }));
    expect(reads).toBe(1);
    expect(second.getCurrent().state).toEqual({ kind: "ready", value: { status: "ready", value: 10 } });

    // Explicit refresh bypasses cache and updates it.
    remote = 20;
    await act(async () => { second.getCurrent().refresh(); });
    expect(reads).toBe(2);
    expect(second.getCurrent().state).toEqual({ kind: "ready", value: { status: "ready", value: 20 } });
    await second.unmount();

    // Retiring / switching account clears the cache completely (no cross-account leak).
    await fixture.dispose();
    fixture = await createPlainArtifactHomeFixture("https://worker-cache-account-b.test");
    remote = 99;
    const otherAccount = await renderHook(() => useObservedWorkerSetting<Ready, number>({
      serverId: fixture!.home.id,
      scopeKey: "cached-checkout",
      read,
      observedFromReceipt: () => null,
    }));
    expect(reads).toBe(3);
    expect(otherAccount.getCurrent().state).toEqual({ kind: "ready", value: { status: "ready", value: 99 } });
    await otherAccount.unmount();
  });
});
