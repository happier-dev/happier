import { projectDeploymentHealthAggregateV1, type DeploymentReadTransportV1,
    type DeploymentEnvironmentHealthMemberV1, type DeploymentHealthServicesObservationV1,
    type DeploymentReadScopeV1, type DeploymentReadOptionsV1, type DeploymentReadResultV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentHealthCurrentResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createMachineServiceResourceBinding } from '@/components/machines/resources/useMachineServiceResource';
import { machineServicesListProjection } from '@/components/machines/services/machineServicesListProjection';

type CurrentEdge = ReturnType<typeof DeploymentHealthCurrentResultV1Schema.parse>;
const currentEdgeProjection = Object.freeze({
    decode(content: Readonly<{ bytes: Uint8Array }>, previous: CurrentEdge | undefined): CurrentEdge {
        const next = DeploymentHealthCurrentResultV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
        return previous && sameStrictJsonValue(previous, next) ? previous : next;
    },
});

/** Domain metadata remains usable while this separate demanded controller read is pending. */
export function domainHealthObserver(lifetime: ServerAccountScopeLifetime,
    readMetadata: (scope: DeploymentReadScopeV1, environmentId: string, options: DeploymentReadOptionsV1) => Promise<DeploymentReadResultV1<Readonly<{
        environment: DeploymentEnvironmentHeaderV1; targetLinks: readonly DeploymentTargetLinkHeaderV1[];
    }>>>): NonNullable<DeploymentReadTransportV1['observeDomainHealth']> {
    return (scope, environmentId, initialItems, publish, options) => {
        if (options.signal.aborted || initialItems.length === 0) return () => {};
        let items = initialItems;
        let closed = false;
        const subscriptions: (() => void)[] = [];
        const unavailable = (reason: string) => {
            if (closed) return;
            items = items.map(item => ({ ...item, healthUnavailableReason: reason }));
            publish(items);
        };
        const close = () => {
            if (closed) return;
            closed = true;
            options.signal.removeEventListener('abort', close);
            for (const unsubscribe of subscriptions) unsubscribe();
        };
        options.signal.addEventListener('abort', close, { once: true });
        void readMetadata(scope, environmentId, options).then(result => {
            if (closed) return;
            if (!result.ok) { unavailable(result.failure.code); return; }
            const { environment, targetLinks } = result.value;
            if (!environment.controllerMachineId) { unavailable('machine_unavailable'); return; }
            for (const targetLinkId of new Set(items.map(item => item.domain.targetLinkId))) {
                const selected = items.filter(item => item.domain.targetLinkId === targetLinkId);
                const domainIds = selected.map(item => item.domain.id);
                const link = targetLinks.find(link => link.id === targetLinkId);
                if (!link || link.targetKind !== 'ownServer' || environment.runtimeTargetLinkId !== link.id) {
                    items = items.map(item => domainIds.includes(item.domain.id)
                        ? { ...item, health: undefined, healthUnavailableReason: 'coverage_unavailable' } : item);
                    publish(items);
                    continue;
                }
                const owner = createMachineServiceResourceBinding({ accountLifetime: lifetime, reference: {
                    hostRead: 'deployments.health.edge', input: { serverId: lifetime.scope.serverId,
                        machineId: environment.controllerMachineId, environmentId, targetLinkId, domainIds },
                }, projection: currentEdgeProjection });
                const update = () => {
                    if (closed) return;
                    const snapshot = owner.selection.getSnapshot();
                    const value = snapshot.value;
                    const reason = snapshot.error?.code ?? (value && !value.ok ? value.error : null);
                    if (!reason && !value) return;
                    const valid = value?.ok && value.environmentId === environmentId && value.targetLinkId === targetLinkId;
                    items = items.map(item => {
                        if (!domainIds.includes(item.domain.id)) return item;
                        if (reason) return { ...item, healthUnavailableReason: reason };
                        const row = valid ? value.domainHealth?.find(row => row.domainId === item.domain.id
                            && row.domainRevision === item.domain.revision) : undefined;
                        return { ...item, health: row?.facts,
                            healthUnavailableReason: row ? row.facts.unavailableReason ?? undefined : 'coverage_unavailable' };
                    });
                    publish(items);
                };
                subscriptions.push(owner.selection.subscribe(update, true));
                update();
            }
        }).catch(() => unavailable('deployment_read_failed'));
        if (options.signal.aborted) close();
        return close;
    };
}

/** Borrow the existing selected Services Resource; this never probes or samples health. */
export function environmentHealthObserver(lifetime: ServerAccountScopeLifetime): NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']> {
    return (_scope, detail, publish, options) => {
        if (options.signal.aborted) return () => {};
        const link = detail.runtimeTargetLink;
        if (!link || link.targetKind !== 'ownServer') {
            publish({ environmentId: detail.environment.id, status: 'unavailable', members: [] });
            return () => {};
        }
        const bindings = link.members.filter(member => member.state === 'active').map(member => ({ member,
            owner: createMachineServiceResourceBinding({ accountLifetime: lifetime, reference: {
                hostRead: 'machines.services.list', input: { serverId: lifetime.scope.serverId,
                    machineId: member.machineId, environmentId: detail.environment.id },
            }, projection: machineServicesListProjection }),
        }));
        const edge = detail.environment.ingress?.kind === 'edgeCaddy' && detail.environment.controllerMachineId
            ? createMachineServiceResourceBinding({ accountLifetime: lifetime, reference: {
                hostRead: 'deployments.health.edge', input: { serverId: lifetime.scope.serverId,
                    machineId: detail.environment.controllerMachineId, environmentId: detail.environment.id, targetLinkId: link.id },
            }, projection: currentEdgeProjection }) : null;
        let aggregate: ReturnType<typeof projectDeploymentHealthAggregateV1> | undefined;
        let closed = false;
        const update = () => {
            if (closed) return;
            const members = bindings.map(({ member, owner }): DeploymentEnvironmentHealthMemberV1 => {
                const snapshot = owner.selection.getSnapshot();
                const value = snapshot.value;
                const rows = value?.kind === 'snapshot' ? value.services : [];
                // The Resource reaches the current Machine; the Environment may
                // still name its predecessor installation. Consume the native witness.
                const services = rows.flatMap(row => row.deployment?.installationId !== member.installationId ? [] : [{ serviceId: row.serviceId,
                    name: row.name, state: row.health?.status ?? 'unknown', observedAt: row.health?.observedAtMs ?? null,
                    reason: row.health?.reason ?? (row.health ? null : 'coverage_unavailable'),
                    ...(row.health?.expectedDown ? { expectedDown: row.health.expectedDown } : {}),
                }]);
                const failure = snapshot.error ? { code: snapshot.error.code ?? 'deployment_read_failed', retryable: snapshot.error.retryable ?? false }
                    : value?.kind === 'unavailable' ? { code: value.reason, retryable: false }
                    : services.length !== rows.length ? { code: 'target_mismatch', retryable: false } : undefined;
                return { machineId: member.machineId, installationId: member.installationId, services,
                    status: failure ? 'unavailable' : value?.kind === 'snapshot' ? 'ready' : 'loading',
                    ...(failure ? { failure } : {}),
                };
            });
            const status = members.length === 0 ? 'unavailable' : members.every(member => member.status === 'ready') ? 'ready'
                : members.some(member => member.status === 'loading') ? 'loading'
                : members.some(member => member.status === 'ready') ? 'partial' : 'unavailable';
            const native: DeploymentHealthServicesObservationV1[] = bindings.flatMap(({ member, owner }, index) => {
                const snapshot = owner.selection.getSnapshot();
                if (snapshot.freshness !== 'fresh' || snapshot.error || members[index].status !== 'ready') return [];
                return [{ environmentId: detail.environment.id, targetLinkId: link.id, targetLinkRevision: link.revision,
                    machineId: member.machineId, installationId: member.installationId, role: 'runtime',
                    source: { kind: 'native' }, observedAtMs: members[index].services.reduce(
                        (latest, service) => Math.max(latest, service.observedAt ?? 0), 0),
                    services: members[index].services.map(service => ({ serviceId: service.serviceId,
                        ...(service.observedAt === null ? {} : { observation: { status: service.state, observedAtMs: service.observedAt,
                            ...(service.reason === null ? {} : { reason: service.reason }),
                            ...(service.expectedDown ? { expectedDown: service.expectedDown } : {}),
                        } }),
                    })),
                }];
            });
            const currentEdge = edge?.selection.getSnapshot();
            const observation = currentEdge?.freshness === 'fresh' && !currentEdge.error && currentEdge.value?.ok
                ? currentEdge.value.observation : null;
            aggregate = projectDeploymentHealthAggregateV1({ environment: detail.environment, targetLink: link,
                observations: observation ? [...native, observation] : native }, aggregate);
            const edgeReady = currentEdge?.freshness === 'fresh' && !currentEdge.error && currentEdge.value?.ok;
            const feedStatus = !edge ? status : edgeReady ? (status === 'unavailable' && members.length === 0 ? 'ready' : status)
                : status === 'ready' ? 'partial' : currentEdge?.error ? 'unavailable' : 'loading';
            publish({ environmentId: detail.environment.id, status: feedStatus, members, aggregate });
        };
        const subscriptions = bindings.map(({ owner }) => owner.selection.subscribe(update, true));
        if (edge) subscriptions.push(edge.selection.subscribe(update, true));
        const close = () => {
            if (closed) return;
            closed = true;
            options.signal.removeEventListener('abort', close);
            for (const unsubscribe of subscriptions) unsubscribe();
        };
        options.signal.addEventListener('abort', close, { once: true });
        if (options.signal.aborted) close(); else update();
        return close;
    };
}
