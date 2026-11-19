import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HealthCheckDefinitionV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { finiteHealthCheckResult } from './finiteHealthCheckResult';
import { createCurrentDomainEdgeObservation } from './currentDomainEdgeObservation';
import { observeNativeWorkload } from './readNativeWorkload';

describe('current workload aggregate', () => {
    it('publishes the same observer’s current Domain edge fact beside unknown native members', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ controllerMachineId: 'controller',
            ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } });
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id,
            machines: ['controller'], members: [{ machineId: 'controller', installationId: 'installation-controller', state: 'active' }] });
        const edge = createCurrentDomainEdgeObservation();
        const observer = { machineId: 'controller', installationId: 'installation-controller' };
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
            targetLinkId: targetLink.id, revision: 1, state: 'active', contentArtifactId: 'artifact-domain',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account',
            createdAtMs: 1000, updatedAtMs: 1000 });
        const check = HealthCheckDefinitionV1Schema.parse({ checkId: 'http',
            kind: { pluginId: 'happier.machine.services', localId: 'http' },
            binding: { kind: 'domain', domainId: domain.id, targetLinkId: targetLink.id, condition: 'domain_probe_failed' },
            config: {}, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 });
        edge.publish({ sourceInstanceId: 'saved', sourceRevision: '1', checkId: check.checkId, kind: 'http',
            caller: { pluginId: 'happier.machine.services', machineId: observer.machineId, materializationId: 'installed' },
            occurrenceId: 'occurrence', check, environment, targetLink, domain, observer,
            result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'http', 1000, 995, 'down', { reason: 'connection' }) });
        const input = { environment: createDeploymentEnvironmentDetailV1({ environment,
                targetLinks: [{ targetLink, content: {} }] }), receipts: (async function* () {})(),
            signal: new AbortController().signal, observedAtMs: 1000,
            local: { machineId: 'controller', installationId: 'installation-controller',
                rows: { read: () => { throw new Error('no retained native handle'); }, subscribe: () => ({ dispose() {} }) },
                resolve: () => null },
            edge };
        const lease = await observeNativeWorkload(input);
        expect(lease?.snapshot()).toMatchObject({ n: 2, edgeUnreachable: true,
            members: expect.arrayContaining([expect.objectContaining({ machineId: 'edge', status: 'down' })]) });
        // A Domain mutation retires the old check result at the controller's next action boundary.
        edge.withdrawDomain(environment.id, domain.id);
        expect(lease?.snapshot()).toMatchObject({ edgeUnreachable: false,
            members: expect.arrayContaining([expect.objectContaining({ machineId: 'edge', status: 'unknown' })]) });
        lease?.dispose();
    });
});
