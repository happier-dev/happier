import { describe, expect, it, vi } from 'vitest';
import { DeploymentEnvironmentDetailV1Schema, DeploymentEnvironmentHealthAggregateV1Schema } from '@happier-dev/deployment-protocol/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { projectDeploymentHealthAggregateV1, type DeploymentHealthObservationV1 } from './deploymentHealthAggregate.js';
import { createDeploymentProjectionV1 } from './deploymentStore.js';
import { createDeploymentReadControllerV1 } from '../controller/createDeploymentReadControllerV1.js';
import type { DeploymentReadTransportV1 } from '../controller/deploymentReadControllerTypes.js';
import * as packageOwner from '../index.js';

const environment = createDeploymentEnvironmentHeaderV1({ protection: 'production' });
const targetLink = createDeploymentTargetLinkHeaderV1({
    machines: ['a', 'b', 'joining'],
    members: [{ machineId: 'a', installationId: 'installation-a', state: 'active' },
        { machineId: 'b', installationId: 'installation-b', state: 'active' },
        { machineId: 'joining', installationId: 'installation-joining', state: 'joining' }],
});
function observation(machineId: string, overrides: Partial<DeploymentHealthObservationV1> = {}): DeploymentHealthObservationV1 {
    return { environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
        machineId, installationId: `installation-${machineId}`, role: 'runtime', status: 'up', observedAtMs: 1000,
        source: { kind: 'privateProbe', fallbackDisabled: true }, ...overrides };
}
const healthy = [observation('a'), observation('b')];

describe('Environment health aggregate', () => {
    it('retains actual stopped health without opening an outage or proving recovery for a native desired Stop', () => {
        const stopped = { environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            machineId: 'b', installationId: 'installation-b', role: 'runtime' as const, observedAtMs: 2000,
            source: { kind: 'native' as const }, services: [{ serviceId: 'worker', observation: {
                status: 'down' as const, observedAtMs: 2000, expectedDown: 'stop' as const,
            } }] };
        const aggregate = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0], stopped] });
        expect(aggregate).toMatchObject({ status: 'degraded', down: 0, unknown: 0, authoritativeRecovery: false });
        expect(aggregate.members[1]).toMatchObject({ status: 'down', evidence: [{ status: 'down', expectedDown: 'stop' }] });
        expect(DeploymentEnvironmentHealthAggregateV1Schema.parse(aggregate)).toEqual(aggregate);
        const neighborFails = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0], {
            ...stopped, services: [...stopped.services, { serviceId: 'web', observation: { status: 'down' as const, observedAtMs: 2000 } }],
        }] });
        expect(neighborFails).toMatchObject({ down: 1, authoritativeRecovery: false });
        expect(projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0], {
            ...stopped, services: [{ serviceId: 'worker', observation: { status: 'down' as const, observedAtMs: 2000 } }],
        }] })).toMatchObject({ down: 1, authoritativeRecovery: false });
    });

    it.each(['down', 'unknown'] as const)('counts factual %s evidence independently of its diagnostic reason', status => {
        const member = { environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            machineId: 'b', installationId: 'installation-b', role: 'runtime' as const, observedAtMs: 2000,
            source: { kind: 'native' as const }, services: [{ serviceId: 'worker', observation: {
                status, observedAtMs: 2000, reason: 'expected_stop',
            } }] };
        const aggregate = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0], member] });
        expect(aggregate).toMatchObject({ status: 'degraded', down: 1, unknown: status === 'unknown' ? 1 : 0,
            authoritativeRecovery: false, affectedMachineIds: ['b'] });
        expect(aggregate.members[1].evidence).toEqual([{ role: 'runtime', status, source: 'native', reason: 'expected_stop' }]);
        expect(DeploymentEnvironmentHealthAggregateV1Schema.parse(aggregate)).toEqual(aggregate);
    });

    it('keeps an unhealthy service visible beside a newer healthy sibling through the live read carrier', async () => {
        const services = [
            { serviceId: 'worker', observation: { status: 'down' as const, observedAtMs: 1000, reason: 'not_ready' } },
            { serviceId: 'web', observation: { status: 'up' as const, observedAtMs: 2000 } },
        ];
        const member = { environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            machineId: 'b', installationId: 'installation-b', role: 'runtime' as const, observedAtMs: 2000,
            source: { kind: 'native' as const }, services };
        const retirement = new AbortController();
        const health = packageOwner.createDeploymentHealthAggregateLeaseV1({
            initial: { environment, targetLink, observations: [healthy[0], member] },
            isCurrent: () => true, retirementSignal: retirement.signal,
        });
        const detail = () => DeploymentEnvironmentDetailV1Schema.parse(createDeploymentEnvironmentDetailV1({ environment,
            targetLinks: [{ targetLink, content: {} }], healthAggregate: health.snapshot() }));
        const transport = {
            readEnvironment: async () => ({ ok: true as const, value: detail() }),
            listEnvironments: async () => { throw new Error('unexpected_collection_read'); },
            listHistory: async () => { throw new Error('unexpected_history_read'); },
            readReceipt: async () => { throw new Error('unexpected_receipt_read'); },
        } satisfies DeploymentReadTransportV1;
        const controller = createDeploymentReadControllerV1({ scope: {
            serverId: environment.serverId, projectSourceId: environment.projectSourceId, accountId: 'account-owner',
        }, transport });
        const read = controller.acquireEnvironment(environment.id, { mounted: true, visible: true, focused: true });
        const published = vi.fn();
        health.observe(published);
        try {
            expect(health.snapshot()).toMatchObject({ n: 2, down: 1, affectedMachineIds: ['b'], authoritativeRecovery: false });
            expect(health.snapshot().members[1].evidence).toEqual([
                { role: 'runtime', status: 'down', source: 'native', reason: 'not_ready' },
            ]);
            await read.refresh();
            expect(read.getSnapshot().value?.healthAggregate).toEqual(health.snapshot());
            const first = health.snapshot();
            for (let refresh = 0; refresh < 8; refresh += 1) {
                health.adopt({ environment, targetLink, observations: [healthy[0], { ...member, observedAtMs: 3000 + refresh,
                    services: [...services].reverse().map(service => ({ ...service,
                        observation: { ...service.observation, observedAtMs: 3000 + refresh } })) }] });
            }
            expect(health.snapshot()).toBe(first);
            expect(published).toHaveBeenCalledTimes(1);
            health.adopt({ environment, targetLink, observations: [healthy[0], { ...member, observedAtMs: 4000,
                services: services.map(service => ({ serviceId: service.serviceId,
                    observation: { status: 'up', observedAtMs: 4000 } })) }] });
            expect(health.snapshot()).toMatchObject({ status: 'up', authoritativeRecovery: true });
            expect(health.snapshot().members[0]).toBe(first.members[0]);
            expect(published).toHaveBeenCalledTimes(2);
            await read.refresh();
            expect(read.getSnapshot().value?.healthAggregate?.authoritativeRecovery).toBe(true);
        } finally { read.release(); controller.retire(); health.dispose(); }
    });

    it('withdraws healthy coverage for unobserved services without dropping Machines or accepting singleton recovery', () => {
        const service = { environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            machineId: 'b', installationId: 'installation-b', role: 'runtime' as const, observedAtMs: 2000,
            source: { kind: 'native' as const }, services: [
                { serviceId: 'web', observation: { status: 'up' as const, observedAtMs: 2000 } },
                { serviceId: 'worker' },
            ] };
        const previous = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: healthy });
        for (const services of [service.services, [], [{ serviceId: 'worker',
            observation: { status: 'unknown' as const, observedAtMs: 3000 } }]]) {
            const current = projectDeploymentHealthAggregateV1({ environment, targetLink,
                observations: [healthy[0], { ...service, services }, observation('b', { observedAtMs: 4000 })] }, previous);
            expect(current).toMatchObject({ n: 2, down: 1, unknown: 1, authoritativeRecovery: false });
            expect(current.members[1]).toMatchObject({ machineId: 'b', status: 'unknown',
                evidence: [{ role: 'runtime', status: 'unknown', reason: 'coverage_unavailable' }] });
            const nonProduction = projectDeploymentHealthAggregateV1({
                environment: { ...environment, protection: 'nonProduction' }, targetLink,
                observations: [healthy[0], { ...service, services }],
            });
            expect(nonProduction).toMatchObject({ n: 2, down: 0, unknown: 1, status: 'unknown', authoritativeRecovery: false });
        }
        const failed = { ...service, services: [{ serviceId: 'worker',
            observation: { status: 'down' as const, observedAtMs: 2000 } }] };
        const incompleteFailure = projectDeploymentHealthAggregateV1({ environment, targetLink,
            observations: [healthy[0], { ...failed, services: [...failed.services, { serviceId: 'unobserved' }] }] });
        expect(incompleteFailure).toMatchObject({ n: 2, down: 1, unknown: 1, authoritativeRecovery: false });
        expect(incompleteFailure.members[1]).toMatchObject({ status: 'down', evidence: [
            { role: 'runtime', status: 'down', source: 'native' },
            { role: 'runtime', status: 'unknown', source: 'native', reason: 'coverage_unavailable' },
        ] });
        for (const observations of [[failed, observation('b', { observedAtMs: 4000 })],
            [observation('b', { observedAtMs: 4000 }), failed]]) {
            const current = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0], ...observations] });
            expect(current.members[1].status).toBe('down');
            expect(current.authoritativeRecovery).toBe(false);
        }
        const retiredService = projectDeploymentHealthAggregateV1({ environment, targetLink,
            observations: [healthy[0], { ...service, observedAtMs: 5000, services: [service.services[0]] }] }, incompleteFailure);
        expect(retiredService).toMatchObject({ status: 'up', authoritativeRecovery: true });
        const missingMember = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0]] }, previous);
        expect(missingMember).toMatchObject({ n: 2, down: 1, unknown: 1, authoritativeRecovery: false });
        expect(missingMember.members[1].evidence).toMatchObject([{ status: 'unknown', reason: 'coverage_unavailable' }]);
        const stale = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [healthy[0],
            { ...service, targetLinkRevision: targetLink.revision + 1 }, { ...service, installationId: 'old-installation' }] }, previous);
        expect(stale).toBe(previous);
    });

    it('publishes admitted changes through one live lease and withdraws its authority on retirement', () => {
        expect(packageOwner).toHaveProperty('createDeploymentHealthAggregateLeaseV1');
        const retirement = new AbortController();
        const lease = packageOwner.createDeploymentHealthAggregateLeaseV1({
            initial: { environment, targetLink, observations: healthy },
            isCurrent: () => !retirement.signal.aborted, retirementSignal: retirement.signal,
        });
        const changes: ReturnType<typeof projectDeploymentHealthAggregateV1>[] = [];
        const observation = lease.observe(value => changes.push(value));
        const first = lease.snapshot();
        expect(changes).toEqual([first]);
        for (let refresh = 0; refresh < 8; refresh += 1) {
            lease.adopt({ environment: structuredClone(environment), targetLink: structuredClone(targetLink),
                observations: healthy.map(value => ({ ...value, observedAtMs: 2000 + refresh, latencyMs: refresh })) });
        }
        expect(lease.snapshot()).toBe(first);
        expect(changes).toEqual([first]);
        const input = { environment, targetLink, observations: [healthy[0], { ...healthy[1], status: 'unknown' as const, reason: 'machine_unavailable' }] };
        lease.adopt(input);
        expect(changes).toHaveLength(2);
        expect(lease.snapshot()).toMatchObject({ down: 1, unknown: 1, authoritativeRecovery: false });
        expect(lease.snapshot().members[0]).toBe(first.members[0]);
        retirement.abort();
        lease.adopt({ environment, targetLink, observations: healthy });
        expect(lease.isCurrent()).toBe(false);
        expect(lease.retirementSignal.aborted).toBe(true);
        expect(changes).toHaveLength(2);
        observation.dispose(); lease.dispose();
    });

    it('keeps one scoped live authority and never revives a withdrawn lease', () => {
        const retirement = new AbortController();
        let current = true;
        const initial = { environment, targetLink, observations: healthy };
        const lease = packageOwner.createDeploymentHealthAggregateLeaseV1({ initial,
            isCurrent: () => current, retirementSignal: retirement.signal });
        const published = vi.fn();
        lease.observe(published);
        const first = lease.snapshot();
        expect(() => lease.adopt({ ...initial, environment: { ...environment, id: 'foreign' } }))
            .toThrow('deployment_health_scope_mismatch');
        expect(lease.snapshot()).toBe(first);
        current = false;
        expect(lease.isCurrent()).toBe(false);
        current = true;
        lease.adopt({ ...initial, observations: [healthy[0], { ...healthy[1], status: 'down' }] });
        expect(lease.retirementSignal.aborted).toBe(true);
        expect(lease.isCurrent()).toBe(false);
        expect(lease.snapshot()).toBe(first);
        expect(published).toHaveBeenCalledTimes(1);
        lease.observe(published);
        expect(published).toHaveBeenCalledTimes(1);
        lease.dispose();
    });

    it('adopts the supplied producer fact in the real keyed Environment lease and keeps equal reads quiet', async () => {
        const retirement = new AbortController();
        const health = packageOwner.createDeploymentHealthAggregateLeaseV1({
            initial: { environment, targetLink, observations: healthy },
            isCurrent: () => !retirement.signal.aborted, retirementSignal: retirement.signal,
        });
        const healthAggregate = health.snapshot();
        const detail = () => createDeploymentEnvironmentDetailV1({ environment,
            targetLinks: [{ targetLink, content: {} }], healthAggregate: health.snapshot() });
        let reads = 0;
        const transport = {
            readEnvironment: async () => { reads += 1; return { ok: true as const, value: detail() }; },
            listEnvironments: async () => { throw new Error('unexpected_collection_read'); },
            listHistory: async () => { throw new Error('unexpected_history_read'); },
            readReceipt: async () => { throw new Error('unexpected_receipt_read'); },
        } satisfies DeploymentReadTransportV1;
        const controller = createDeploymentReadControllerV1({ scope: {
            serverId: environment.serverId, projectSourceId: environment.projectSourceId, accountId: 'account-owner',
        }, transport });
        const lease = controller.acquireEnvironment(environment.id, { mounted: true, visible: true, focused: true });
        await lease.refresh();
        const first = lease.getSnapshot();
        expect(first.value?.healthAggregate).toEqual(healthAggregate);
        const published = vi.fn();
        lease.subscribe(published);
        for (let refresh = 0; refresh < 8; refresh += 1) {
            health.adopt({ environment, targetLink,
                observations: healthy.map(value => ({ ...value, observedAtMs: 2000 + refresh })) });
            await lease.refresh();
        }
        expect(lease.getSnapshot()).toBe(first);
        expect(published).not.toHaveBeenCalled();
        reads = 0;
        for (let push = 0; push < 8; push += 1) controller.invalidate({ environmentId: `unrelated-${push}` });
        await Promise.resolve();
        expect(reads).toBe(0);
        health.adopt({ environment, targetLink,
            observations: [observation('a'), observation('b', { status: 'down' })] });
        controller.invalidate({ environmentId: environment.id });
        await lease.refresh();
        expect(reads).toBe(1);
        expect(lease.getSnapshot().value?.healthAggregate?.down).toBe(1);
        expect(health.snapshot().members[0]).toBe(healthAggregate.members[0]);
        expect(published).toHaveBeenCalledTimes(1);
        lease.release(); controller.retire(); health.dispose();
    });

    it('rejects a supplied aggregate for another Environment, selected link, or protection basis', async () => {
        const healthAggregate = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: healthy });
        for (const patch of [{ environmentId: 'foreign' }, { targetLinkId: 'foreign' }, { protection: 'nonProduction' as const }]) {
            const detail = createDeploymentEnvironmentDetailV1({ environment,
                targetLinks: [{ targetLink, content: {} }], healthAggregate: { ...healthAggregate, ...patch } });
            const transport = {
                readEnvironment: async () => ({ ok: true as const, value: detail }),
                listEnvironments: async () => { throw new Error('unexpected_collection_read'); },
                listHistory: async () => { throw new Error('unexpected_history_read'); },
                readReceipt: async () => { throw new Error('unexpected_receipt_read'); },
            } satisfies DeploymentReadTransportV1;
            const controller = createDeploymentReadControllerV1({ scope: {
                serverId: environment.serverId, projectSourceId: environment.projectSourceId, accountId: 'account-owner',
            }, transport });
            const lease = controller.acquireEnvironment(environment.id, { mounted: true, visible: true, focused: true });
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'unavailable', value: null,
                failure: { code: 'invalid_response', retryable: false } });
            lease.release(); controller.retire();
        }
    });

    it('admits the supplied aggregate through the canonical Environment detail read', () => {
        const healthAggregate = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: healthy });
        expect(DeploymentEnvironmentDetailV1Schema.parse({ ...createDeploymentEnvironmentDetailV1(), healthAggregate }).healthAggregate)
            .toEqual(healthAggregate);
        expect(() => DeploymentEnvironmentHealthAggregateV1Schema.parse({ ...healthAggregate, nativePayload: {} })).toThrow();
    });

    it('counts active Machines once, excludes joining, and retains Production unknown reasons', () => {
        const result = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [
            observation('a'), observation('b', { status: 'unknown', reason: 'machine_unavailable' }),
            observation('joining', { status: 'down' }), observation('controller', { status: 'down' }),
        ] });
        expect(result).toMatchObject({ status: 'degraded', n: 2, down: 1, unknown: 1, degraded: 0,
            affectedMachineIds: ['b'], authoritativeRecovery: false });
        expect(result.members[1]).toMatchObject({ machineId: 'b', status: 'unknown',
            evidence: [{ role: 'runtime', status: 'unknown', reason: 'machine_unavailable' }] });
        const allUnknown = projectDeploymentHealthAggregateV1({ environment, targetLink, observations: [] });
        expect(allUnknown).toMatchObject({ status: 'down', n: 2, down: 2, unknown: 2 });
        const nonProduction = projectDeploymentHealthAggregateV1({
            environment: { ...environment, protection: 'nonProduction' }, targetLink,
            observations: [observation('a'), observation('b', { status: 'unknown', reason: 'coverage_unavailable' })],
        });
        expect(nonProduction).toMatchObject({ status: 'unknown', down: 0, unknown: 1, authoritativeRecovery: false });
    });

    it('includes an edge-only outage and deduplicates a Machine sharing runtime and edge roles', () => {
        const edgeEnvironment = { ...environment, ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' } };
        const result = projectDeploymentHealthAggregateV1({ environment: edgeEnvironment, targetLink, observations: [
            ...healthy, observation('edge', { role: 'edge', status: 'down', reason: 'connect_failed',
                source: { kind: 'domain', observerMachineId: 'controller' } }),
        ] });
        expect(result).toMatchObject({ n: 3, down: 1, status: 'down', edgeUnreachable: true, affectedMachineIds: ['edge'] });
        const shared = projectDeploymentHealthAggregateV1({
            environment: { ...environment, ingress: { kind: 'edgeCaddy', edgeMachineId: 'a' } }, targetLink,
            observations: [...healthy, observation('a', { role: 'edge', status: 'down',
                source: { kind: 'domain', observerMachineId: 'controller' } })],
        });
        expect(shared).toMatchObject({ n: 2, down: 1, status: 'down', edgeUnreachable: true });
        expect(shared.members[0]).toMatchObject({ machineId: 'a', roles: ['runtime', 'edge'] });
    });

    it('requires exact marked member probes and outside edge coverage for recovery', () => {
        const edgeEnvironment = { ...environment, ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' } };
        const unproved = projectDeploymentHealthAggregateV1({ environment: edgeEnvironment, targetLink, observations: [
            observation('a', { source: { kind: 'privateProbe', fallbackDisabled: false } }),
            observation('b', { source: { kind: 'presence' } }),
            observation('edge', { role: 'edge', source: { kind: 'domain', observerMachineId: 'edge' } }),
        ] });
        expect(unproved).toMatchObject({ down: 3, unknown: 3, authoritativeRecovery: false });
        const partlyRecovered = projectDeploymentHealthAggregateV1({ environment: edgeEnvironment, targetLink,
            observations: [...healthy, observation('edge', { role: 'edge', status: 'unknown', reason: 'connect_failed',
                source: { kind: 'domain', observerMachineId: 'controller' } })] }, unproved);
        expect(partlyRecovered).toMatchObject({ down: 1, unknown: 1, status: 'down', authoritativeRecovery: false });
        const recovered = projectDeploymentHealthAggregateV1({ environment: edgeEnvironment, targetLink,
            observations: [...healthy, observation('edge', { role: 'edge',
                source: { kind: 'domain', observerMachineId: 'controller' } })] }, partlyRecovered);
        expect(recovered).toMatchObject({ status: 'up', down: 0, authoritativeRecovery: true });
    });

    it('withdraws removed-member authority and requires current remaining-member proof after a membership edit', () => {
        const failed = projectDeploymentHealthAggregateV1({ environment, targetLink,
            observations: [observation('a'), observation('b', { status: 'down' })] });
        const remaining = { ...targetLink, revision: 2, machines: ['a'], members: [targetLink.members[0]] };
        const rebased = projectDeploymentHealthAggregateV1({ environment, targetLink: remaining, observations: healthy }, failed);
        expect(rebased).toMatchObject({ n: 1, down: 1, unknown: 1, authoritativeRecovery: false });
        expect(rebased.members.map(member => member.machineId)).toEqual(['a']);
        const stale = projectDeploymentHealthAggregateV1({ environment, targetLink: remaining, observations: [
            ...healthy, observation('b', { targetLinkRevision: 2, status: 'up' }),
            observation('a', { targetLinkRevision: 2, installationId: 'old-installation' }),
        ] }, rebased);
        expect(stale).toBe(rebased);
        const recovered = projectDeploymentHealthAggregateV1({ environment, targetLink: remaining,
            observations: [observation('a', { targetLinkRevision: 2 })] }, rebased);
        expect(recovered).toMatchObject({ n: 1, status: 'up', authoritativeRecovery: true });
    });

    it('ignores stale and foreign facts, and never recovers B from another member or a receipt pointer', () => {
        const failed = projectDeploymentHealthAggregateV1({ environment, targetLink,
            observations: [observation('a'), observation('b', { status: 'down', observedAtMs: 2000 })] });
        const unchanged = projectDeploymentHealthAggregateV1({ environment, targetLink: { ...targetLink, activeDeploymentId: 'next-receipt' }, observations: [
            observation('a', { observedAtMs: 3000 }), observation('b', { status: 'down', observedAtMs: 2000 }),
            observation('b', { observedAtMs: 1000 }), observation('b', { environmentId: 'foreign', observedAtMs: 4000 }),
            observation('b', { targetLinkRevision: 0, observedAtMs: 4000 }),
        ] }, failed);
        expect(unchanged).toBe(failed);
    });

    it('publishes no equal/reordered/freshness-only facts and preserves unchanged Machine identities at scale', () => {
        const members = Array.from({ length: 128 }, (_, i) => ({ machineId: `m${i}`, installationId: `installation-m${i}`, state: 'active' as const }));
        const largeLink = { ...targetLink, machines: members.map(member => member.machineId), members };
        const observations = members.map(member => observation(member.machineId));
        const first = projectDeploymentHealthAggregateV1({ environment, targetLink: largeLink, observations });
        const projection = createDeploymentProjectionV1();
        projection.publish({ status: 'ready', value: first, failure: null });
        const publication = vi.fn();
        projection.subscribe(publication);
        const equal = projectDeploymentHealthAggregateV1({ environment, targetLink: { ...largeLink, revision: 2,
            machines: [...largeLink.machines].reverse(), members: [...members].reverse() },
            observations: [...observations].reverse().map(value => ({ ...value, observedAtMs: 2000, latencyMs: 4 })) }, first);
        projection.publish({ status: 'ready', value: equal, failure: null });
        expect(equal).toBe(first);
        expect(publication).toHaveBeenCalledTimes(0);
        const changed = projectDeploymentHealthAggregateV1({ environment, targetLink: largeLink,
            observations: observations.map(value => value.machineId === 'm99'
                ? { ...value, status: 'down' as const, expectedOperationId: 'rollout' } : value) }, equal);
        projection.publish({ status: 'ready', value: changed, failure: null });
        expect(publication).toHaveBeenCalledTimes(1);
        expect(changed.members.filter((member, i) => member !== first.members[i])).toHaveLength(1);
        expect(changed.members.find(member => member.machineId === 'm99')?.evidence[0].expectedOperationId).toBe('rollout');
    });

    it('leaves an empty or foreign runtime scope explicitly unknown', () => {
        const joiningOnly = { ...targetLink, machines: ['joining'], members: [targetLink.members[2]] };
        expect(projectDeploymentHealthAggregateV1({ environment, targetLink: joiningOnly, observations: [] }))
            .toMatchObject({ n: 0, status: 'unknown', authoritativeRecovery: false });
        expect(() => projectDeploymentHealthAggregateV1({ environment,
            targetLink: { ...targetLink, environmentId: 'foreign' }, observations: healthy })).toThrow('deployment_health_target_mismatch');
    });
});
