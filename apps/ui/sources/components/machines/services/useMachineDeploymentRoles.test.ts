import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useMachineDeploymentRoles } = await import('./useMachineServiceEnvironments');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
beforeEach(() => homes.reset());
afterEach(() => standardCleanup());

it('reads exact role pages and admitted headers without service inventory, hides denied names, and withdraws hidden demand', async () => {
    const serverId = await homes.addHome({ name: 'Deployment roles', serverUrl: 'https://machine-roles.test',
        serverIdentityId: 'srv_machine_roles', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'storefront', serverId: 'srv_machine_roles',
        owner: { kind: 'account', accountId: 'alice' } });
    await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Storefront' }, body: '{}' });
    let roles = ['controller', 'build', 'edge'];
    let referenceReads = 0;
    let headersUnavailable = false;
    homes.answer(serverId, '/v1/deployments/machine-references', { select: (_body, request) => {
        referenceReads++;
        const query = new URL(request.url).searchParams;
        expect(query.get('machineId')).toBe('role-machine');
        expect(query.get('homeId')).toBe('srv_machine_roles');
        return { body: { homeId: 'srv_machine_roles', machineId: 'role-machine', coverage: 'complete',
            references: query.has('cursor')
                ? [{ kind: 'deployment_environment', id: 'denied', name: 'MUST NOT DISPLAY', deploymentRoles: ['edge'] }]
                : [{ kind: 'deployment_environment', id: environment.id, name: '', deploymentRoles: roles }],
            nextCursor: query.has('cursor') ? null : 'second' } };
    } });
    homes.answer(serverId, '/v1/deployments/environments', { select: (_body, request) => {
        const query = new URL(request.url).searchParams;
        expect(query.getAll('environmentIds')).toEqual(['denied', environment.id]);
        expect(query.has('machineId')).toBe(false);
        if (headersUnavailable) return { status: 503, body: { error: 'temporarily_unavailable' } };
        return { body: { ok: true, items: [environment], nextCursor: null } };
    } });
    const hook = await renderHook(({ active }: { active: boolean }) => useMachineDeploymentRoles({
        serverId, machineId: 'role-machine', active,
    }), { initialProps: { active: false } });
    try {
        await flushHookEffects();
        expect(referenceReads).toBe(0);
        await hook.rerender({ active: true });
        await waitForHomeGovernance(async () => { await flushHookEffects();
            expect(hook.getCurrent().status).toBe('ready');
            expect(hook.getCurrent().environments)
                .toEqual([{ environmentId: environment.id, title: 'Storefront', projectSourceId: environment.projectSourceId, roles }]);
        });
        expect(referenceReads).toBe(2);
        expect(homes.requests.filter(request => request.path.startsWith('/v1/machines')
            || request.path.startsWith('/v1/deployments/receipts'))).toHaveLength(0);
        await act(async () => publishHomeAccountChange(serverId, ['usage:unrelated'], { changeKinds: ['account'] }));
        expect(referenceReads).toBe(2);
        roles = ['edge'];
        await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
            environmentId: environment.id, revision: 2 }).entityId], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(hook.getCurrent().environments[0]?.roles).toEqual(['edge']));
        expect(referenceReads).toBe(4);
        headersUnavailable = true;
        await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
            environmentId: environment.id, revision: 3 }).entityId], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
        expect(referenceReads).toBe(6);
        await hook.rerender({ active: false });
        await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
            environmentId: environment.id, revision: 4 }).entityId], { changeKinds: ['account'] }));
        await flushHookEffects();
        expect(referenceReads).toBe(6);
    } finally { await hook.unmount(); account.dispose(); }
});

it('does not publish a late role response after Account replacement', async () => {
    const serverId = await homes.addHome({ name: 'Retired roles', serverUrl: 'https://retired-roles.test',
        serverIdentityId: 'srv_retired_roles', accountId: 'alice', currentAccount: true });
    const response = createDeferred<void>();
    homes.answer(serverId, '/v1/deployments/machine-references', { select: (_body, request) => ({
        ...(new Headers(request.init?.headers).get('authorization') === `Bearer ${createAccountTokenForTests('alice', { currentAccount: true })}`
            ? { respondAfter: response.promise } : {}), body: {
        homeId: 'srv_retired_roles', machineId: 'machine', coverage: 'complete',
        references: new Headers(request.init?.headers).get('authorization') === `Bearer ${createAccountTokenForTests('bob', { currentAccount: true })}`
            ? [] : [{ kind: 'deployment_environment', id: 'private', name: 'Private Environment', deploymentRoles: ['build'] }], nextCursor: null,
    } }) });
    const hook = await renderHook(() => useMachineDeploymentRoles({ serverId, machineId: 'machine', active: true }));
    try {
        await waitForHomeGovernance(async () => { await flushHookEffects();
            expect(homes.requests.filter(request => request.path.startsWith('/v1/deployments/machine-references?'))).toHaveLength(1); });
        await act(async () => { await homes.switchAccount(serverId, 'bob', { currentAccount: true }); response.resolve(); });
        await flushHookEffects();
        expect(hook.getCurrent().environments).toEqual([]);
        expect(homes.requests.filter(request => request.path.startsWith('/v1/deployments/environments'))).toHaveLength(0);
    } finally { await hook.unmount(); }
});

it('reads the census once per page open with the Machine header and the Services tab both mounted', async () => {
    const serverId = await homes.addHome({ name: 'Shared roles', serverUrl: 'https://shared-roles.test',
        serverIdentityId: 'srv_shared_roles', accountId: 'alice', currentAccount: true });
    let referenceReads = 0;
    homes.answer(serverId, '/v1/deployments/machine-references', { select: () => {
        referenceReads++;
        return { body: { homeId: 'srv_shared_roles', machineId: 'machine', coverage: 'complete', references: [], nextCursor: null } };
    } });
    // The Machine page header's role facts and the Services tab's roles section, mounted together on one page.
    const both = () => [
        useMachineDeploymentRoles({ serverId, machineId: 'machine', active: true }),
        useMachineDeploymentRoles({ serverId, machineId: 'machine', active: true }),
    ] as const;
    let page = await renderHook(both);
    try {
        await waitForHomeGovernance(async () => { await flushHookEffects();
            expect(page.getCurrent().map(roles => roles.status)).toEqual(['ready', 'ready']); });
        expect(referenceReads, 'one census read for both consumers').toBe(1);
        await page.unmount();
        // Opening the page again reads once more, still once for both consumers.
        page = await renderHook(both);
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(referenceReads).toBe(2); });
        await flushHookEffects();
        expect(referenceReads).toBe(2);
        expect(page.getCurrent().map(roles => roles.status)).toEqual(['ready', 'ready']);
    } finally { await page.unmount(); }
});
