import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { useObservedWorkerSetting } from './useObservedWorkerSetting';

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

describe('observed worker setting intent custody', () => {
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
});
