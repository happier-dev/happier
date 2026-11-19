import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HealthCheckDefinitionV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { finiteHealthCheckResult } from './finiteHealthCheckResult';
import { createCurrentDomainEdgeObservation } from './currentDomainEdgeObservation';

describe('current saved Domain observations', () => {
    it('reads only the exact saved source and observer while preserving outside provenance', () => {
        const environment = createDeploymentEnvironmentHeaderV1({ controllerMachineId: 'outside-observer' });
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id,
            machines: ['runtime'], members: [{ machineId: 'runtime', installationId: 'installation', state: 'active' }] });
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
            targetLinkId: targetLink.id, revision: 1, state: 'active', contentArtifactId: 'artifact-domain',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account', createdAtMs: 1000, updatedAtMs: 1000 });
        const current = createCurrentDomainEdgeObservation();
        const check = HealthCheckDefinitionV1Schema.parse({ checkId: 'http',
            kind: { pluginId: 'happier.machine.services', localId: 'http' },
            binding: { kind: 'environmentHealth', domainId: domain.id, targetLinkId: targetLink.id },
            config: {}, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 });
        for (const sourceInstanceId of ['selected', 'other']) {
            const observer = { machineId: 'outside-observer', installationId: 'outside-installation' };
            current.publish({ sourceInstanceId, sourceRevision: '1', checkId: check.checkId, kind: 'http',
                caller: { pluginId: 'happier.machine.services', machineId: observer.machineId, materializationId: 'installed' },
                occurrenceId: 'occurrence', check, environment, targetLink, domain, observer,
                result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'http', 123, 123, 'up', { httpStatus: 200 }) });
        }
        const selected = { sourceInstanceId: 'selected', observerMachineId: 'outside-observer', checks: [check] };
        expect(current.readDomainProofs(environment.id, targetLink.id, [domain.id], selected))
            .toMatchObject([{ sourceInstanceId: 'selected', domainObservation: {
                observerMachineId: 'outside-observer', vantage: 'outside', result: { observedAt: 123 } } }]);
        expect(current.readDomainProofs(environment.id, targetLink.id, [domain.id],
            { ...selected, observerMachineId: 'controller' })).toEqual([]);
        expect(current.readDomainProofs(environment.id, targetLink.id, [domain.id],
            { ...selected, checks: [{ ...check, config: { keyword: 'changed-after-observation' } }] })).toEqual([]);
        current.reconcile(entry => entry.sourceInstanceId !== 'selected');
        expect(current.readDomainProofs(environment.id, targetLink.id, [domain.id], selected)).toEqual([]);
    });
    it('retains certificate and same-Machine facts without promoting them to outside edge health', () => {
        const observer = { machineId: 'controller', installationId: 'installation-controller' };
        const environment = createDeploymentEnvironmentHeaderV1({ controllerMachineId: observer.machineId });
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id, machines: [observer.machineId],
            members: [{ ...observer, state: 'active' }] });
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
            targetLinkId: targetLink.id, revision: 1, state: 'active', contentArtifactId: 'artifact-domain',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account', createdAtMs: 1000, updatedAtMs: 1000 });
        const current = createCurrentDomainEdgeObservation();
        let wakes = 0;
        let domainWakes = 0;
        let edgeWakes = 0;
        current.subscribe(() => wakes++);
        current.subscribe(() => domainWakes++, { environmentId: environment.id,
            targetLinkId: targetLink.id, domainIds: [domain.id] });
        current.subscribe(() => edgeWakes++, { environmentId: environment.id, targetLinkId: targetLink.id });
        const publish = (kind: 'http' | 'certificate', observedAt: number, notAfter = 3000) => {
            const check = HealthCheckDefinitionV1Schema.parse({ checkId: kind,
                kind: { pluginId: 'happier.machine.services', localId: kind },
                binding: { kind: 'domain', domainId: domain.id, targetLinkId: targetLink.id, condition: 'domain_probe_failed' },
                config: {}, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 });
            current.publish({ sourceInstanceId: 'saved', sourceRevision: '1', checkId: kind, kind,
                caller: { pluginId: 'happier.machine.services', machineId: observer.machineId, materializationId: 'installed' },
                occurrenceId: 'occurrence', check, environment, targetLink, domain, observer,
                result: finiteHealthCheckResult({ observer, vantage: 'sameMachine' }, kind, observedAt, observedAt,
                    'up', kind === 'certificate' ? { notBefore: 0, notAfter } : { httpStatus: 200 }) });
        };
        publish('http', 1000);
        publish('certificate', 1000);
        expect(current.readDomainProofs(environment.id, targetLink.id).map(entry => entry.domainObservation))
            .toMatchObject([{ domainId: domain.id, kind: 'http', vantage: 'sameMachine' },
                { domainId: domain.id, kind: 'certificate', vantage: 'sameMachine', result: { status: 'up' } }]);
        expect(current.read(environment.id, targetLink.id)).toBeNull();
        expect(edgeWakes).toBe(0);
        expect(domainWakes).toBe(2);
        const semanticWakes = wakes;
        publish('certificate', 2000);
        expect(wakes).toBe(semanticWakes);
        expect(current.readDomainProofs(environment.id, targetLink.id)[1]?.domainObservation.result.observedAt).toBe(2000);
        publish('certificate', 2000, 4000);
        expect(wakes).toBe(semanticWakes + 1);
        expect(domainWakes).toBe(3);
        expect(edgeWakes).toBe(0);
        current.reconcile(() => false);
        expect(current.readDomainProofs(environment.id, targetLink.id)).toEqual([]);
        expect(domainWakes).toBe(4);
        publish('certificate', 2000, 4000);
        current.withdrawDomain(environment.id, domain.id);
        expect(current.readDomainProofs(environment.id, targetLink.id)).toEqual([]);
        expect(domainWakes).toBe(6);
        expect(edgeWakes).toBe(0);
    });
});
