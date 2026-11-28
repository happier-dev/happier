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
const { DeploymentWorkbenchAccessObserver, DeploymentWorkbenchAccessSettings } = await import('./DeploymentWorkbenchAccess');
const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
const { PluginUiHostPresentationScope } = await import('@happier-dev/plugin-ui/advanced');
const { projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');

it('presents the chosen Person editor independently of the Agent read ceiling', async () => {
    const serverId = await homes.addHome({ name: 'Workbench viewer', serverUrl: 'https://workbench-viewer.test', accountId: 'member', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const environment = createDeploymentEnvironmentHeaderV1({ serverId, dataEditorMode: 'chosen', dataAgentAccess: 'read' });
    const content = createDeploymentEnvironmentDetailV1().content;
    await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }, body: JSON.stringify(content) });
    let editData = true;
    let revision = environment.revision;
    homes.answer(serverId, `/v1/deployments/environments/${environment.id}`, { select: () => ({ body: { ok: true,
        environment: { ...environment, revision, capabilities: { ...environment.capabilities, editData } }, targetLinks: [] } }) });
    const target = { kind: 'deployment_service', environment: { serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id },
        deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'main' } as const;
    const scope = { accountLifetime: account.accountLifetime, isCurrent: () => true };
    const access = await import('./DeploymentWorkbenchAccess');
    let seen: unknown;
    function Probe() {
        seen = access.useDeploymentWorkbenchViewerAccess?.(target, scope);
        return null;
    }
    const screen = await renderAccountScreen(<Probe />);
    try {
        await waitForHomeGovernance(() => expect(seen).toEqual({ canRead: true, canWrite: true }));
        editData = false;
        revision++;
        const change = buildDeploymentAccountChangeV1({ projectSourceId: environment.projectSourceId, environmentId: environment.id, revision });
        await act(async () => publishHomeAccountChange(serverId, [change.entityId], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(seen).toEqual({ canRead: true, canWrite: false, reason: 'database_not_an_editor' }));
    } finally {
        await screen.unmount();
        account.dispose();
    }
});

afterEach(async () => {
    vi.useRealTimers();
    await standardCleanup();
    await homes.reset();
});

it('delivers the selected Environment policy wake once when a retained Review returns', async () => {
    const serverId = await homes.addHome({ name: 'Review policy', serverUrl: 'https://workbench-review.test', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const environment = { serverId, projectSourceId: 'source', environmentId: 'staging' };
    const scope = { accountLifetime: account.accountLifetime, isCurrent: () => true };
    const target = { kind: 'deployment_service', environment, deploymentId: 'deployment',
        targetLinkId: 'link', serviceId: 'postgres', database: 'main' } as const;
    const onChanged = vi.fn();
    const review = (visible: boolean) => <DestinationInstanceContext.Provider
        value={{ tabId: 'workbench', ref: { kind: 'workbench', params: {} },
            pathname: '/plugins/happier.database/workbench', visible, focused: visible, isFocused: () => visible }}>
        <DeploymentWorkbenchAccessObserver target={target} onChanged={onChanged} scope={scope} />
    </DestinationInstanceContext.Provider>;
    const wake = (environmentId: string, revision: number) => {
        const change = buildDeploymentAccountChangeV1({ projectSourceId: environment.projectSourceId, environmentId, revision });
        return act(async () => publishHomeAccountChange(serverId, [change.entityId], { changeKinds: ['account'] }));
    };
    const screen = await renderAccountScreen(review(true));
    try {
        await screen.update(review(false));
        await wake('other-environment', 1);
        await screen.update(review(true));
        expect(onChanged).not.toHaveBeenCalled();
        await screen.update(review(false));
        await wake(environment.environmentId, 2);
        await wake(environment.environmentId, 3);
        expect(onChanged).not.toHaveBeenCalled();
        await screen.update(review(true));
        expect(onChanged).toHaveBeenCalledOnce();
        await wake(environment.environmentId, 4);
        expect(onChanged).toHaveBeenCalledTimes(2);
    } finally {
        await screen.unmount();
        account.dispose();
    }
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
    let dataEditorMode = environment.dataEditorMode;
    let editData = false;
    const onEditingAllowed = vi.fn();
    let revision = environment.revision;
    await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }, body: JSON.stringify(content) });
    homes.answer(serverId, path, { select: () => ({ body: { ok: true,
        environment: { ...environment, revision, dataAgentAccess, dataEditorMode, capabilities: { ...environment.capabilities, editData } }, targetLinks: [] } }) });
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
                onEditingAllowed={onEditingAllowed}
            />
        </React.Profiler>
    </PluginUiHostPresentationScope>);
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(deploymentDatabaseAgentLevelLabel('read')));
        expect(onEditingAllowed).not.toHaveBeenCalled();
        expect(readCounts()).toEqual({ detail: beforeOpen.detail + 1, content: beforeOpen.content + 1, inventory: beforeOpen.inventory });
        const open = readCounts();
        commits.mockClear();
        vi.useFakeTimers();
        act(() => { vi.advanceTimersByTime(60_000); });
        vi.useRealTimers();
        expect(readCounts()).toEqual(open);
        expect(commits).not.toHaveBeenCalled();

        dataAgentAccess = 'none';
        dataEditorMode = 'managers';
        editData = true;
        revision++;
        const change = buildDeploymentAccountChangeV1({ projectSourceId: environment.projectSourceId, environmentId: environment.id, revision });
        await act(async () => publishHomeAccountChange(serverId, [change.entityId], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(deploymentDatabaseAgentLevelLabel('none')));
        expect(onEditingAllowed).toHaveBeenCalledOnce();
        expect({ requests: readCounts(), reactCommits: commits.mock.calls.length }).toEqual({
            requests: { ...open, detail: open.detail + 1, content: open.content + 1 }, reactCommits: 1,
        });
    } finally {
        await screen.unmount();
        account.dispose();
    }
});
