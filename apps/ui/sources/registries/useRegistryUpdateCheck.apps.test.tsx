import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { useRegistryUpdateCheck } from './useRegistryUpdateCheck';

afterEach(standardCleanup);

it('checks exact installed Environment revisions through the existing registry Action', async () => {
    const requests: unknown[] = [];
    // Action execution crosses the transport boundary; the hook and output parser remain real.
    const execute: MountedAuthoringActionExecute = async (actionId, input) => {
        requests.push({ actionId, input });
        return { ok: true, result: { checkedAt: 10, results: [{ kind: 'app', key: 'environment-a',
            upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }] } };
    };
    const environments = [{ environmentId: 'environment-a', expectedRevision: 3 }];
    let enabled = true;
    const hook = await renderHook(() => useRegistryUpdateCheck({ scopeKey: 'home:account', kind: 'app', environments,
        execute, isCurrent: () => true, retry: () => {}, enabled }));
    await act(async () => { await hook.getCurrent().checkNow(); });
    expect(requests).toEqual([{ actionId: 'registries.updates.check', input: { kind: 'app', environments } }]);
    expect(hook.getCurrent().check.results).toMatchObject([{ kind: 'app', key: 'environment-a', upstream: { state: 'update_available' } }]);
    enabled = false;
    await hook.rerender();
    expect(hook.getCurrent().check.results).toEqual([]);
    await act(async () => { await hook.getCurrent().checkNow(); });
    expect(requests).toHaveLength(1);
});
