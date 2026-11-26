import type { DeploymentSavedCheckObservationV1 } from '@happier-dev/deployments';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { workflowTriggerHealthSourceRevisionV1, type WorkflowTriggerHealthSourceV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { healthResultCheckpointKey, readHealthResultProjectionsForSources } from '@happier-dev/plugins-machine-services/health-results';
import { createActivePluginAccountKvClient } from '@/sync/api/plugins/data/activePluginAccountKvClient';
import { registerActivePluginCollectionChangeWatch } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { listWorkflowTriggerPage } from '@/sync/domains/workflows/workflowTriggerActions';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { projectServiceCheckDefinition, serviceCheckTitle } from './serviceCheckPresentation';

type Result = NonNullable<ReturnType<Awaited<ReturnType<typeof readHealthResultProjectionsForSources>>['get']>>;
type StatusProjection = Readonly<{
    members: Result['projection']['members'];
    checks: readonly Readonly<{ checkId: string; status: DeploymentSavedCheckObservationV1['status'] }>[];
}>;
type Source = WorkflowTriggerHealthSourceV1;
type Subscriber = (observation: DeploymentSavedCheckSnapshot) => void;
export type DeploymentSavedCheckSnapshot = Readonly<{
    pending: boolean;
    observations: readonly DeploymentSavedCheckObservationV1[];
    result: StatusProjection | undefined;
    definitions: Readonly<{ status: 'loading' | 'ready' | 'failed'; sources: readonly Source[]; failure?: unknown }>;
}>;
const EMPTY = Object.freeze([]);
const owners = new WeakMap<ServerAccountScopeLifetime, ReturnType<typeof createOwner>>();

export function observedSavedCheckStatus(result: StatusProjection | undefined, source: Source, checkId: string) {
    if (!result || !source.enabled || !result.members.some(member =>
        member.automationId === source.automationId && member.triggerId === source.triggerId
        && workflowTriggerHealthSourceRevisionV1(member.automationId, member.triggerId, member.triggerRevision) === source.revision)) return null;
    return result.checks.find(check => check.checkId === checkId)?.status ?? null;
}

function createOwner(lifetime: ServerAccountScopeLifetime) {
    const controller = new AbortController();
    const signal = controller.signal;
    const reader = readPluginAccountAvailability(lifetime.scope);
    const kv = createActivePluginAccountKvClient({ accountLifetime: lifetime, pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1,
        readAvailability: () => reader, signal });
    const targets = new Map<string, {
        environmentId: string;
        subscribers: Map<Subscriber, boolean>;
        watch: { dispose(): void };
        definitionsRead: Promise<void> | undefined;
        memberBasis: Result['projection']['members'] | undefined;
        snapshot: DeploymentSavedCheckSnapshot;
    }>();
    type Target = NonNullable<ReturnType<typeof targets.get>>;
    const dirty = new Set<string>();
    let queued = false;
    let reading = false;
    let storageUnavailable = false;

    function mark(sourceId: string) {
        dirty.add(sourceId);
        if (reading || queued || signal.aborted) return;
        queued = true;
        queueMicrotask(() => { queued = false; void refresh(); });
    }
    function publish(target: Target, snapshot: DeploymentSavedCheckSnapshot) {
        const next = retainDeep(target.snapshot, snapshot);
        if (target.snapshot === next) return;
        target.snapshot = next;
        for (const subscriber of target.subscribers.keys()) subscriber(target.snapshot);
    }
    function readDefinitions(id: string, target: Target) {
        if (target.definitionsRead) return target.definitionsRead;
        const pending = listWorkflowTriggerPage({ healthSource: { environmentId: target.environmentId } },
            { accountLifetime: lifetime, signal }).then(page => {
            if (!signal.aborted && targets.get(id) === target) {
                publish(target, { ...target.snapshot, definitions: { status: 'ready', sources: page.healthSources ?? EMPTY } });
            }
        }, failure => {
            if (!signal.aborted && targets.get(id) === target) {
                publish(target, { ...target.snapshot, definitions: { status: 'failed', sources: EMPTY, failure } });
            }
        }).finally(() => { target.definitionsRead = undefined; });
        target.definitionsRead = pending;
        return pending;
    }
    async function refresh() {
        if (signal.aborted || reading) return;
        reading = true;
        try {
            while (dirty.size > 0 && !signal.aborted) {
                const selected = [...dirty].flatMap(id => {
                    const target = targets.get(id);
                    return target ? [[id, target] as const] : [];
                });
                dirty.clear();
                if (selected.length === 0) break;
                let results: Awaited<ReturnType<typeof readHealthResultProjectionsForSources>>;
                try {
                    results = await readHealthResultProjectionsForSources(kv, selected.map(([id]) => id), signal);
                    storageUnavailable = false;
                } catch {
                    storageUnavailable = true;
                    for (const [id, target] of selected) {
                        if (signal.aborted || targets.get(id) !== target) continue;
                        publish(target, { ...target.snapshot, pending: false, observations: EMPTY, result: undefined });
                    }
                    continue;
                }
                await Promise.all(selected.map(async ([id, target]) => {
                    if (signal.aborted || targets.get(id) !== target || dirty.has(id)) return;
                    const result = results.get(id);
                    // A checkpoint's subject can be absent on older rows. Its exact storage key and
                    // current admitted definition still prove scope, so those rows need no backfill.
                    const inScope = result && (!result.source || result.source.sourceInstanceId === id
                        && result.source.subject.kind === 'environment' && result.source.subject.environmentId === target.environmentId);
                    if (!inScope) {
                        publish(target, { ...target.snapshot, pending: false, observations: EMPTY, result: undefined });
                        return;
                    }
                    const basis = retainDeep(target.memberBasis, result.projection.members);
                    if (target.definitionsRead) await target.definitionsRead;
                    if (target.snapshot.definitions.status !== 'ready' || (target.memberBasis && basis !== target.memberBasis)) {
                        await readDefinitions(id, target);
                    }
                    if (!lifetime.isCurrent() || signal.aborted || targets.get(id) !== target || dirty.has(id)) return;
                    target.memberBasis = basis;
                    const statusProjection = { members: basis,
                        checks: result.projection.checks.map(({ checkId, result }) => ({ checkId, status: result.status })) };
                    const observations = target.snapshot.definitions.sources.flatMap(source => {
                        if (source.sourceInstanceId !== id || source.source.subject.kind !== 'environment'
                            || source.source.subject.environmentId !== target.environmentId) return [];
                        return source.source.checks.flatMap(check => {
                            const status = observedSavedCheckStatus(statusProjection, source, check.checkId);
                            if (!status) return [];
                            const definition = projectServiceCheckDefinition(source.source, check);
                            return [{ environmentId: target.environmentId, sourceInstanceId: id,
                                automationId: source.automationId, triggerId: source.triggerId, checkId: check.checkId,
                                name: serviceCheckTitle(definition).title, status }];
                        });
                    });
                    publish(target, { ...target.snapshot, pending: false, observations, result: statusProjection });
                }));
            }
        } finally { reading = false; }
    }
    const stopDefinitionChanges = subscribeHomeAccountChange(event => {
        if (event.workflowTriggersAffect === false) return;
        for (const [id, target] of targets) {
            // A retained result can outlive its Automation. Renew the exact admission on source changes.
            if (!target.snapshot.result && ![...target.subscribers.values()].some(Boolean)) continue;
            void (target.definitionsRead ?? Promise.resolve()).then(() => {
                if (signal.aborted || targets.get(id) !== target) return;
                void readDefinitions(id, target).then(() => mark(id));
            });
        }
    }, { serverIds: [lifetime.scope.serverId],
        reconnect: { readNotCurrent: () => [...targets.values()].some(target => target.snapshot.definitions.status === 'failed') } });
    const stopAvailability = reader.subscribe(() => {
        if (storageUnavailable) for (const id of targets.keys()) mark(id);
    }, HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1);
    const retirement = lifetime.onRetire(() => dispose());

    function dispose() {
        controller.abort();
        stopDefinitionChanges();
        stopAvailability();
        for (const target of targets.values()) target.watch.dispose();
        targets.clear();
        dirty.clear();
    }
    return {
        subscribe(environmentId: string, subscriber: Subscriber, readSavedDefinitions: boolean) {
            const id = createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId });
            let target = targets.get(id);
            if (!target) {
                target = { environmentId, subscribers: new Map(), definitionsRead: undefined, memberBasis: undefined,
                    snapshot: { pending: true, observations: EMPTY, result: undefined, definitions: { status: 'loading', sources: EMPTY } },
                    watch: registerActivePluginCollectionChangeWatch({ pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1,
                        lifetime, kvKey: healthResultCheckpointKey(id), onInvalidated: () => mark(id) }) };
                targets.set(id, target);
                mark(id);
            }
            target.subscribers.set(subscriber, readSavedDefinitions);
            subscriber(target.snapshot);
            if (readSavedDefinitions && target.snapshot.definitions.status !== 'ready') void readDefinitions(id, target);
            return {
                retry() {
                    if (signal.aborted || targets.get(id) !== target) return;
                    void readDefinitions(id, target).then(() => mark(id));
                },
                unsubscribe() {
                    const current = targets.get(id);
                    if (!current) return targets.size === 0;
                    current.subscribers.delete(subscriber);
                    if (current.subscribers.size === 0) {
                        current.watch.dispose();
                        targets.delete(id);
                        dirty.delete(id);
                    }
                    return targets.size === 0;
                },
            };
        },
        dispose() { retirement.dispose(); dispose(); },
    };
}

/** One demanded Account read for the exact sources, shared by list, detail and Settings. */
export function observeDeploymentSavedChecks(lifetime: ServerAccountScopeLifetime, environmentId: string,
    subscriber: Subscriber, options?: Readonly<{ definitions: boolean }>) {
    const ownerLifetime = readServerAccountScopeOwnerLifetime(lifetime);
    if (!ownerLifetime.isCurrent()) return { dispose() {}, retry() {} };
    const owner = owners.get(ownerLifetime) ?? createOwner(ownerLifetime);
    owners.set(ownerLifetime, owner);
    const { unsubscribe, retry } = owner.subscribe(environmentId, subscriber, options?.definitions === true);
    return { retry, dispose() {
        if (unsubscribe()) {
            owner.dispose();
            owners.delete(ownerLifetime);
        }
    } };
}
