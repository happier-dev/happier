import { projectDeploymentHealthAggregateV1, type DeploymentReadTransportV1,
    type DeploymentEnvironmentHealthFeedV1, type DeploymentEnvironmentHealthMemberV1, type DeploymentHealthServicesObservationV1,
    type DeploymentReadScopeV1, type DeploymentReadOptionsV1, type DeploymentReadResultV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentHealthCurrentResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { createMachineServiceResourceBinding } from '@/components/machines/resources/useMachineServiceResource';
import { machineServicesListProjection } from '@/components/machines/services/machineServicesListProjection';

type CurrentEdge = ReturnType<typeof DeploymentHealthCurrentResultV1Schema.parse>;
type MachineServicesList = ReturnType<typeof MachineServicesListResultV1Schema.parse>
    & Readonly<{ firstInventoryCount: number | null }>;
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

type EnvironmentHealthTarget = Readonly<{
    environment: DeploymentEnvironmentHeaderV1;
    runtimeTargetLink?: DeploymentTargetLinkHeaderV1 | null;
}>;
type HealthPublisher = Parameters<NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']>>[2];
type HealthBorrower = Readonly<{ collection: boolean; publish: HealthPublisher }>;
const healthObservations = new WeakMap<ServerAccountScopeLifetime, Map<string, ReturnType<typeof createEnvironmentHealthObservation>>>();

type NativeServiceRows = Extract<MachineServicesList, { kind: 'snapshot' }>['services'];
const NO_NATIVE_ROWS: NativeServiceRows = [];
const machineWatches = new WeakMap<ServerAccountScopeLifetime, Map<string, ReturnType<typeof createMachineHealthWatch>>>();

function createMachineHealthWatch(lifetime: ServerAccountScopeLifetime, machineId: string, environmentId?: string) {
    const { selection } = createMachineServiceResourceBinding({ accountLifetime: lifetime, reference: {
        hostRead: 'machines.services.list', input: { serverId: lifetime.scope.serverId, machineId,
            ...(environmentId === undefined ? {} : { environmentId }) },
    }, projection: machineServicesListProjection });
    const listeners = new Set<() => void>();
    let stop: (() => void) | undefined;
    let indexedRows: NativeServiceRows | undefined;
    let byEnvironment = new Map<string, NativeServiceRows[number][]>();

    return {
        read(id: string) {
            const snapshot = selection.getSnapshot();
            const rows = snapshot.value?.kind === 'snapshot' ? snapshot.value.services : NO_NATIVE_ROWS;
            if (rows !== indexedRows) {
                indexedRows = rows;
                byEnvironment = new Map();
                for (const row of rows) {
                    if (!row.environmentId) continue;
                    const group = byEnvironment.get(row.environmentId);
                    if (group) group.push(row);
                    else byEnvironment.set(row.environmentId, [row]);
                }
            }
            return { snapshot, rows: byEnvironment.get(id) ?? NO_NATIVE_ROWS };
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            stop ??= selection.subscribe(() => { for (const notify of listeners) notify(); }, true);
        },
        unsubscribe(listener: () => void) {
            listeners.delete(listener);
            if (listeners.size > 0) return false;
            stop?.();
            stop = undefined;
            return true;
        },
    };
}

/** The collection attaches once per Machine; only selected detail demands an Environment-scoped read. */
function nativeHealthWatch(lifetime: ServerAccountScopeLifetime, machineId: string, environmentId?: string) {
    if (environmentId !== undefined) return createMachineHealthWatch(lifetime, machineId, environmentId);
    let machines = machineWatches.get(lifetime);
    if (!machines) {
        machines = new Map();
        machineWatches.set(lifetime, machines);
    }
    const active = machines;
    const watch = active.get(machineId) ?? createMachineHealthWatch(lifetime, machineId);
    active.set(machineId, watch);
    return {
        read: watch.read,
        subscribe: watch.subscribe,
        unsubscribe(listener: () => void) {
            if (watch.unsubscribe(listener)) active.delete(machineId);
        },
    };
}

function createEnvironmentHealthObservation(lifetime: ServerAccountScopeLifetime, environment: DeploymentEnvironmentHeaderV1,
    link: DeploymentTargetLinkHeaderV1, activeMembers: readonly DeploymentTargetLinkHeaderV1['members'][number][]) {
    const serverId = lifetime.scope.serverId;
    const needsEdge = environment.ingress?.kind === 'edgeCaddy';
    const edge = needsEdge && environment.controllerMachineId
        ? createMachineServiceResourceBinding({ accountLifetime: lifetime, reference: {
            hostRead: 'deployments.health.edge', input: { serverId, machineId: environment.controllerMachineId,
                environmentId: environment.id, targetLinkId: link.id },
        }, projection: currentEdgeProjection }) : null;
    const borrowers = new Set<HealthBorrower>();
    let nativeEnvironmentId: string | undefined;
    let bindings: { member: typeof activeMembers[number]; owner: ReturnType<typeof nativeHealthWatch> }[] = [];
    let stopEdge: (() => void) | undefined;
    let feed: DeploymentEnvironmentHealthFeedV1 | undefined;
    let aggregate: ReturnType<typeof projectDeploymentHealthAggregateV1> | undefined;

    function update() {
        if (borrowers.size === 0) return;
        const observations: DeploymentHealthServicesObservationV1[] = [];
        const members = bindings.map(({ member, owner }): DeploymentEnvironmentHealthMemberV1 => {
            const { snapshot, rows } = owner.read(environment.id);
            const value = snapshot.value;
            // A currently reachable Machine may have replaced the installation the Environment names.
            const services = rows.flatMap(row => row.deployment?.installationId !== member.installationId ? [] : [{ serviceId: row.serviceId,
                name: row.name, state: row.health?.status ?? 'unknown', observedAt: row.health?.observedAtMs ?? null,
                reason: row.health?.reason ?? (row.health ? null : 'coverage_unavailable'),
                ...(row.health?.expectedDown ? { expectedDown: row.health.expectedDown } : {}),
            }]);
            const failure = snapshot.error ? { code: snapshot.error.code ?? 'deployment_read_failed', retryable: snapshot.error.retryable ?? false }
                : value?.kind === 'unavailable' ? { code: value.reason, retryable: false }
                : services.length !== rows.length ? { code: 'target_mismatch', retryable: false } : undefined;
            const status = failure ? 'unavailable' : value?.kind === 'snapshot' ? 'ready' : 'loading';
            if (status === 'ready' && snapshot.freshness === 'fresh') {
                observations.push({ environmentId: environment.id, targetLinkId: link.id, targetLinkRevision: link.revision,
                    machineId: member.machineId, installationId: member.installationId, role: 'runtime',
                    source: { kind: 'native' }, observedAtMs: services.reduce(
                        (latest, service) => Math.max(latest, service.observedAt ?? 0), 0),
                    services: services.map(service => ({ serviceId: service.serviceId,
                        ...(service.observedAt === null ? {} : { observation: { status: service.state, observedAtMs: service.observedAt,
                            ...(service.reason === null ? {} : { reason: service.reason }),
                            ...(service.expectedDown ? { expectedDown: service.expectedDown } : {}),
                        } }),
                    })),
                });
            }
            return { machineId: member.machineId, installationId: member.installationId, services, status,
                ...(failure ? { failure } : {}) };
        });
        const status = members.length === 0 ? 'unavailable' : members.every(member => member.status === 'ready') ? 'ready'
            : members.some(member => member.status === 'loading') ? 'loading'
            : members.some(member => member.status === 'ready') ? 'partial' : 'unavailable';
        const currentEdge = edge?.selection.getSnapshot();
        const edgeResult = currentEdge?.freshness === 'fresh' && !currentEdge.error ? currentEdge.value : undefined;
        const edgeReady = edgeResult?.ok === true;
        if (edgeReady && edgeResult.observation) observations.push(edgeResult.observation);
        const nextFeed: DeploymentEnvironmentHealthFeedV1 = {
            environmentId: environment.id, members,
            status: !edge ? status : edgeReady ? (members.length === 0 ? 'ready' : status)
                : status === 'ready' ? 'partial' : currentEdge?.error ? 'unavailable' : 'loading',
        };
        const previous = aggregate;
        // A read still in flight supplies no edge verdict. Keep the prior aggregate on refresh.
        const awaitingEdge = needsEdge && !edgeResult && !currentEdge?.error
            && (!currentEdge?.value || currentEdge.pending !== 'idle');
        const awaitingRuntime = aggregate !== undefined && status === 'loading'
            && !(edgeReady && edgeResult.observation?.status === 'down');
        if (!awaitingEdge && !awaitingRuntime) {
            // Settled Resource snapshots replace withdrawn evidence. Reuse only the published shapes.
            aggregate = retainDeep(aggregate, projectDeploymentHealthAggregateV1({ environment, targetLink: link, observations }));
        }
        feed = nextFeed;
        for (const borrower of borrowers) {
            if (!borrower.collection || previous !== aggregate) borrower.publish(feed, aggregate);
        }
    }

    function syncNative() {
        // Keep the detail read scoped to this Environment. List-only borrowers reuse
        // the existing Machine-wide Resource across all covered rows on that Machine.
        const environmentId = [...borrowers].some(borrower => !borrower.collection) ? environment.id : undefined;
        if (bindings.length === activeMembers.length && nativeEnvironmentId === environmentId) return false;
        for (const { owner } of bindings) owner.unsubscribe(update);
        nativeEnvironmentId = environmentId;
        bindings = activeMembers.map(member => ({ member, owner: nativeHealthWatch(lifetime, member.machineId, environmentId) }));
        for (const { owner } of bindings) owner.subscribe(update);
        return true;
    }

    return {
        subscribe(borrower: HealthBorrower) {
            const first = borrowers.size === 0;
            borrowers.add(borrower);
            if (feed && (!borrower.collection || aggregate)) borrower.publish(feed, aggregate);
            const nativeChanged = syncNative();
            if (first) stopEdge = edge?.selection.subscribe(update, true);
            if (first || nativeChanged) update();
        },
        unsubscribe(borrower: HealthBorrower) {
            borrowers.delete(borrower);
            if (borrowers.size > 0) {
                if (syncNative()) update();
                return false;
            }
            stopEdge?.();
            for (const { owner } of bindings) owner.unsubscribe(update);
            return true;
        },
    };
}

/** List and detail borrow the same current aggregate for an admitted Environment and runtime basis. */
function subscribeEnvironmentHealth(lifetime: ServerAccountScopeLifetime, target: EnvironmentHealthTarget, borrower: HealthBorrower) {
    const { environment, runtimeTargetLink: link } = target;
    if (!link || link.targetKind !== 'ownServer') {
        borrower.publish({ environmentId: environment.id, status: 'unavailable', members: [] });
        return () => {};
    }
    const activeMembers = link.members.filter(member => member.state === 'active');
    const key = JSON.stringify([environment.id, environment.protection, link.id,
        environment.ingress?.kind === 'edgeCaddy'
            ? [environment.controllerMachineId, environment.ingress.edgeMachineId, link.revision] : null,
        activeMembers.map(member => JSON.stringify([member.machineId, member.installationId])).sort()]);
    const accountLifetime = readServerAccountScopeOwnerLifetime(lifetime);
    let observations = healthObservations.get(accountLifetime);
    if (!observations) {
        observations = new Map();
        healthObservations.set(accountLifetime, observations);
    }
    const active = observations;
    let observation = active.get(key);
    if (!observation) {
        observation = createEnvironmentHealthObservation(accountLifetime, environment, link, activeMembers);
        active.set(key, observation);
    }
    const shared = observation;
    shared.subscribe(borrower);
    return () => { if (shared.unsubscribe(borrower)) active.delete(key); };
}

function observeWhileDemanded(signal: AbortSignal, subscribe: () => () => void): () => void {
    if (signal.aborted) return () => {};
    const stop = subscribe();
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', close);
        stop();
    };
    if (signal.aborted) close(); else signal.addEventListener('abort', close, { once: true });
    return close;
}

export function environmentHealthObserver(lifetime: ServerAccountScopeLifetime): NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']> {
    return (_scope, detail, publish, { signal }) => observeWhileDemanded(signal,
        () => subscribeEnvironmentHealth(lifetime, detail, { collection: false, publish }));
}

export function environmentCollectionHealthObserver(lifetime: ServerAccountScopeLifetime): NonNullable<DeploymentReadTransportV1['observeEnvironmentCollectionHealth']> {
    return (_scope, items, publish, { signal }) => observeWhileDemanded(signal, () => {
        const stops = items.map(item => subscribeEnvironmentHealth(lifetime, item, {
            collection: true, publish: (feed, aggregate) => publish(feed.environmentId, aggregate),
        }));
        return () => { for (const stop of stops) stop(); };
    });
}
