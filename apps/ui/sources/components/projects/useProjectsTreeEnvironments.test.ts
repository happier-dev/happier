import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import type { ProjectsTreeProject } from './projectsTreeRows';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useProjectsTreeEnvironments } = await import('./useProjectsTreeEnvironments');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

afterEach(() => standardCleanup());

it('keeps changed checkout and Team facts when a same-named Project has unchanged Environments', async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Projects', serverUrl: 'https://projects-retention.test',
        accountId: 'alice', accountEncryptionMode: 'plain' });
    for (const path of ['/v2/cursor', '/v2/sessions', '/v2/sessions/active', '/v2/sessions/metadata-upgrades', '/v2/session-organization']) {
        const response = createEmptyAccountBootstrapHttpResponse(path);
        if (!response) throw new Error(`Missing Account bootstrap fixture: ${path}`);
        homes.answer(serverId, path, { body: await response.json() });
    }
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://projects-retention.test')!.token! });
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    const account = await captureLazyActionAccountContext(serverId);
    const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
    const second = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId,
        id: 'environment-second', contentArtifactId: 'environment-second-content' }) });
    for (const entry of [detail, second]) await account.createArtifactDocument({ artifactId: entry.environment.contentArtifactId,
        header: { kind: 'deployment-environment.v1', title: 'Production' }, body: JSON.stringify(entry.content) });
    let environments = [detail.environment, second.environment];
    homes.answer(serverId, '/v1/deployments/environments', { select: () => ({ body: {
        ok: true, items: environments, currentDeployments: [], runtimeTargetLinks: [], nextCursor: null,
    } }) });
    const source = ProjectSourceV1Schema.parse({ id: detail.environment.projectSourceId, revision: 1,
        name: 'App', audience: [], createdByAccountId: 'alice' });
    const initial: ProjectsTreeProject = { key: 'app', name: 'App', source: { serverId, source }, teamLabel: 'Before',
        checkouts: [{ refId: 'checkout-a', machineId: 'devbox', machineName: 'Devbox', label: 'main',
            path: '~/app', attention: null, offline: false }] };
    const neighbor: ProjectsTreeProject = { key: 'neighbor', name: 'Neighbor', checkouts: [] };
    const hook = await renderHook(projects => useProjectsTreeEnvironments(projects), {
        initialProps: [initial, neighbor] as readonly ProjectsTreeProject[],
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent()[0]?.environments).toHaveLength(2));
        const before = hook.getCurrent()[0]!;
        const changed: ProjectsTreeProject = { ...initial, teamLabel: 'After', checkouts: [
            { ...initial.checkouts[0]!, machineName: 'Renamed Devbox', offline: true },
            { ...initial.checkouts[0]!, refId: 'checkout-b', label: 'feature', path: '~/app-feature' },
        ] };
        await hook.rerender([changed, neighbor]);
        expect(hook.getCurrent()[0]).toMatchObject({ teamLabel: 'After', checkouts: changed.checkouts });
        expect(hook.getCurrent()[0]?.environments).toBe(before.environments);
        expect(hook.getCurrent()[1]).toBe(neighbor);
        const updated = hook.getCurrent()[0];
        await hook.rerender([changed, neighbor]);
        expect(hook.getCurrent()[0]).toBe(updated);
        environments = [second.environment, detail.environment];
        await act(async () => publishHomeAccountChange(serverId));
        await vi.waitFor(() => expect(hook.getCurrent()[0]?.environments?.map(row => row.environmentId))
            .toEqual(environments.map(row => row.id)));
        expect(hook.getCurrent()[0]?.environments?.[0]).toBe(before.environments?.[1]);
        expect(hook.getCurrent()[0]?.environments?.[1]).toBe(before.environments?.[0]);
    } finally { await hook.unmount(); account.dispose(); }
});
