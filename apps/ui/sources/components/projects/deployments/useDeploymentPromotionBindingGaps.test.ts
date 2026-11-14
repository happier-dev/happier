import { afterEach, describe, expect, it } from 'vitest';
import { createDeploymentReadControllerV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentSecretVariableBindingV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

installHomeGovernanceBoundaries(createHomeGovernanceHarness());
const { useDeploymentPromotionBindingGaps } = await import('./useDeploymentPromotionBindingGaps');
const shown = { mounted: true, visible: true, focused: true };
const hidden = { mounted: true, visible: false, focused: false };
const source = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id: 'source' }),
    targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ environmentId: 'source' }), content: {} }] });
const destination = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id: 'destination' }),
    targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ environmentId: 'destination' }), content: {} }] });
const sourceWithBinding = { ...source, content: { ...source.content, bindings: [createDeploymentSecretVariableBindingV1({
    name: 'TOKEN', phase: 'runtime', resourceId: 'token', resourceRevision: 1 })] } };

describe('promotion binding preflight demand', () => {
    afterEach(() => standardCleanup());
    it('reads only the selected pair, shares peers, ignores unrelated arrivals and stops demand when closed', async () => {
        const ids: string[] = [];
        const pending = createDeferred<void>();
        let otherReads = 0;
        let healthReads = 0;
        const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner' }, transport: {
            listEnvironments: async () => { otherReads++; return { ok: true, value: { items: [], nextCursor: null } }; },
            listHistory: async () => { otherReads++; return { ok: true, value: { ok: true, items: [], nextCursor: null } }; },
            readEnvironment: async (_scope, id) => { ids.push(id); await pending.promise;
                return { ok: true, value: id === 'source' ? sourceWithBinding : destination }; },
            readReceipt: async () => { otherReads++; return { ok: false, failure: { code: 'deployment_unavailable', retryable: false } }; },
            observeEnvironmentHealth: () => { healthReads++; return () => {}; },
        } });
        const counts = createRenderCommitCounter();
        type Props = { demand: DeploymentReadDemandV1; destination: string | null };
        const initialProps: Props = { demand: hidden, destination: null };
        const hook = await renderHook((props: Props) => {
            useRenderCommitCounter(counts);
            return { first: useDeploymentPromotionBindingGaps(controller, 'source', props.destination, props.demand),
                peer: useDeploymentPromotionBindingGaps(controller, 'source', props.destination, props.demand) };
        }, { initialProps });
        try {
            expect(hook.getCurrent().first.result.status).toBe('idle');
            await hook.rerender({ demand: shown, destination: null });
            expect(ids).toEqual([]);
            await hook.rerender({ demand: hidden, destination: 'destination' });
            expect(ids).toEqual([]);
            await hook.rerender({ demand: shown, destination: 'destination' });
            expect(hook.getCurrent().first.result.status).toBe('loading');
            await act(async () => pending.resolve());
            expect(hook.getCurrent().first.result).toEqual({ status: 'ready', gaps: [{ name: 'TOKEN', phase: 'runtime', secret: true }] });
            expect(hook.getCurrent().peer.result).toEqual(hook.getCurrent().first.result);
            expect(ids.sort()).toEqual(['destination', 'source']);
            expect([otherReads, healthReads]).toEqual([0, 0]);
            counts.reset();
            await act(async () => { controller.invalidate(Array.from({ length: 100 }, (_, index) => ({ environmentId: `unrelated-${index}` })));
                await flushHookEffects(); });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(ids).toHaveLength(2);
            await hook.rerender({ demand: hidden, destination: 'destination' });
            expect(hook.getCurrent().first.result.status).toBe('idle');
            await act(async () => { controller.invalidate({ environmentId: 'source' }); await flushHookEffects(); });
            expect(ids).toHaveLength(2);
        } finally { await hook.unmount(); controller.retire(); }
    });

    it('does not present a failed or switched destination as clear and exposes the owner’s retryable cause', async () => {
        let fail = true;
        const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner' }, transport: {
            listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
            readEnvironment: async (_scope, id) => id !== 'source' && fail
                ? { ok: false, failure: { code: 'deployment_content_unavailable', retryable: true } }
                : { ok: true, value: id === 'source' ? sourceWithBinding : { ...destination, content: { ...destination.content, bindings: sourceWithBinding.content.bindings } } },
            readReceipt: async () => ({ ok: false, failure: { code: 'deployment_unavailable', retryable: false } }),
        } });
        const hook = await renderHook((id: string) => useDeploymentPromotionBindingGaps(controller, 'source', id, shown),
            { initialProps: 'destination' });
        try {
            await act(async () => flushHookEffects());
            expect(hook.getCurrent().result).toEqual({ status: 'unavailable', side: 'destination', reason: 'deployment_content_unavailable', retryable: true });
            fail = false;
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result).toEqual({ status: 'ready', gaps: [] });
            fail = true;
            await hook.rerender('other-destination');
            await act(async () => flushHookEffects());
            expect(hook.getCurrent().result.status).toBe('unavailable');
        } finally { await hook.unmount(); controller.retire(); }
    });
});
