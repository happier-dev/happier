import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
const { View } = await import('react-native');
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
function Page(props: Readonly<{ controller: ReturnType<typeof createDeploymentReadControllerV1>; header?: React.ReactNode }>) {
    const demand = useDeploymentPresentationDemand(false);
    const scope = props.controller.scope;
    const lifetime = React.useMemo(() => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }), [scope]);
    return <ProjectDeploymentsView controller={props.controller} demand={demand} lifetime={lifetime as never}
        serverId={scope.serverId} accountId={scope.accountId} sourceId="source-app" header={props.header} />;
}

describe('Environment detail in a split pane', () => {
    it.each(['outcome_unknown', 'running_unverified', 'failed'] as const)('uses the shared needs-you treatment for a troubled Environment (%s), and removes it when the receipt recovers', async (trouble) => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previousLocalSettings = storage.getState().localSettings;
        storage.getState().applyLocalSettings({ sessionListNeedsYouHighlight: 'accent' });
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        let state: typeof receipt.deployment.state = trouble;
        const transport: DeploymentReadTransportV1 = {
            listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment, title: 'Staging',
                currentDeployment: { ...receipt.deployment, state } }], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: detail }),
            readReceipt: async () => ({ ok: true, value: receipt }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        };
        const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const demand = { mounted: true, visible: true, focused: true };
        const screen = await renderScreen(<AccountNoticeInvestigationBoundary><ProjectDeploymentsView controller={controller}
            demand={demand} lifetime={null} serverId={scope.serverId} accountId={scope.accountId} sourceId={scope.projectSourceId} />
        </AccountNoticeInvestigationBoundary>);
        try {
            const highlight = `project-deployments.rail.row.${detail.environment.id}:needs-you:accent`;
            expect(screen.findByTestId(highlight)).not.toBeNull();
            state = 'succeeded';
            await act(async () => { await controller.refreshDemanded(); });
            expect(screen.findByTestId(highlight)).toBeNull();
        } finally {
            await screen.unmount(); controller.retire();
            storage.setState({ localSettings: previousLocalSettings });
        }
    });

    it('keeps a failed Environment\'s state and where it runs on its rail row (lab d1 mixed)', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const transport: DeploymentReadTransportV1 = {
            listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment, title: 'Staging',
                currentDeployment: { ...receipt.deployment, state: 'failed' } }], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: detail }),
            readReceipt: async () => ({ ok: true, value: receipt }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        };
        const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const screen = await renderScreen(<AccountNoticeInvestigationBoundary><ProjectDeploymentsView controller={controller}
            demand={{ mounted: true, visible: true, focused: true }} lifetime={null} serverId={scope.serverId}
            accountId={scope.accountId} sourceId={scope.projectSourceId} /></AccountNoticeInvestigationBoundary>);
        try {
            expect(screen.findByTestId(`project-deployments.rail.row.${detail.environment.id}.state`)).not.toBeNull();
        } finally {
            await screen.unmount(); controller.retire();
        }
    });

    it('lists preview Environments under their own Previews group, after the Environments it counts (lab d5)', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const preview = { ...detail.environment, id: 'env-preview-142', purpose: 'preview' as const,
            previewTemplateEnvironmentId: detail.environment.id, previewRepositoryId: 'repo-app',
            previewPullRequestId: 'pr-142', previewTargetLinkId: 'link-preview' };
        const transport: DeploymentReadTransportV1 = {
            listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment, title: 'Staging' },
                { environment: preview, title: 'pr-142' }], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: detail }),
            readReceipt: async () => ({ ok: true, value: createDeploymentReceiptDetailV1() }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        };
        const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const screen = await renderScreen(<AccountNoticeInvestigationBoundary><ProjectDeploymentsView controller={controller}
            demand={{ mounted: true, visible: true, focused: true }} lifetime={null} serverId={scope.serverId}
            accountId={scope.accountId} sourceId={scope.projectSourceId} /></AccountNoticeInvestigationBoundary>);
        try {
            const ids = screen.tree.findAll((node: { props: Record<string, unknown> }) => typeof node.props.testID === 'string')
                .map((node: { props: Record<string, unknown> }) => node.props.testID as string);
            const group = ids.indexOf('project-deployments.rail.previews');
            expect(group).toBeGreaterThan(ids.indexOf(`project-deployments.rail.row.${detail.environment.id}`));
            expect(ids.indexOf('project-deployments.rail.row.env-preview-142')).toBeGreaterThan(group);
        } finally {
            await screen.unmount(); controller.retire();
        }
    });

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
    it.each([[true, false], [false, true]] as const)('drops its own Environments list and the hosting Project header where the Services column stands beside it (column %s), keeping the Environment page', async (columnVisible, listShown) => {
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const transport: DeploymentReadTransportV1 = {
            listEnvironments: async () => ({ ok: true, value: { items: [{ environment: detail.environment, title: 'Staging' }], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: detail }),
            readReceipt: async () => ({ ok: true, value: receipt }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [receipt.deployment], nextCursor: null } }),
        };
        const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' }, transport });
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const screen = await renderScreen(<AccountNoticeInvestigationBoundary>
            <AppShellColumnContext.Provider value={{ present: true, columnVisible }}>
                <DestinationInstanceContext.Provider value={{ tabId: 'pane-a', ref: { kind: 'route', params: { deploymentEnvironment: detail.environment.id } } as never,
                    pathname: '/deployments/source-app', focused: true, visible: true, isFocused: () => true, navigation }}>
                    <Page controller={controller} header={<View testID="hosting-header" />} />
                </DestinationInstanceContext.Provider>
            </AppShellColumnContext.Provider>
        </AccountNoticeInvestigationBoundary>);
        try {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
            expect(screen.findByTestId('project-deployments.environment')).not.toBeNull();
            expect(screen.findByTestId(`project-deployments.rail.row.${detail.environment.id}`) !== null).toBe(listShown);
            // One title: beside the column the Environment's own header leads; the Project is its meta link.
            expect(screen.findByTestId('hosting-header') !== null).toBe(listShown);
        } finally { await screen.unmount(); controller.retire(); }
    });
});
