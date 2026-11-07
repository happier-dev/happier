import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1,
    createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';

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

afterEach(async () => { await standardCleanup(); await homes.reset(); route.resetParams(); route.spies.push.mockClear(); });

describe('Environment Deploy review wiring', () => {
    it('opens the canonical review page from the real Deploy button before any deploy effect', async () => {
        const serverId = await homes.addHome({ name: 'Deploy review', serverUrl: 'https://deploy-review.test',
            serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const scope = { serverId, accountId: 'owner', projectSourceId: detail.environment.projectSourceId };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        // The installed controller is the network boundary: it prepares and persists the review.
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.deploy',
            machineId: detail.environment.controllerMachineId!, installationId: 'installation-controller', tokenEpoch: 0,
            deploymentSource: { id: detail.environment.projectSourceId, revision: 1 },
            requesterInvocation: 'required', execute: (input, context) => {
                expect(context.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
                expect(input).toMatchObject({ serverId, environmentId: detail.environment.id,
                    targetLinkId: detail.targetLinks[0]!.targetLink.id });
                return { kind: 'approval_request_created', actionId: 'deployments.deploy', artifactId: 'prepared-deploy-review' };
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
            expect(screen.findByTestId('project-deployments.environment.deploy')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('project-deployments.environment.deploy');
            await act(async () => { await waitForTestEvent(screen.subscribe,
                () => screen.findByTestId('project-deployments.outcome.approval'), node => node !== null); });
            expect(homes.requestsFor('/v1/actions/deployments.deploy')).toHaveLength(1);
            expect(route.spies.push).toHaveBeenCalledWith(buildApprovalHref('prepared-deploy-review', serverId));
        } finally { await act(async () => { controller.retire(); }); }
    });
});
