import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const router = await vi.hoisted(async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock();
});
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(standardCleanup);
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { useDeploymentPresentationDemand } = await import('./useDeploymentPresentationDemand');
const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');

/** The route's demand producer under a hosted destination; the shared controller and transport boundary stay real. */
function Page(props: Readonly<{ controller: ReturnType<typeof createDeploymentReadControllerV1> }>) {
    const demand = useDeploymentPresentationDemand(false);
    const scope = props.controller.scope;
    const lifetime = React.useMemo(() => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }), [scope]);
    return <ProjectDeploymentsView controller={props.controller} demand={demand} lifetime={lifetime as never}
        serverId={scope.serverId} accountId={scope.accountId} sourceId="source-app" />;
}

describe('Environment detail in a split pane', () => {
    it.each([[true, 1], [false, 0]] as const)('reads the selected Environment while its pane is visible (%s) even when another pane has focus', async (visible, reads) => {
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        let environmentReads = 0;
        // QA #60: a retained pane beside the focused one stayed on "Loading" with its rail populated.
        const transport: DeploymentReadTransportV1 = {
            listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment, title: 'Staging' }], nextCursor: null } }),
            readEnvironment: async () => { environmentReads++; return { ok: true, value: detail }; },
            readReceipt: async () => ({ ok: true, value: receipt }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [receipt.deployment], nextCursor: null } }),
        };
        const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' }, transport });
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const screen = await renderScreen(<AccountNoticeInvestigationBoundary>
            <DestinationInstanceContext.Provider value={{ tabId: 'pane-b', ref: { kind: 'route', params: { deploymentEnvironment: detail.environment.id } } as never,
                pathname: '/deployments/source-app', focused: false, visible, isFocused: () => false, navigation }}>
                <Page controller={controller} />
            </DestinationInstanceContext.Provider>
        </AccountNoticeInvestigationBoundary>);
        try {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
            expect(environmentReads).toBe(reads);
            expect(screen.findByTestId('project-deployments.environment') !== null).toBe(visible);
        } finally { await screen.unmount(); controller.retire(); }
    });
});
