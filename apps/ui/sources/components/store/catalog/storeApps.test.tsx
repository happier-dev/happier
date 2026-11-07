import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { StoreInstalledInput } from './storeKinds';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useInstalledScope } = await import('./storeAccountAdmission');
const { useInstalledApps } = await import('./storeApps');

beforeEach(() => homes.reset());
afterEach(async () => { standardCleanup(); await homes.reset(); });

it('preserves native All and exact-Machine pages, runtime membership and explicit navigation without membership gets', async () => {
    const serverId = await homes.addHome({ name: 'Applications', serverUrl: 'https://store-apps.test', accountId: 'alice' });
    const account = await captureLazyActionAccountContext(serverId);
    const first = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
    const later = createDeploymentEnvironmentHeaderV1({ ...first, id: 'later-app', contentArtifactId: 'later-label', projectSourceId: 'other-source' });
    const runtime = createDeploymentTargetLinkHeaderV1({ machines: ['runtime'], members: [{ machineId: 'runtime', installationId: 'runtime-installation', state: 'active' }] });
    for (const environment of [first, later]) await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: environment.id }, body: '{}' });
    homes.answer(serverId, '/v1/deployments/environments', { select: (_input, request) => {
        const url = new URL(request.url);
        const machine = url.searchParams.get('machineId');
        const cursor = url.searchParams.get('cursor');
        return { body: { ok: true, items: machine === 'absent' ? [] : [cursor ? later : first],
            runtimeTargetLinks: cursor || machine === 'absent' ? [] : [runtime],
            nextCursor: cursor || machine ? null : 'later-page', coverage: 'complete' } };
    } });
    let input: StoreInstalledInput = { scope: account.accountLifetime.scope, machine: null, projectKey: null };
    const hook = await renderHook(() => useInstalledApps(input, { presented: true }, useInstalledScope(input)));
    const reads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
    try {
        await vi.waitFor(() => expect(hook.getCurrent().rows).toHaveLength(1));
        expect(hook.getCurrent().rows[0]).toMatchObject({ kind: 'app', scope: input.scope, native: { environment: first, runtimeTargetLink: runtime } });
        expect(hook.getCurrent().coverage).toHaveProperty('partial');
        await flushHookEffects();
        expect(reads()).toHaveLength(1);
        expect(reads()[0]!.path).not.toContain('machineId');
        expect(reads()[0]!.path).not.toContain('projectSourceId');
        await act(async () => { hook.getCurrent().continuation?.(); });
        await vi.waitFor(() => expect(hook.getCurrent().rows[0]?.native.environment.id).toBe(later.id));
        expect(reads()).toHaveLength(2);
        expect(reads()[1]!.path).toContain('cursor=later-page');
        input = { ...input, machine: { serverIdentityId: serverId, machineId: 'runtime' } };
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().rows[0]?.native.environment.id).toBe(first.id));
        expect(reads()).toHaveLength(3);
        expect(reads()[2]!.path).toContain('machineId=runtime');
        expect(reads()[2]!.path).not.toContain('cursor=');
        expect(hook.getCurrent().coverage).toBe('available');
        expect(homes.requests.filter(request => request.path.startsWith('/v1/deployments/environments/'))).toHaveLength(0);
        input = { ...input, machine: { serverIdentityId: 'foreign-home', machineId: 'runtime' } };
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: { unavailable: 'scope-retired' } });
        expect(reads()).toHaveLength(3);
    } finally { await hook.unmount(); account.dispose(); }
});

it('distinguishes held loading, native unavailable and confirmed empty, and does not retry a settled failure', async () => {
    const serverId = await homes.addHome({ name: 'Empty applications', serverUrl: 'https://store-apps-empty.test', accountId: 'alice' });
    const account = await captureLazyActionAccountContext(serverId);
    const held = createDeferred<void>();
    homes.answer(serverId, '/v1/deployments/environments', {
        respondAfter: held.promise, body: { ok: false, error: 'deployment_access_denied' },
    });
    const input: StoreInstalledInput = { scope: account.accountLifetime.scope, machine: null, projectKey: null };
    const hook = await renderHook(() => useInstalledApps(input, { presented: true }, useInstalledScope(input)));
    try {
        await vi.waitFor(() => expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments')).toHaveLength(1));
        expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: 'loading' });
        await act(async () => { held.resolve(); });
        await vi.waitFor(() => expect(hook.getCurrent().coverage).toMatchObject({ unavailable: { code: 'deployment_access_denied', retryable: false } }));
        await flushHookEffects();
        expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments')).toHaveLength(1);
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [], runtimeTargetLinks: [], coverage: 'complete', nextCursor: null } });
        await act(async () => { await hook.getCurrent().continuation?.(); });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: 'available' }));
    } finally { await hook.unmount(); account.dispose(); }
});
