import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook, standardCleanup, type RenderHookResult } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';

// Install the physical transport boundary before importing the real cache owner.
const network = await installSessionOpsNetworkBoundary();
const { useMachinesCapabilitySnapshots } = await import('./machineCapabilitySnapshots');
const { MACHINE_UPDATE_FACTS_CACHE_SALT } = await import('./machineUpdateFacts');
const capabilities = await import('@/hooks/server/useMachineCapabilitiesCache');
const { storage } = await import('@/sync/domains/state/storageStore');
beforeEach(() => network.resetRequests());

afterEach(() => standardCleanup());
afterAll(() => network.dispose());

describe('useMachinesCapabilitySnapshots', () => {
    it('does no cache reads for unchanged members across Machine-driven parent renders', async () => {
        const ids = Array.from({ length: 100 }, (_, index) => `summary-machine-${index}`);
        const previous = storage.getState();
        const read = vi.spyOn(capabilities, 'getMachineCapabilitiesSnapshot');
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            storage(state => state.machineListStatusByServerId);
            return useMachinesCapabilitySnapshots('perf-summary-home', ids, 'perf-summary-account', { ignoreCheckTimes: true });
        });
        try {
            const mounted = renders;
            const held = hook.getCurrent();
            read.mockClear();
            for (let index = 0; index < 5; index++) {
                await act(async () => storage.setState(state => ({ machineListStatusByServerId: {
                    ...state.machineListStatusByServerId, [`unrelated-home-${index}`]: 'idle',
                } })));
            }
            expect(renders - mounted).toBe(5);
            expect(hook.getCurrent()).toBe(held);
            expect(read).toHaveBeenCalledTimes(0);
        } finally {
            await hook.unmount();
            read.mockRestore();
            storage.setState({ machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it('does not resolve a Home again per unchanged capability snapshot read', async () => {
        const ids = Array.from({ length: 100 }, (_, index) => `perf-b3-${index}`);
        const hook = await renderHook(() => useMachinesCapabilitySnapshots('perf-b3-home', ids, 'perf-b3-account'));
        const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
        const capture = vi.spyOn(serverProfiles, 'captureServerProfileScopeResolver');
        try {
            const first = hook.getCurrent();
            for (let index = 0; index < 3; index++) {
                await hook.rerender();
                expect(hook.getCurrent()).toBe(first);
            }
            expect(resolve).not.toHaveBeenCalled();
            expect(capture).not.toHaveBeenCalled();
        } finally { resolve.mockRestore(); capture.mockRestore(); await hook.unmount(); }
    });
    it('retains update facts across registry invalidation, follows fresh answers and never retains another Account snapshot', async () => {
        const home = await network.addHome('https://snapshot-readiness.test', 'snapshot-account');
        const { prefetchMachineCapabilities } = await import('@/hooks/server/useMachineCapabilitiesCache');
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        const target = { machineId: 'snapshot-machine', serverId: home.id };
        const accountLifetime = { scope: { serverId: home.id, accountId: home.accountId },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const prefetch = () => prefetchMachineCapabilities({ ...target, accountLifetime,
            cacheKeySalt: MACHINE_UPDATE_FACTS_CACHE_SALT,
            request: { requests: [{ id: 'cli.codex' }] } });
        network.respond('capabilities.detect', { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: { version: '1' } } } });
        await prefetch();
        const hook = await renderHook(({ accountId }) => useMachinesCapabilitySnapshots(home.id, [target.machineId], accountId), {
            initialProps: { accountId: home.accountId },
        });
        const first = hook.getCurrent().get(target.machineId);
        expect(first?.response.results['cli.codex']).toMatchObject({ data: { version: '1' } });
        await act(async () => publishMachineContributionRegistryProjectionInvalidation(target, 'authority'));
        expect(hook.getCurrent().get(target.machineId)).toBe(first);
        network.respond('capabilities.detect', { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 2, data: { version: '2' } } } });
        await act(async () => prefetch());
        expect(hook.getCurrent().get(target.machineId)?.response.results['cli.codex']).toMatchObject({ data: { version: '2' } });
        await hook.rerender({ accountId: 'another-account' });
        expect(hook.getCurrent().get(target.machineId)).toBeNull();
        await hook.unmount();
    });

    it('keeps the published Map and entry when a fresh detect answers with equal content', async () => {
        const home = await network.addHome('https://snapshot-equal.test', 'snapshot-equal-account');
        const { prefetchMachineCapabilities } = await import('@/hooks/server/useMachineCapabilitiesCache');
        const target = { machineId: 'snapshot-equal-machine', serverId: home.id };
        const accountLifetime = { scope: { serverId: home.id, accountId: home.accountId },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const prefetch = () => prefetchMachineCapabilities({ ...target, accountLifetime,
            cacheKeySalt: MACHINE_UPDATE_FACTS_CACHE_SALT, request: { requests: [{ id: 'cli.codex' }] } });
        const answer = () => network.respond('capabilities.detect', { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: { version: '1' } } } });
        answer();
        await prefetch();
        const hook = await renderHook(() => useMachinesCapabilitySnapshots(home.id, [target.machineId], home.accountId));
        const first = hook.getCurrent();
        answer();
        await act(async () => prefetch());
        expect(hook.getCurrent()).toBe(first);
        await hook.unmount();
    });

    it('keeps the summary reader still when a re-detect changes only its check times', async () => {
        const home = await network.addHome('https://snapshot-clock.test', 'snapshot-clock-account');
        const { prefetchMachineCapabilities } = await import('@/hooks/server/useMachineCapabilitiesCache');
        const target = { machineId: 'snapshot-clock-machine', serverId: home.id };
        const accountLifetime = { scope: { serverId: home.id, accountId: home.accountId },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const prefetch = () => prefetchMachineCapabilities({ ...target, accountLifetime,
            cacheKeySalt: MACHINE_UPDATE_FACTS_CACHE_SALT, request: { requests: [{ id: 'cli.codex' }, { id: 'dep.helper' }] } });
        const answer = (checkedAt: number, version = '1') => network.respond('capabilities.detect', { protocolVersion: 1, results: {
            'cli.codex': { ok: true, checkedAt, data: { version, latestVersion: '2' } },
            'dep.helper': { ok: true, checkedAt, data: { installed: true, installedVersion: '1',
                latestVersionCheck: { ok: true, latestVersion: '1', checkedAt } } },
        } });
        answer(1);
        await prefetch();
        let summaryRenders = 0;
        const summary = await renderHook(() => {
            summaryRenders += 1;
            return useMachinesCapabilitySnapshots(home.id, [target.machineId], home.accountId, { ignoreCheckTimes: true });
        });
        const detail = await renderHook(() => useMachinesCapabilitySnapshots(home.id, [target.machineId], home.accountId));
        const first = summary.getCurrent();
        try {
            summaryRenders = 0;
            for (let checkedAt = 2; checkedAt <= 6; checkedAt++) {
                answer(checkedAt);
                await act(async () => prefetch());
            }
            expect({ summaryRenders, same: summary.getCurrent() === first }).toEqual({ summaryRenders: 0, same: true });
            // The Updates surface shows when each Machine was checked, so its reader follows the check time.
            expect(detail.getCurrent().get(target.machineId)?.response.results['cli.codex']).toMatchObject({ checkedAt: 6 });
            answer(7, '2');
            await act(async () => prefetch());
            expect(summary.getCurrent().get(target.machineId)?.response.results['cli.codex']).toMatchObject({ data: { version: '2' } });
        } finally { await summary.unmount(); await detail.unmount(); }
    });

    it('keeps unchanged snapshots stable when the requested IDs contain duplicates', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let hook: RenderHookResult<ReturnType<typeof useMachinesCapabilitySnapshots>, void> | undefined;
        let renderError: unknown;
        try {
            try {
                hook = await renderHook(() => useMachinesCapabilitySnapshots('snapshot-home', ['machine-a', 'machine-a', 'machine-b']));
            } catch (error) {
                renderError = error;
            }
            expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot should be cached')))).toEqual([]);
            expect(renderError).toBeUndefined();
            expect(hook).toBeDefined();
            if (!hook) return;
            const snapshot = hook.getCurrent();
            expect([...snapshot.entries()]).toEqual([['machine-a', null], ['machine-b', null]]);
            await hook.rerender();
            expect(hook.getCurrent()).toBe(snapshot);
        } finally {
            await hook?.unmount();
            errors.mockRestore();
        }
    });
});
