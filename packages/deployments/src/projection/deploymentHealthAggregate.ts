import type {
    DeploymentEnvironmentHeaderV1, DeploymentEnvironmentHealthAggregateV1,
    DeploymentHealthMemberV1, DeploymentHealthRoleEvidenceV1, DeploymentHealthRoleV1, DeploymentHealthStatusV1,
    DeploymentTargetLinkHeaderV1,
} from '@happier-dev/deployment-protocol/v1';

/**
 * Current, admitted owner facts, after P50's D5/expected-operation admission.
 * P50/P41 retain Domain/controller/network/config and cross-call observation
 * currentness; observedAtMs orders duplicate keys only within this snapshot. This
 * projection performs no probing, scheduling, failure streaks or C1 decisions.
 * A private probe must suppress peer fallback; a public Domain can prove only
 * the edge, never all runtime members behind its balancer.
 */
export type DeploymentHealthObservationV1 = Readonly<{
    environmentId: string;
    targetLinkId: string;
    targetLinkRevision: number;
    machineId: string;
    installationId?: string;
    role: DeploymentHealthRoleV1;
    status: DeploymentHealthStatusV1;
    observedAtMs: number;
    latencyMs?: number;
    reason?: string;
    expectedOperationId?: string;
    source: Readonly<{ kind: 'native' }> | Readonly<{ kind: 'presence' }>
        | Readonly<{ kind: 'privateProbe'; fallbackDisabled: boolean }>
        | Readonly<{ kind: 'domain'; observerMachineId: string }>;
}>;

/**
 * One complete current workload, not a stream of individual service updates.
 * Acquisition enumerates every admitted service, including those without a
 * supported/current observation. A newer snapshot replaces that service set.
 */
export type DeploymentHealthServicesObservationV1 = Readonly<Omit<DeploymentHealthObservationV1,
    'status' | 'latencyMs' | 'reason' | 'source'> & {
    source: Readonly<{ kind: 'native' }>;
    services: readonly Readonly<{
        serviceId: string;
        observation?: Readonly<Pick<DeploymentHealthObservationV1, 'status' | 'observedAtMs' | 'reason' | 'expectedOperationId'> & {
            expectedDown?: 'stop';
        }>;
    }>[];
}>;

type Observation = DeploymentHealthObservationV1 | DeploymentHealthServicesObservationV1;
type Member = Readonly<Pick<DeploymentHealthMemberV1, 'machineId' | 'installationId' | 'roles'>>;
const key = (machineId: string, role: DeploymentHealthRoleV1) => JSON.stringify([machineId, role]);
const rank: Record<DeploymentHealthStatusV1, number> = { up: 0, degraded: 1, unknown: 2, down: 3 };

function sameMember(a: Member, b: Member) {
    return a.machineId === b.machineId && a.installationId === b.installationId
        && a.roles.length === b.roles.length && a.roles.every((role, index) => role === b.roles[index]);
}

function sameEvidence(a: DeploymentHealthRoleEvidenceV1, b: DeploymentHealthRoleEvidenceV1) {
    return a.role === b.role && a.status === b.status && a.source === b.source
        && a.reason === b.reason && a.expectedOperationId === b.expectedOperationId && a.expectedDown === b.expectedDown;
}

function roleEvidence(role: DeploymentHealthRoleV1, observation: Observation | undefined): readonly DeploymentHealthRoleEvidenceV1[] {
    if (!observation) return [{ role, status: 'unknown', source: 'unobserved', reason: 'coverage_unavailable' }];
    if ('services' in observation) {
        let worst: DeploymentHealthServicesObservationV1['services'][number] | undefined;
        let unavailable: typeof worst;
        let expectedStop: typeof worst;
        for (const service of observation.services) {
            if (service.observation?.expectedDown === 'stop') {
                if (!expectedStop || service.serviceId < expectedStop.serviceId) expectedStop = service;
                continue;
            }
            const status = service.observation?.status ?? 'unknown';
            const previousStatus = worst?.observation?.status ?? 'unknown';
            if (!worst || rank[status] > rank[previousStatus]
                || (rank[status] === rank[previousStatus] && service.serviceId < worst.serviceId)) worst = service;
            if (status === 'unknown' && (!unavailable || service.serviceId < unavailable.serviceId)) unavailable = service;
        }
        // Keep unavailable coverage alongside a proved outage. Neither fact
        // changes the other, and both count the same Machine only once.
        const services: Array<typeof worst> = unavailable && worst?.observation?.status === 'down' ? [worst, unavailable] : worst ? [worst] : [];
        if (expectedStop) services.push(expectedStop);
        if (services.length === 0) services.push(undefined);
        return services.map((service): DeploymentHealthRoleEvidenceV1 => {
            const status = service?.observation?.status ?? 'unknown';
            const reason = service?.observation?.reason ?? (status === 'unknown' ? 'coverage_unavailable' : undefined);
            const expectedOperationId = service?.observation?.expectedOperationId ?? observation.expectedOperationId;
            return { role, status, source: 'native',
                ...(service?.observation?.expectedDown ? { expectedDown: service.observation.expectedDown } : {}),
                ...(reason === undefined ? {} : { reason }),
                ...(expectedOperationId === undefined ? {} : { expectedOperationId }) };
        });
    }
    const source = observation.source;
    const provingSource = source.kind === 'native'
        || (role === 'runtime' && source.kind === 'privateProbe' && source.fallbackDisabled)
        || (role === 'edge' && source.kind === 'domain' && source.observerMachineId !== observation.machineId);
    const status = provingSource ? observation.status : 'unknown';
    return [{
        role, status, source: source.kind,
        ...(status === 'unknown' ? { reason: observation.reason ?? 'coverage_unavailable' }
            : observation.reason === undefined ? {} : { reason: observation.reason }),
        ...(observation.expectedOperationId === undefined ? {} : { expectedOperationId: observation.expectedOperationId }),
    }];
}

/**
 * The sole P40 active-runtime-plus-edge reducer. Its caller supplies the current
 * member snapshot from existing owner observations, not an incremental tick
 * history. The previous published fact preserves unchanged identities. Link
 * edits withdraw stale result authority; a changed membership needs matching
 * finite re-observation before it can recover, whereas order/carrier edits
 * preserve the same admitted member facts.
 */
export function projectDeploymentHealthAggregateV1({ environment, targetLink, observations }: Readonly<{
    environment: DeploymentEnvironmentHeaderV1;
    targetLink: DeploymentTargetLinkHeaderV1;
    observations: readonly Observation[];
}>, previous?: DeploymentEnvironmentHealthAggregateV1): DeploymentEnvironmentHealthAggregateV1 {
    if (targetLink.environmentId !== environment.id || targetLink.id !== environment.runtimeTargetLinkId) {
        throw new Error('deployment_health_target_mismatch');
    }
    const selected = new Map<string, Member>();
    for (const member of targetLink.members) {
        if (member.state === 'active') selected.set(member.machineId, {
            machineId: member.machineId, installationId: member.installationId, roles: ['runtime'],
        });
    }
    if (environment.ingress?.kind === 'edgeCaddy') {
        const machineId = environment.ingress.edgeMachineId;
        const runtime = selected.get(machineId);
        selected.set(machineId, runtime ? { ...runtime, roles: ['runtime', 'edge'] } : { machineId, roles: ['edge'] });
    }
    const members = [...selected.values()].sort((a, b) => a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0);
    const prior = previous?.environmentId === environment.id && previous.targetLinkId === targetLink.id ? previous : undefined;
    const priorMembers = new Map(prior?.members.map(member => [member.machineId, member]));
    const sameMembership = prior !== undefined && prior.members.length === members.length
        && members.every((member, index) => sameMember(member, prior.members[index]));
    const current = new Map<string, Readonly<{ observation: Observation; evidence: readonly DeploymentHealthRoleEvidenceV1[] }>>();
    const supplied = new Set<string>();
    for (const observation of observations) {
        const identity = key(observation.machineId, observation.role);
        supplied.add(identity);
        const member = selected.get(observation.machineId);
        if (!member || observation.environmentId !== environment.id || observation.targetLinkId !== targetLink.id
            || observation.targetLinkRevision !== targetLink.revision || !member.roles.includes(observation.role)
            || (member.installationId !== undefined && observation.installationId !== member.installationId)) continue;
        const incumbent = current.get(identity);
        const services = 'services' in observation;
        const incumbentServices = incumbent !== undefined && 'services' in incumbent.observation;
        // A singleton probe/service cannot establish health for a declared
        // complete workload. Compare timestamps only within the same coverage.
        if (incumbentServices && !services) continue;
        const evidence = roleEvidence(observation.role, observation);
        if (!incumbent || (services && !incumbentServices) || observation.observedAtMs > incumbent.observation.observedAtMs
            || (observation.observedAtMs === incumbent.observation.observedAtMs && rank[evidence[0].status] > rank[incumbent.evidence[0].status])) {
            current.set(identity, { observation, evidence });
        }
    }
    const rows = members.map((member, index): DeploymentHealthMemberV1 => {
        const candidate = sameMembership ? prior?.members[index] : priorMembers.get(member.machineId);
        const old = candidate && sameMember(member, candidate) ? candidate : undefined;
        const evidence = member.roles.flatMap(role => {
            const identity = key(member.machineId, role);
            const observation = current.get(identity);
            // Wrong-link/revision/installation results cannot replace proof.
            // A changed membership cannot borrow that proof to recover either.
            const previousEvidence = old?.evidence.filter(item => item.role === role);
            const retained = sameMembership && !observation && supplied.has(identity) ? previousEvidence : undefined;
            const value = retained ?? observation?.evidence ?? roleEvidence(role, undefined);
            return value.map((item, index) => previousEvidence?.[index] && sameEvidence(previousEvidence[index], item)
                ? previousEvidence[index] : item);
        });
        const status = evidence.reduce<DeploymentHealthStatusV1>((value, item) => rank[item.status] > rank[value] ? item.status : value, 'up');
        if (old && sameMember(member, old) && old.status === status
            && evidence.length === old.evidence.length && evidence.every((value, i) => value === old.evidence[i])) return old;
        return { ...member, status, evidence };
    });
    const production = environment.protection === 'production';
    const down = rows.filter(member => member.evidence.some(value => value.expectedDown !== 'stop' && (value.status === 'down'
        || (production && value.status === 'unknown')))).length;
    const degraded = rows.filter(member => member.status === 'degraded').length;
    const unknown = rows.filter(member => member.evidence.some(value => value.expectedDown !== 'stop' && value.status === 'unknown')).length;
    const edge = rows.flatMap(member => member.evidence.filter(value => value.role === 'edge'));
    const edgeUnreachable = edge.some(value => value.expectedDown !== 'stop' && value.status === 'down');
    const edgeUnavailable = edgeUnreachable || (production && edge.some(value => value.expectedDown !== 'stop' && value.status === 'unknown'));
    const expectedStop = rows.some(member => member.evidence.some(value => value.expectedDown === 'stop'));
    const n = rows.length;
    const status: DeploymentHealthStatusV1 = n === 0 ? 'unknown'
        : edgeUnavailable || down === n ? 'down'
            : down > 0 || degraded > 0 || expectedStop ? 'degraded' : unknown > 0 ? 'unknown' : 'up';
    if (prior && prior.protection === environment.protection && prior.status === status
        && rows.length === prior.members.length && rows.every((member, index) => member === prior.members[index])) return prior;
    return {
        v: 1, environmentId: environment.id, targetLinkId: targetLink.id, protection: environment.protection,
        status, n, down, degraded, unknown, members: rows,
        ...(expectedStop ? { expectedDown: 'stop' } : {}),
        affectedMachineIds: rows.filter(member => member.status !== 'up').map(member => member.machineId),
        edgeUnreachable, authoritativeRecovery: status === 'up',
    };
}
