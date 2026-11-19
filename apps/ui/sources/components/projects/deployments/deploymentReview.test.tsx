import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION } from './deploymentPlatformTargetPlugin.testFixture';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const route = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => route.module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentActions } = await import('./deploymentActions');
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { buildApprovalHref } = await import('@/components/approvals/approvalNavigation');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');

afterEach(async () => { await standardCleanup(); await homes.reset(); route.resetParams(); route.spies.push.mockClear(); });

describe('Environment Deploy review wiring', () => {
    it.each(['gitIntegration', 'upload'] as const)('opens the canonical review page for the selected %s method before any deploy effect', async sourceMethod => {
        const serverId = await homes.addHome({ name: 'Deploy review', serverUrl: 'https://deploy-review.test',
            serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const authored = createDeploymentTargetsTestPlugin('com.example.review-upload', undefined, { upload: true });
        const accountContext = await captureLazyActionAccountContext(serverId);
        const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
            activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
            accountLifetime: accountContext.accountLifetime, publishProjection: true });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
            serverId, owner: { kind: 'account', accountId: accountContext.accountId } }),
            targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ source: { kind: 'plugin',
                contribution: { pluginId: authored.manifest.id, localId: 'beta' } }, targetKind: 'beta',
                state: 'configured', machines: [], members: [], activeDeploymentId: undefined }), content: {} }] });
        const scope = { serverId, accountId: 'owner', projectSourceId: detail.environment.projectSourceId };
        const lifetime = accountContext.accountLifetime;
        const environmentRead = DeploymentEnvironmentGetResultV1Schema.parse({
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        });
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: environmentRead });
        // The installed controller's wire reply is the boundary; review navigation stays real.
        const approvalResult = ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            actionId: 'deployments.deploy', artifactId: 'prepared-deploy-review' });
        let controllerRequest: Readonly<{ input: unknown; target: unknown }> | undefined;
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.deploy',
            machineId: detail.environment.controllerMachineId!, installationId: 'installation-controller', tokenEpoch: 0,
            deploymentSource: { id: detail.environment.projectSourceId, revision: 1 },
            requesterInvocation: 'required', execute: (input, context) => {
                controllerRequest = { input, target: context.target };
                return approvalResult;
            } });
        const receipt = createDeploymentReceiptDetailV1();
        const controller = createDeploymentReadControllerV1({ scope, transport: {
            listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment,
                title: detail.content.name }], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: detail }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
            readReceipt: async () => ({ ok: true, value: receipt }),
        } });
        route.module.router.setParams({ deploymentEnvironment: detail.environment.id });
        try {
            const screen = await renderScreen(<ProjectDeploymentsView controller={controller}
                actions={createDeploymentActions(lifetime, scope.projectSourceId)}
                demand={{ mounted: true, visible: true, focused: true }} accountId={scope.accountId}
                serverId={serverId} lifetime={lifetime} sourceId={scope.projectSourceId} />);
            const method = () => screen.root.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === 'project-deployments.environment.sourceMethod');
            await waitForHomeGovernance(() => expect(method()).toBeDefined());
            await act(async () => method()!.props.onChange(sourceMethod));
            expect(screen.findByTestId('project-deployments.environment.deploy')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('project-deployments.environment.deploy');
            await waitForHomeGovernance(() => expect(route.spies.push, JSON.stringify({
                deployDisabled: screen.findByTestId('project-deployments.environment.deploy')?.props.disabled,
                issued: homes.requestsFor('/v1/actions/deployments.deploy').length,
                controllerRequest,
            })).toHaveBeenCalledWith(buildApprovalHref('prepared-deploy-review', serverId)));
            expect(controllerRequest?.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            expect(controllerRequest?.input).toMatchObject({ serverId: accountContext.serverIdentityId, environmentId: detail.environment.id,
                targetLinkId: detail.targetLinks[0]!.targetLink.id, sourceMethod });
            expect(homes.requestsFor('/v1/actions/deployments.deploy')).toHaveLength(1);
        } finally { await act(async () => { controller.retire(); }); await installed.dispose(); accountContext.dispose(); }
    });
});
