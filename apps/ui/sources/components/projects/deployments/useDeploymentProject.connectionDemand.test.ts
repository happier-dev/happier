import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useDeploymentProject, useDeploymentInventory, useDeploymentAccountController } = await import('./useDeploymentProject');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { getHomeAccountChangeDemandedServerIds, publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

describe('deployment Home connection demand', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());

    it.each(['source', 'account', 'inventory'] as const)('demands the Home only while an enabled %s borrower is presented', async kind => {
        const serverId = await homes.addHome({ name: 'Demand Home', serverUrl: 'https://deployment-demand.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
        const shown: DeploymentReadDemandV1 = { mounted: true, visible: true, focused: true };
        const hidden = { ...shown, visible: false };
        const hook = await renderHook(({ demand, enabled }: { demand: DeploymentReadDemandV1; enabled: boolean }) => {
            if (kind === 'source') return useDeploymentProject(enabled ? account.accountLifetime : null, 'source-app', demand).controller;
            if (kind === 'account') return useDeploymentAccountController(account.accountLifetime, enabled, demand);
            return useDeploymentInventory(enabled ? account.accountLifetime : null, demand).controller;
        }, { initialProps: { demand: hidden, enabled: true } });
        const demanded = () => getHomeAccountChangeDemandedServerIds().includes(serverId);
        try {
            expect(demanded(), 'an initially hidden borrower owns no transport demand').toBe(false);
            await hook.rerender({ demand: shown, enabled: true });
            expect(demanded()).toBe(true);
            await hook.rerender({ demand: hidden, enabled: true });
            expect(demanded(), 'hiding the last borrower releases transport demand').toBe(false);
            await hook.rerender({ demand: { ...shown, focused: false }, enabled: true });
            expect(demanded()).toBe(false);
            await hook.rerender({ demand: shown, enabled: false });
            expect(demanded(), 'a disabled borrower cannot retain transport demand').toBe(false);
            await hook.rerender({ demand: shown, enabled: true });
            expect(demanded()).toBe(true);
            await hook.unmount();
            expect(demanded(), 'unmounting the last borrower releases transport demand').toBe(false);
        } finally { await hook.unmount(); account.dispose(); }
    });

    it('keeps shared Home demand until the last presented borrower retires', async () => {
        const serverId = await homes.addHome({ name: 'Shared Demand', serverUrl: 'https://deployment-shared-demand.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const shown: DeploymentReadDemandV1 = { mounted: true, visible: true, focused: true };
        const left = await renderHook(() => useDeploymentProject(account.accountLifetime, 'source-app', shown));
        const right = await renderHook(demand => useDeploymentProject(account.accountLifetime, 'source-app', demand), { initialProps: shown });
        const demanded = () => getHomeAccountChangeDemandedServerIds().includes(serverId);
        try {
            expect(left.getCurrent().controller).toBe(right.getCurrent().controller);
            expect(demanded()).toBe(true);
            await left.unmount();
            expect(demanded(), 'the visible peer still needs the shared Home').toBe(true);
            await right.rerender({ ...shown, mounted: false });
            expect(demanded()).toBe(false);
            await right.rerender(shown);
            expect(demanded()).toBe(true);
            await right.unmount();
            expect(demanded()).toBe(false);
        } finally { await left.unmount(); await right.unmount(); account.dispose(); }
    });

    it('retains cached collection rows and passive invalidation without holding Home demand across navigation', async () => {
        const serverId = await homes.addHome({ name: 'Cached Demand', serverUrl: 'https://deployment-cached-demand.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
        await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Cached Environment' }, body: '{}' });
        let sourceName = 'Saved Source';
        homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: { ok: true, items: [environment],
            projectSources: [{ id: environment.projectSourceId, name: sourceName }], nextCursor: null } }) });
        const demand: DeploymentReadDemandV1 = { mounted: true, visible: true, focused: true };
        let hook = await renderHook(() => useDeploymentInventory(account.accountLifetime, demand));
        const reads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        try {
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.status).toBe('ready'));
            const controller = hook.getCurrent().controller;
            const snapshot = hook.getCurrent().snapshot;
            expect(reads()).toHaveLength(1);
            await hook.unmount();
            expect(getHomeAccountChangeDemandedServerIds()).not.toContain(serverId);
            hook = await renderHook(() => useDeploymentInventory(account.accountLifetime, demand));
            expect(hook.getCurrent().controller).toBe(controller);
            expect(hook.getCurrent().snapshot).toBe(snapshot);
            expect(reads(), 'a current cached collection survives navigation without another read').toHaveLength(1);
            await hook.unmount();
            sourceName = 'Renamed while unmounted';
            await act(async () => publishHomeAccountChange(serverId, ['projects:sources'], { changeKinds: ['account'] }));
            expect(reads(), 'passive invalidation does not fetch an unmounted collection').toHaveLength(1);
            expect(getHomeAccountChangeDemandedServerIds()).not.toContain(serverId);
            hook = await renderHook(() => useDeploymentInventory(account.accountLifetime, demand));
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.value?.items[0]?.projectSourceName).toBe(sourceName));
            expect(reads()).toHaveLength(2);
        } finally { await hook.unmount(); account.dispose(); }
    });
});
