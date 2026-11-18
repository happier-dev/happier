import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { deploymentDataTargetOperands, selectDeploymentRuntimeTargetLinkV1, isDeploymentDatabaseMoveCandidateV1 } from './deploymentSelectors.js';

it.each([
    { name: 'all services in a dedicated database', services: [], app: false, dependencies: false, expected: true },
    { name: 'all services in an app and database', services: [], app: true, dependencies: false, expected: false },
    { name: 'only the explicitly selected database', services: ['postgres'], app: true, dependencies: false, expected: true },
    { name: 'the app selected explicitly', services: ['app'], app: true, dependencies: false, expected: false },
    { name: 'the database starting an app dependency', services: ['postgres'], app: true, dependencies: true, expected: false },
])('classifies Move destination shape from $name', async ({ services, app, dependencies, expected }) => {
    const base = createDeploymentEnvironmentDetailV1();
    const definition = { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: `services:\n  postgres:\n    image: postgres:17\n${dependencies ? '    depends_on: [app]\n' : ''}${app ? '  app:\n    image: shop:1\n' : ''}`,
        profiles: [], services };
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, definition,
        template: { templateRef: { sourceId: 'apps', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            definition: { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
            services: ['postgres'], data: [{ engine: 'postgres', service: 'postgres' }] } } });
    expect(await isDeploymentDatabaseMoveCandidateV1(detail.content, selectDeploymentRuntimeTargetLinkV1(detail))).toBe(expected);
});

it.each([1, 2])('selects data custody only when the runtime has one source Machine (%i members)', count => {
    const detail = createDeploymentEnvironmentDetailV1();
    const runtime = detail.targetLinks[0]!.targetLink;
    runtime.machines = Array.from({ length: count }, (_, index) => `source-${index}`);
    runtime.members = runtime.machines.map(machineId => ({ machineId, installationId: `installed-${machineId}`, state: 'active' }));
    detail.environment.controllerMachineId = 'controller';
    detail.environment.runtimeTargetLinkId = runtime.id;
    const selected = deploymentDataTargetOperands({ environment: detail.environment,
        runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(detail) });
    expect(selected).toEqual(count === 1 ? { environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        targetLinkId: runtime.id, machineId: 'source-0', installationId: 'installed-source-0' } : null);
});
