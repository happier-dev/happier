import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForTestEvent } from '@/dev/testkit/hooks/waitForTestEvent';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1,
    createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildDeploymentAccountChangeV1, readDeploymentAccountChangeV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { useDeploymentActivity, useDeploymentCollection } from './useDeploymentReads';
import { ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useDeploymentProject, useDeploymentInventory, useDeploymentAccountController } = await import('./useDeploymentProject');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishHomeAccountChange, publishHomeAccountChangeWake } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

describe('deployment ProjectSource scope', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());

    it('refreshes only demanded bound Environments on a saved Secret rotation push', async () => {
        const serverId = await homes.addHome({ name: 'Secret revisions', serverUrl: 'https://deployment-secret-revisions.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const base = createDeploymentEnvironmentDetailV1();
        const demand = { mounted: true, visible: true, focused: true };
        const hook = await renderHook(() => useDeploymentProject(account.accountLifetime, base.environment.projectSourceId, demand));
        const controller = hook.getCurrent().controller!;
        const leases: ReturnType<typeof controller.acquireEnvironment>[] = [];
        let savedRevision = 1;
        try {
            for (const id of ['bound', 'other']) {
                const environment = createDeploymentEnvironmentHeaderV1({ id, serverId,
                    contentArtifactId: `artifact-${id}`, owner: { kind: 'account', accountId: 'alice' } });
                const binding = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: id, resourceRevision: 1 });
                await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
                    header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: id },
                    body: JSON.stringify({ ...base.content, bindings: [binding] }) });
                homes.answer(serverId, `/v1/deployments/environments/${id}`, { select: () => ({ body: { ok: true, environment,
                    targetLinks: [createDeploymentTargetLinkHeaderV1({ environmentId: id })],
                    savedSecretRevisions: [{ resourceId: id, revision: savedRevision }] } }) });
                const lease = controller.acquireEnvironment(id, demand);
                leases.push(lease);
                await act(async () => { await lease.refresh(); });
                expect(lease.getSnapshot().status).toBe('ready');
                expect(lease.getSnapshot().value?.secretRevisions[0]?.facts[0]).toMatchObject({
                    currentRevision: 1, runningRevision: null, status: 'unknown' });
            }
            // Creating the second Artifact also pushes the incumbent Account wake;
            // join that admitted refresh before measuring the Secret event alone.
            await act(async () => { await Promise.all(leases.map(lease => lease.refresh())); });
            const reads = (id: string) => homes.requests.filter(request => request.path.split('?')[0] === `/v1/deployments/environments/${id}`);
            const beforeBound = reads('bound').length;
            const beforeOther = reads('other').length;
            savedRevision = 2;
            await act(async () => publishHomeAccountChange(serverId, ['bound'], { changeKinds: ['savedSecretResource'] }));
            // One existing front-door Action reads its Environment approval scope,
            // then performs the metadata effect; this wake starts that Action once.
            await vi.waitFor(() => expect(reads('bound')).toHaveLength(beforeBound + 2));
            await vi.waitFor(() => expect(leases[0]!.getSnapshot().value?.secretRevisions[0]?.facts[0]?.currentRevision).toBe(2));
            expect(reads('other')).toHaveLength(beforeOther);
            expect(leases[1]!.getSnapshot().value?.secretRevisions[0]?.facts[0]?.currentRevision).toBe(1);
        } finally {
            leases.forEach(lease => lease.release());
            await hook.unmount();
            account.dispose();
        }
    });

    it('delivers global activity through a typed Home wake with no content, Machine or unrelated receipt reads', async () => {
        const serverId = await homes.addHome({ name: 'Badge Home', serverUrl: 'https://deployment-badge.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const demand = { mounted: true, visible: true, focused: true };
        let activity = { running: true, failed: false, attentionCount: 2 };
        homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: {
            ok: true, items: [], nextCursor: null, activity,
        } }) });
        const hook = await renderHook(() => {
            const controller = useDeploymentAccountController(account.accountLifetime, true, demand);
            return { ...useDeploymentActivity(controller, demand), controller };
        });
        const observed = hook.getCurrent().controller!.acquireActivity(demand);
        const listReads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        try {
            await act(async () => { await waitForTestEvent(observed.subscribe, observed.getSnapshot, snapshot => snapshot.status === 'ready'); });
            expect(hook.getCurrent().snapshot.value).toEqual(activity);
            expect(listReads()).toHaveLength(1);
            expect(new URLSearchParams(listReads()[0]!.path.split('?')[1]).get('projection')).toBe('activity');
            await act(async () => {
                publishHomeAccountChange(serverId, Array.from({ length: 100 }, (_, index) => buildDeploymentAccountChangeV1({
                    projectSourceId: 'source', environmentId: `environment-${index}`, deploymentId: `receipt-${index}`, revision: 2,
                }).entityId), { changeKinds: ['account'] });
            });
            expect(listReads()).toHaveLength(1);
            activity = { running: false, failed: true, attentionCount: 3 };
            await act(async () => {
                publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({ projectSourceId: 'source',
                    environmentId: 'changed-environment', revision: 3, activityChanged: true }).entityId], { changeKinds: ['account'] });
                await waitForTestEvent(observed.subscribe, observed.getSnapshot, snapshot => snapshot.value?.failed === true);
            });
            expect(hook.getCurrent().snapshot.value).toEqual(activity);
            expect(listReads()).toHaveLength(2);
            expect(homes.requests.filter(request => request.path.startsWith('/v1/artifacts') || request.path === '/v1/machines')).toEqual([]);
        } finally { observed.release(); await hook.unmount(); account.dispose(); }
    });

    it('opens one All inventory page with native membership, partial coverage and continuation', async () => {
        const serverId = await homes.addHome({ name: 'App inventory', serverUrl: 'https://app-inventory.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
        const runtime = createDeploymentTargetLinkHeaderV1();
        await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App inventory' }, body: '{}' });
        let sourceName = 'Saved Source on another device';
        homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: { ok: true, items: [environment],
            projectSources: [{ id: environment.projectSourceId, name: sourceName }],
            runtimeTargetLinks: [runtime], coverage: 'partial', nextCursor: 'native-next-page' } }) });
        const demand = { mounted: true, visible: true, focused: true };
        let hook = await renderHook(() => useDeploymentInventory(account.accountLifetime, demand));
        try {
            const controller = hook.getCurrent().controller;
            expect(controller).not.toBeNull();
            expect(controller!.scope.projectSourceId).toBeUndefined();
            const observed = controller!.acquireCollection({}, demand);
            try {
                await act(async () => { await waitForTestEvent(observed.subscribe, observed.getSnapshot, snapshot => snapshot.status === 'ready'); });
            } finally { observed.release(); }
            expect(hook.getCurrent().snapshot).toMatchObject({ status: 'ready', value: {
                items: [{ environment, title: 'App inventory', projectSourceName: sourceName, runtimeTargetLink: runtime }],
                coverage: 'partial', hasNextPage: true, hasPreviousPage: false,
            } });
            const reads = homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
            expect(reads).toHaveLength(1);
            expect(reads[0]!.path).not.toContain('projectSourceId');
            await hook.unmount();
            hook = await renderHook(() => useDeploymentInventory(account.accountLifetime, demand));
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.status).toBe('ready'));
            expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments'),
                'current Environment headers survive remount without another read').toHaveLength(1);
            sourceName = 'Renamed at the Source owner';
            await act(async () => publishHomeAccountChange(serverId, ['projects:sources'], { changeKinds: ['account'] }));
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.value?.items[0]?.projectSourceName).toBe(sourceName));
            expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments')).toHaveLength(2);
            expect(homes.requests.filter(request => request.path.startsWith('/v1/projects/sources'))).toEqual([]);
        } finally { await hook.unmount(); account.dispose(); }
    });

    it('adds a newly created Environment to a mounted empty Account-wide hub on its typed publication', async () => {
        const serverId = await homes.addHome({ name: 'New Environment', serverUrl: 'https://new-environment.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
        await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' }, body: '{}' });
        let created = false;
        homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: {
            ok: true, items: created ? [environment] : [], nextCursor: null,
        } }) });
        const demand = { mounted: true, visible: true, focused: true };
        const hook = await renderHook(() => useDeploymentInventory(account.accountLifetime, demand));
        const listReads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        try {
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.status).toBe('ready'));
            expect(hook.getCurrent().snapshot.value?.items).toEqual([]);
            expect(listReads()).toHaveLength(1);
            created = true;
            await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
                projectSourceId: environment.projectSourceId, environmentId: environment.id, revision: environment.revision,
            }).entityId], { changeKinds: ['account'] }));
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.value?.items[0]?.environment.id).toBe(environment.id));
            expect(listReads()).toHaveLength(2);
        } finally { await hook.unmount(); account.dispose(); }
    });

    it.each(['socket', 'feed-page'] as const)('refreshes demanded Environments on a linked-identity change (%s)', async (source) => {
        const serverId = await homes.addHome({ name: 'Deployment Identity', serverUrl: 'https://deployment-identity.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const first = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
        await account.createArtifactDocument({ artifactId: first.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }, body: '{}' });
        homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: { ok: true, items: [first], nextCursor: null } }) });
        const hook = await renderHook(() => {
            const project = useDeploymentProject(account.accountLifetime, first.projectSourceId, { mounted: true, visible: true, focused: true });
            return { project, rows: useDeploymentCollection(project.controller, { mounted: true, visible: true, focused: true }) };
        });
        const environmentReads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        try {
            await vi.waitFor(() => expect(hook.getCurrent().rows.snapshot.status).toBe('ready'));
            expect(environmentReads()).toHaveLength(1);
            // Restricted-Team Environment access follows the Account's linked identities.
            await act(async () => { void ((source === 'socket'
                ? publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'],
                    entityIds: [ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1] }, 'socket')
                // The focused Home's applied feed page publishes its exact changed ids.
                : publishHomeAccountChange(serverId, [ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1],
                    { feedPageConsumed: true, changeKinds: ['account'] }))); });
            await vi.waitFor(() => expect(environmentReads()).toHaveLength(2));
        } finally {
            await hook.unmount();
            account.dispose();
        }
    });

    it('shares the demanded read owner, accepts exact Home push, and withdraws it on real Account replacement', async () => {
        const serverUrl = 'https://deployment-project.test';
        const serverId = await homes.addHome({ name: 'Deployment Project', serverUrl, accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const first = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
        await account.createArtifactDocument({ artifactId: first.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }, body: '{}' });
        let row = first;
        homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: { ok: true, items: [row], nextCursor: null } }) });
        const hook = await renderHook(() => {
            const left = useDeploymentProject(account.accountLifetime, first.projectSourceId, { mounted: true, visible: true, focused: true });
            const right = useDeploymentProject(account.accountLifetime, first.projectSourceId, { mounted: true, visible: true, focused: true });
            return { left, right,
                leftRows: useDeploymentCollection(left.controller, { mounted: true, visible: true, focused: true }),
                rightRows: useDeploymentCollection(right.controller, { mounted: true, visible: true, focused: true }),
            };
        });
        const environmentReads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        try {
            expect(hook.getCurrent().left.controller).not.toBeNull();
            expect(hook.getCurrent().left.controller).toBe(hook.getCurrent().right.controller);
            const initial = hook.getCurrent().left.controller!.acquireCollection({}, { mounted: true, visible: true, focused: true });
            try {
                await act(async () => { await waitForTestEvent(initial.subscribe, initial.getSnapshot, snapshot => snapshot.status === 'ready'); });
            } finally { initial.release(); }
            expect(hook.getCurrent().leftRows.snapshot).toMatchObject({ status: 'ready', failure: null });
            expect(hook.getCurrent().leftRows.snapshot.value?.items).toEqual([{ environment: first, title: 'Staging',
                projectSourceName: null, liveVersionTitle: null, currentDeployment: null, chip: null }]);
            expect(environmentReads()).toHaveLength(1);
            const stable = hook.getCurrent().leftRows.snapshot;
            await act(async () => publishHomeAccountChange(serverId, ['unrelated-subject'], { changeKinds: ['account'] }));
            expect(hook.getCurrent().leftRows.snapshot).toBe(stable);
            expect(environmentReads()).toHaveLength(1);
            const unrelated = buildDeploymentAccountChangeV1({ projectSourceId: 'another-source', environmentId: 'another-environment', revision: 2 });
            await act(async () => publishHomeAccountChange(serverId, [unrelated.entityId], { changeKinds: ['account'] }));
            expect(environmentReads()).toHaveLength(1);
            row = createDeploymentEnvironmentHeaderV1({ ...first, revision: 2 });
            const change = buildDeploymentAccountChangeV1({ projectSourceId: first.projectSourceId, environmentId: first.id, revision: 2 });
            const settlement = buildDeploymentAccountChangeV1({ projectSourceId: first.projectSourceId, environmentId: first.id, deploymentId: 'settled-receipt', revision: 2 });
            expect(readDeploymentAccountChangeV1({ kind: change.kind, entityId: change.entityId })).toEqual({
                projectSourceId: first.projectSourceId, environmentId: first.id,
            });
            expect(readDeploymentAccountChangeV1({ ...change, hint: unrelated.hint })).toBeNull();
            expect(readDeploymentAccountChangeV1({ kind: 'account', entityId: `deployment-environment:${encodeURIComponent(first.id)}` }))
                .toEqual({ environmentId: first.id });
            const observed = hook.getCurrent().left.controller!.acquireCollection({}, { mounted: true, visible: true, focused: true });
            try {
                const changed = waitForTestEvent(observed.subscribe, observed.getSnapshot,
                    snapshot => snapshot.value?.items[0]?.environment.revision === 2);
                await act(async () => {
                    publishHomeAccountChange(serverId, [change.entityId, settlement.entityId], { changeKinds: ['account'] });
                    await changed;
                });
            } finally { observed.release(); }
            expect(hook.getCurrent().leftRows.snapshot.value?.items[0]?.environment.revision).toBe(2);
            expect(environmentReads()).toHaveLength(2);
            expect(hook.getCurrent().rightRows.snapshot.value).toBe(hook.getCurrent().leftRows.snapshot.value);
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
            await act(async () => { await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, { token }); });
            expect(hook.getCurrent().leftRows.snapshot.value).toBeNull();
        } finally {
            await hook.unmount();
            account.dispose();
        }
    });
});
