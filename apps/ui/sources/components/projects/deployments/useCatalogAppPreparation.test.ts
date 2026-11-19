import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';

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

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
await import('@/sync/ops/actions/defaultActionExecutor');

describe('catalog App preparation entry', () => {
    beforeEach(() => homes.reset());
    afterEach(standardCleanup);
    afterEach(() => router.resetParams());

    it('opens the actual checkout-independent route through the existing Home and Project read owner', async () => {
        const serverId = await homes.addHome({ name: 'App Home', serverUrl: 'https://app-home.test',
            accountId: 'owner', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        const base = createDeploymentEnvironmentDetailV1();
        const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, serverId,
            owner: { kind: 'account', accountId: 'owner' } } });
        await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
            header: { kind: 'deployment-environment.v1', title: detail.content.name }, body: JSON.stringify(detail.content) });
        homes.answer(serverId, 'GET /v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        router.module.router.setParams({ serverId, projectSourceId: detail.environment.projectSourceId,
            deploymentEnvironment: detail.environment.id, deploymentTab: 'settings', deploymentSection: 'controller' });
        const { WorkspaceRouteBody } = await import('../../../app/(app)/deployments/[projectSourceId]');
        try {
            const screen = await renderScreen(React.createElement(WorkspaceRouteBody));
            await act(async () => { await waitForTestEvent(screen.subscribe,
                () => screen.findByTestId('project-deployments.environment.settings.controller'), node => node !== null); });
            expect(screen.findByTestId('project-deployments.environment.settings.controller')).not.toBeNull();
            // The Source identity is Account data; opening this route never needs a checkout or workspace.
            const sourcePath = `/v1/projects/sources/${detail.environment.projectSourceId}`;
            expect(homes.requests.filter(request => (request.path.includes('/projects/') || request.path.includes('workspace'))
                && !(request.method === 'GET' && request.path.split('?')[0] === sourcePath))
                .map(request => `${request.method} ${request.path}`)).toEqual([]);
        } finally { await act(async () => { account.dispose(); }); }
    });

    it('does no work on mount and prepares the exact pin through the existing scoped Action without repository or resource writes', async () => {
        const { useCatalogAppPreparation } = await import('./useCatalogAppPreparation');
        const serverIdentityId = `srv_${'b'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Catalog entry', serverUrl: 'https://catalog-entry.test',
            serverIdentityId, accountId: 'owner', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        const machine = { id: 'target', installationId: 'installed' };
        const template = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App',
            compose: { document: 'services:\n  app:\n    image: nginx:1\n', profiles: [], services: ['app'] },
            variables: [], generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true });
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [{ id: 'apps', title: 'Apps',
            format: 'happier-catalog', kinds: ['app'], url: 'https://apps.test/catalog.json', enabled: true,
            addedAt: 1, origin: { kind: 'user' }, removable: true }], http: {
            getJson: async () => ({ ok: true, value: { schemaVersion: 1, apps: [{ itemId: 'app', app: template }] }, fetchedAt: 1 }),
            getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No byte fetch'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            kind: 'app', sourceId: 'apps', itemId: 'app',
        })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected App');
        const input = DeploymentPublishPrepareInputV1Schema.parse({ serverId, machineId: machine.id, installationId: 'installed',
            projectSourceId: 'repo-free-source', sourceRevision: 1,
            templateRef: { sourceId: 'apps', itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref } });
        const prepared = DeploymentPublishPrepareResultV1Schema.parse({ kind: 'prepared', templateRef: input.templateRef,
            project: { projectSourceId: input.projectSourceId, sourceRevision: 1, owner: { kind: 'account', accountId: 'owner' } },
            machine: { machineId: machine.id, installationId: 'installed' }, template,
            creationDefaults: { values: { controllerMachineId: machine.id, buildMachineId: machine.id, retainPreviousDeployments: 1 },
                sources: { controllerMachineId: 'builtin', buildMachineId: 'builtin', retainPreviousDeployments: 'builtin' } } });
        const requests: unknown[] = [];
        await answerExternalActionAccountForHome(homes, serverId, {
            machineId: machine.id, installationId: machine.installationId,
            actionId: 'deployments.publish.prepare', tokenEpoch: 0, execute: operand => {
                requests.push(DeploymentPublishPrepareInputV1Schema.parse(operand));
                return prepared;
            },
        });
        const hook = await renderHook(() => useCatalogAppPreparation(account.accountLifetime));
        try {
            expect(requests).toHaveLength(0);
            expect(await hook.getCurrent()(input)).toEqual(prepared);
            expect(requests).toEqual([{ ...input, serverId: serverIdentityId }]);
            expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
            expect(homes.requestsFor('/v1/projects/sources')).toHaveLength(0);
            expect(homes.requestsFor('/v1/deployments/environments')).toHaveLength(0);
        } finally { await hook.unmount(); account.dispose(); }
    });
});
