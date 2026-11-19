import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';

const viewport = vi.hoisted(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => viewport, Dimensions: { get: () => viewport } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const router = await vi.hoisted(async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { deploymentEnvironment: 'environment-staging', deployment: 'deployment-a' } });
});
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(standardCleanup);
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { DeploymentEnvironmentDetail } = await import('./DeploymentEnvironmentDetail');

describe('receipt route read demand', () => {
    it.each(['standalone', 'direct page'] as const)('renders the exact Environment while the collection is absent: %s', async entry => {
        viewport.width = 390;
        router.resetParams();
        router.module.router.setParams({ deployment: undefined });
        const base = createDeploymentEnvironmentDetailV1();
        const detail = { ...base, environment: { ...base.environment, revision: 5 } };
        const counts = { collections: 0, environments: 0 };
        const requestedEnvironmentIds: string[] = [];
        const transport: DeploymentReadTransportV1 = {
            // A pending collection must not withhold an exact Environment that is already readable.
            listEnvironments: async (_scope, _query, options) => {
                counts.collections++;
                return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
                    () => reject(options.signal.reason), { once: true }));
            },
            readEnvironment: async (_scope, environmentId) => {
                counts.environments++;
                requestedEnvironmentIds.push(environmentId);
                return { ok: true, value: detail };
            },
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
            readReceipt: async () => ({ ok: true, value: createDeploymentReceiptDetailV1() }),
        };
        const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const demand = { mounted: true, visible: true, focused: true };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const screen = await renderScreen(<AccountNoticeInvestigationBoundary>{entry === 'standalone'
            ? <DeploymentEnvironmentDetail controller={controller} environmentId={detail.environment.id}
                demand={demand} accountId={scope.accountId} serverId={scope.serverId} phone
                deploy={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />
            : <ProjectDeploymentsView controller={controller} demand={demand} lifetime={lifetime}
                serverId={scope.serverId} accountId={scope.accountId} sourceId={scope.projectSourceId} />
        }</AccountNoticeInvestigationBoundary>);
        try {
            expect(screen.findByTestId('project-deployments.environment.state')).toBeNull();
            expect(screen.findByTestId('project-deployments.environment')).not.toBeNull();
            expect(counts).toEqual({ collections: entry === 'standalone' ? 0 : 1, environments: 1 });
            expect(requestedEnvironmentIds).toEqual([detail.environment.id]);
        } finally { await screen.unmount(); controller.retire(); }
    });

    it('opens only its Environment and receipts on a phone, then loads the collection when it is presented', async () => {
        viewport.width = 390;
        router.resetParams();
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const counts = { collections: 0, headers: 0, environments: 0, histories: 0, receipts: 0 };
        // QA #59 owns three Environments; unrelated inventory must not affect a receipt open.
        const rows = [detail.environment, ...['unrelated-r7', 'unrelated-r9'].map(id =>
            createDeploymentEnvironmentHeaderV1({ id, contentArtifactId: `artifact-${id}` }))];
        // The deployment transport is the network/content boundary. All route, hook and controller logic stays real.
        const transport: DeploymentReadTransportV1 = {
            listEnvironments: async () => {
                counts.collections++; counts.headers += rows.length;
                return { ok: true, value: { items: rows.map(environment => ({ environment, title: environment.id })), nextCursor: null } };
            },
            readEnvironment: async () => { counts.environments++; return { ok: true, value: detail }; },
            readReceipt: async () => { counts.receipts++; return { ok: true, value: receipt }; },
            listHistory: async () => { counts.histories++; return { ok: true, value: { ok: true, items: [receipt.deployment], nextCursor: null } }; },
        };
        const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const page = () => <AccountNoticeInvestigationBoundary><ProjectDeploymentsView controller={controller}
            demand={{ mounted: true, visible: true, focused: true }} lifetime={lifetime}
            serverId={scope.serverId} accountId={scope.accountId} sourceId={scope.projectSourceId} /></AccountNoticeInvestigationBoundary>;
        const screen = await renderScreen(page());
        try {
            expect(screen.findByTestId('project-deployments.receipt')).not.toBeNull();
            expect(counts).toEqual({ collections: 0, headers: 0, environments: 1, histories: 1, receipts: 1 });
            await act(async () => { viewport.width = 1440; await screen.update(page()); });
            expect(screen.findByTestId('project-deployments.receipt')).not.toBeNull();
            expect(counts).toEqual({ collections: 1, headers: rows.length, environments: 1, histories: 1, receipts: 1 });
        } finally { await screen.unmount(); controller.retire(); }
    });
});
