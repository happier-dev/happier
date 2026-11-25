import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { act, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const routerMock = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => routerMock.module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { deploymentDatabaseAgentLevelLabel } = await import('./DeploymentDatabaseAccessSettings');
const { DeploymentWorkbenchAccessSettings } = await import('./DeploymentWorkbenchAccess');
const { PluginUiHostPresentationScope } = await import('@happier-dev/plugin-ui/advanced');
const { projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');

afterEach(async () => {
    vi.useRealTimers();
    await standardCleanup();
    await homes.reset();
});

it('loads the access sheet policy once and refreshes only on the selected Environment arrival', async () => {
    const serverId = await homes.addHome({ name: 'Access policy', serverUrl: 'https://workbench-access.test', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const environment = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
    const content = createDeploymentEnvironmentDetailV1().content;
    const path = `/v1/deployments/environments/${environment.id}`;
    const readCounts = () => ({
        detail: homes.requests.filter(request => request.path.split('?')[0] === path).length,
        content: homes.requests.filter(request => request.path.split('?')[0] === '/v1/artifacts/read').length,
        inventory: homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments').length,
    });
    let dataAgentAccess = environment.dataAgentAccess;
    let revision = environment.revision;
    await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }, body: JSON.stringify(content) });
    homes.answer(serverId, path, { select: () => ({ body: { ok: true,
        environment: { ...environment, revision, dataAgentAccess }, targetLinks: [] } }) });
    const beforeOpen = readCounts();
    const commits = vi.fn();
    const screen = await renderAccountScreen(<PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(createSurfaceContextFixture())}
        presentationHost={{ renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null }}>
        <React.Profiler id="Environment access settings" onRender={commits}>
            <DeploymentWorkbenchAccessSettings
                scope={{ accountLifetime: account.accountLifetime, isCurrent: () => true }}
                target={{ kind: 'deployment_service', environment: { serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id },
                    deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'main' }}
                policy={{ setBy: 'environment', serverId, environmentId: environment.id, expectedRevision: revision,
                    access: { canRead: true, canWrite: false, reason: 'database_not_an_editor' } }}
            />
        </React.Profiler>
    </PluginUiHostPresentationScope>);
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(deploymentDatabaseAgentLevelLabel('read')));
        expect(readCounts()).toEqual({ detail: beforeOpen.detail + 1, content: beforeOpen.content + 1, inventory: beforeOpen.inventory });
        const open = readCounts();
        commits.mockClear();
        vi.useFakeTimers();
        act(() => { vi.advanceTimersByTime(60_000); });
        vi.useRealTimers();
        expect(readCounts()).toEqual(open);
        expect(commits).not.toHaveBeenCalled();

        dataAgentAccess = 'none';
        revision++;
        const change = buildDeploymentAccountChangeV1({ projectSourceId: environment.projectSourceId, environmentId: environment.id, revision });
        await act(async () => publishHomeAccountChange(serverId, [change.entityId], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(deploymentDatabaseAgentLevelLabel('none')));
        expect({ requests: readCounts(), reactCommits: commits.mock.calls.length }).toEqual({
            requests: { ...open, detail: open.detail + 1, content: open.content + 1 }, reactCommits: 1,
        });
    } finally {
        await screen.unmount();
        account.dispose();
    }
});
