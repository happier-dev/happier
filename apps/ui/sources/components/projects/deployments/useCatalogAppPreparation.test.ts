import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

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

    it('does no work on mount and prepares the exact pin through the existing scoped Action without repository or resource writes', async () => {
        const { useCatalogAppPreparation } = await import('./useCatalogAppPreparation');
        const serverId = await homes.addHome({ name: 'Catalog entry', serverUrl: 'https://catalog-entry.test',
            serverIdentityId: `srv_${'b'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        const machine = createPlainMachineRowFixture({ id: 'target', accountId: 'owner' });
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => id === machine.id ? machine : null).json(),
        }) });
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
        homes.answer(serverId, '/v1/actions/deployments.publish.prepare', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            requests.push(envelope.input);
            return { body: { v: 1, actionId: 'deployments.publish.prepare', requestId: envelope.requestId,
                execution: { ok: true, result: prepared } } };
        } });
        const hook = await renderHook(() => useCatalogAppPreparation(account.accountLifetime));
        try {
            expect(requests).toHaveLength(0);
            expect(await hook.getCurrent()(input)).toEqual(prepared);
            expect(requests).toEqual([input]);
            expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
            expect(homes.requestsFor('/v1/projects/sources')).toHaveLength(0);
            expect(homes.requestsFor('/v1/deployments/environments')).toHaveLength(0);
        } finally { await hook.unmount(); account.dispose(); }
    });
});
