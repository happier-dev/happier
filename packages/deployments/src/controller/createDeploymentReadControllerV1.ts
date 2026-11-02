import {
    DeploymentEnvironmentDetailV1Schema, DeploymentEnvironmentCollectionV1Schema,
    DeploymentReceiptDetailV1Schema, DeploymentReceiptHistoryV1Schema,
    type DeploymentEnvironmentHeaderV1, type DeploymentEnvironmentDetailV1, type DeploymentEnvironmentCollectionV1,
    type DeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/v1';
import { createDeploymentProjectionV1 } from '../projection/deploymentStore.js';
import { deriveDeploymentMemberVersionsV1 } from '../projection/deploymentStepProjection.js';
import { selectDeploymentRuntimeTargetLinkV1 } from '../projection/deploymentSelectors.js';
import { isDeploymentReadDemandActiveV1, isDeploymentReceiptObservationEligibleV1 } from './deploymentObservationDemand.js';
import { createDeploymentReadPageLease } from './deploymentReadPageLease.js';
import { createDeploymentReadFactLeaseV1 } from './deploymentReadFactLease.js';
import { projectDeploymentChipV1 } from '../projection/deploymentSurfaceFacts.js';
import { projectDeploymentReceiptFactsV1 } from '../projection/deploymentReceiptFacts.js';
import { deploymentEnvironmentHealthBasisV1, reconcileDeploymentEnvironmentHealthObservationV1,
    stopDeploymentEnvironmentHealthObservationV1, type DeploymentEnvironmentHealthObservationV1 } from './deploymentEnvironmentHealthObservation.js';
import type {
    DeploymentReadControllerV1, DeploymentReadDemandV1, DeploymentReadFailureV1,
    DeploymentReadLeaseV1, DeploymentReadResultV1, DeploymentReadScopeV1,
    DeploymentReadSnapshotV1, DeploymentReadTransportV1, DeploymentHistoryPageV1,
    DeploymentEnvironmentReadDetailV1, DeploymentEnvironmentReadCollectionV1, DeploymentReceiptReadDetailV1,
    DeploymentDomainReadPageV1,
} from './deploymentReadControllerTypes.js';

type Resource = Readonly<{
    key: string;
    kind: 'activity' | 'collection' | 'environment' | 'history' | 'receipt' | 'domains';
    environmentId?: string;
    environmentIds?: ReadonlySet<string>;
    deploymentId?: string;
    previousPage?: boolean;
    read(signal: AbortSignal): Promise<DeploymentReadResultV1<unknown>>;
    admit(value: unknown): unknown;
}>;
type Entry = {
    resource: Resource;
    projection: ReturnType<typeof createDeploymentProjectionV1>;
    demands: Set<{ current: DeploymentReadDemandV1; consumeHealth: boolean }>;
    abort: AbortController | undefined;
    request: Promise<void> | undefined;
    observation: Observation | undefined;
    healthObservation: DeploymentEnvironmentHealthObservationV1 | undefined;
    nextCursor: string | null;
    dirty: boolean;
};
type Observation = { abort: AbortController; entries: Set<Entry> };
const invalidResponse: DeploymentReadFailureV1 = { code: 'invalid_response', retryable: false };
const unavailable: DeploymentReadFailureV1 = { code: 'deployment_read_failed', retryable: true };
const retiredSnapshot: DeploymentReadSnapshotV1<never> = { status: 'unavailable', value: null, failure: { code: 'authority_changed', retryable: false } };
const releasedSnapshot: DeploymentReadSnapshotV1<never> = { status: 'idle', value: null, failure: null };

/** One authenticated Home/Account, optionally narrowed to a Source; no persistence or timer owner. */
export function createDeploymentReadControllerV1({ scope: suppliedScope, transport }: Readonly<{
    scope: DeploymentReadScopeV1; transport: DeploymentReadTransportV1;
}>): DeploymentReadControllerV1 {
    const scope = Object.freeze({ ...suppliedScope });
    const entries = new Map<string, Entry>();
    const observationDemand = new Set<Entry>();
    let observationQueued = false;
    let retired = false;
    const active = (entry: Entry) => !retired && [...entry.demands].some(demand => isDeploymentReadDemandActiveV1(demand.current));
    const syncHealthObservation = (entry: Entry) => {
        if (entry.resource.kind === 'environment') reconcileDeploymentEnvironmentHealthObservationV1(entry,
            !retired && [...entry.demands].some(demand => demand.consumeHealth && isDeploymentReadDemandActiveV1(demand.current)), scope, transport);
    };
    const environmentMatches = (row: DeploymentEnvironmentHeaderV1) => row.serverId === scope.serverId
        && (scope.projectSourceId === undefined || row.projectSourceId === scope.projectSourceId);
    function fail(entry: Entry, failure: DeploymentReadFailureV1) {
        const value = failure.retryable ? entry.projection.getSnapshot().value : null;
        entry.projection.publish({ status: 'unavailable', value, failure });
        if (value === null) stopDeploymentEnvironmentHealthObservationV1(entry);
        if (entry.resource.kind === 'receipt' && value === null) refreshMemberVersions(entry.resource.environmentId!);
    }
    function stopObservation(entry: Entry) {
        observationDemand.delete(entry);
        const batch = entry.observation;
        if (!batch) return;
        entry.observation = undefined;
        batch.entries.delete(entry);
        if (batch.entries.size === 0) batch.abort.abort();
    }
    function stopRead(entry: Entry) {
        if (entry.request) entry.dirty = true;
        entry.abort?.abort();
        entry.abort = undefined;
        entry.request = undefined;
        if (entry.projection.getSnapshot().status === 'loading') entry.projection.publish(releasedSnapshot);
    }
    function receipt(entry: Entry): DeploymentReceiptDetailV1 | null {
        return entry.resource.kind === 'receipt' ? entry.projection.getSnapshot().value as DeploymentReceiptDetailV1 | null : null;
    }
    function withMemberVersions(detail: DeploymentEnvironmentDetailV1): DeploymentEnvironmentReadDetailV1 {
        const link = selectDeploymentRuntimeTargetLinkV1(detail);
        const retained = [...entries.values()].flatMap(entry => {
            const opened = entry.resource.environmentId === detail.environment.id ? receipt(entry) : null;
            return opened ? [opened] : [];
        });
        return { ...detail, runtimeTargetLink: link, memberVersions: link ? deriveDeploymentMemberVersionsV1(link, retained,
            detail.targetLinks.map(item => item.targetLink)) : {} };
    }
    function refreshMemberVersions(environmentId: string) {
        for (const entry of entries.values()) {
            if (entry.resource.kind !== 'environment' || entry.resource.environmentId !== environmentId || !active(entry)) continue;
            const snapshot = entry.projection.getSnapshot();
            if (snapshot.value) entry.projection.publish({ ...snapshot, value: withMemberVersions(snapshot.value as DeploymentEnvironmentDetailV1) });
        }
    }
    function publishValue(entry: Entry, value: unknown) {
        entry.dirty = false;
        if (entry.resource.kind === 'receipt') {
            const detail = value as DeploymentReceiptDetailV1;
            value = { ...detail, chip: projectDeploymentChipV1(detail.deployment), facts: projectDeploymentReceiptFactsV1(detail) };
        }
        if (entry.resource.kind === 'collection') {
            const page = value as DeploymentEnvironmentCollectionV1;
            value = { ...page, items: page.items.map(row => ({ ...row,
                chip: row.currentDeployment ? projectDeploymentChipV1(row.currentDeployment) : null })) };
        }
        if (entry.resource.kind === 'collection' || entry.resource.kind === 'history' || entry.resource.kind === 'domains') {
            const { nextCursor, ...facts } = value as { nextCursor: string | null };
            // Even an equal page refresh replaces request state without publishing it.
            entry.nextCursor = nextCursor;
            value = { ...facts, hasNextPage: nextCursor !== null, hasPreviousPage: entry.resource.previousPage === true };
        }
        if (entry.resource.kind === 'environment') {
            const detail = withMemberVersions(value as DeploymentEnvironmentDetailV1);
            const previous = entry.projection.getSnapshot().value as DeploymentEnvironmentReadDetailV1 | null;
            value = previous?.healthFeed && deploymentEnvironmentHealthBasisV1(previous) === deploymentEnvironmentHealthBasisV1(detail)
                ? { ...detail, healthFeed: previous.healthFeed } : detail;
        }
        entry.projection.publish({ status: 'ready', value, failure: null });
        syncHealthObservation(entry);
        if (entry.resource.kind === 'receipt') refreshMemberVersions(entry.resource.environmentId!);
    }
    function queueObservation(entry: Entry) {
        const value = receipt(entry);
        if (!transport.observeReceipts || !active(entry) || !value || !isDeploymentReceiptObservationEligibleV1(value.deployment.state)) return;
        observationDemand.add(entry);
        if (observationQueued) return;
        observationQueued = true;
        // Gather this turn's ready ids before crossing the network boundary.
        queueMicrotask(flushObservations);
    }
    function flushObservations() {
        observationQueued = false;
        const targets = new Map<string, Entry[]>();
        for (const entry of observationDemand) {
            const value = receipt(entry);
            if (!active(entry) || !value || !isDeploymentReceiptObservationEligibleV1(value.deployment.state)) continue;
            const target = value.deployment.targetLinkId;
            const group = targets.get(target) ?? [];
            group.push(entry);
            targets.set(target, group);
        }
        observationDemand.clear();
        for (const [target, demanded] of targets) {
            const batch: Observation = { abort: new AbortController(), entries: new Set(demanded) };
            for (const entry of demanded) { stopObservation(entry); entry.observation = batch; }
            void observe(target, batch);
        }
    }
    async function observe(target: string, batch: Observation) {
        try {
            const response = await transport.observeReceipts!(scope, target, [...batch.entries].map(entry => entry.resource.deploymentId!), { signal: batch.abort.signal });
            if (retired || batch.abort.signal.aborted) return;
            if (!response.ok) {
                for (const entry of batch.entries) if (active(entry)) fail(entry, response.failure);
                return;
            }
            const values = response.value.map(value => DeploymentReceiptDetailV1Schema.safeParse(value));
            for (const entry of batch.entries) {
                if (!active(entry)) continue;
                const value = values.find(parsed => parsed.success && parsed.data.deployment.id === entry.resource.deploymentId);
                if (!value?.success || value.data.deployment.environmentId !== entry.resource.environmentId || value.data.deployment.targetLinkId !== target) {
                    fail(entry, invalidResponse);
                } else publishValue(entry, value.data);
            }
        } catch {
            if (!retired && !batch.abort.signal.aborted) for (const entry of batch.entries) if (active(entry)) fail(entry, unavailable);
        } finally {
            for (const entry of batch.entries) if (entry.observation === batch) entry.observation = undefined;
        }
    }
    function refresh(entry: Entry, supersede = false): Promise<void> {
        if (!active(entry)) return Promise.resolve();
        if (entry.request && !supersede) return entry.request;
        if (supersede) {
            entry.abort?.abort();
            stopDeploymentEnvironmentHealthObservationV1(entry);
        }
        stopObservation(entry);
        const abort = new AbortController();
        entry.abort = abort;
        if (entry.projection.getSnapshot().value === null) entry.projection.publish({ status: 'loading', value: null, failure: null });
        const perform = async () => {
            try {
                const response = await entry.resource.read(abort.signal);
                if (retired || abort.signal.aborted || entry.abort !== abort) return;
                if (!response.ok) { fail(entry, response.failure); return; }
                let value: unknown;
                try { value = entry.resource.admit(response.value); }
                catch { fail(entry, invalidResponse); return; }
                publishValue(entry, value);
                queueObservation(entry);
            } catch {
                if (!retired && !abort.signal.aborted && entry.abort === abort) fail(entry, unavailable);
            }
        };
        const request = perform().finally(() => {
            if (entry.abort === abort) { entry.abort = undefined; entry.request = undefined; }
        });
        entry.request = request;
        return request;
    }
    function acquire<T>(resource: Resource, initialDemand: DeploymentReadDemandV1, consumeHealth = false): DeploymentReadLeaseV1<T> {
        let entry = entries.get(resource.key);
        if (!entry) {
            entry = { resource, projection: createDeploymentProjectionV1(), demands: new Set(), abort: undefined, request: undefined,
                observation: undefined, healthObservation: undefined, nextCursor: null, dirty: true };
            entries.set(resource.key, entry);
        }
        const held = entry;
        const wasActive = active(held);
        const demand = { current: { ...initialDemand }, consumeHealth };
        const subscriptions = new Map<() => void, () => void>();
        let released = false;
        held.demands.add(demand);
        if (retired) held.projection.publish(retiredSnapshot);
        else if (active(held) && ((!wasActive && (held.resource.kind !== 'collection' || held.dirty
            || held.projection.getSnapshot().status !== 'ready')) || held.projection.getSnapshot().status === 'idle')) void refresh(held);
        syncHealthObservation(held);
        return {
            getSnapshot: () => (released ? releasedSnapshot : held.projection.getSnapshot()) as DeploymentReadSnapshotV1<T>,
            subscribe(listener) {
                if (released) return () => {};
                const unsubscribe = held.projection.subscribe(() => {
                    // A visible peer may share this record. Hidden borrowers do
                    // no presentation work, but must still withdraw denied data.
                    if (isDeploymentReadDemandActiveV1(demand.current)
                        || held.projection.getSnapshot().failure?.retryable === false) listener();
                });
                subscriptions.set(unsubscribe, listener);
                return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
            },
            refresh: options => released || !isDeploymentReadDemandActiveV1(demand.current)
                ? Promise.resolve() : refresh(held, options?.supersede),
            setDemand(next) {
                if (released) return;
                const wasActive = isDeploymentReadDemandActiveV1(demand.current);
                const entryWasActive = active(held);
                demand.current = { ...next };
                syncHealthObservation(held);
                if (!active(held)) { stopRead(held); stopObservation(held); }
                else if (!wasActive && isDeploymentReadDemandActiveV1(next)) {
                    // Deliver the current shared value when presentation resumes,
                    // even if the following read returns an equal ready snapshot.
                    for (const listener of subscriptions.values()) listener();
                    if ((!entryWasActive && (held.resource.kind !== 'collection' || held.dirty
                        || held.projection.getSnapshot().status !== 'ready')) || held.projection.getSnapshot().status === 'idle') void refresh(held);
                }
            },
            release() {
                if (released) return;
                released = true;
                for (const unsubscribe of subscriptions.keys()) unsubscribe();
                subscriptions.clear();
                held.demands.delete(demand);
                syncHealthObservation(held);
                if (!active(held)) { stopRead(held); stopObservation(held); }
                if (held.demands.size === 0 && resource.kind !== 'collection') {
                    held.projection.clear(); entries.delete(resource.key);
                    if (resource.kind === 'receipt') refreshMemberVersions(resource.environmentId!);
                }
            },
        };
    }
    const controller: DeploymentReadControllerV1 = {
        scope,
        acquireDomains(environmentId, query, demand) {
            const key = (cursor: string | undefined) => JSON.stringify(['domains', environmentId, cursor ?? null]);
            return createDeploymentReadPageLease<DeploymentDomainReadPageV1>({ initialCursor: query.cursor, demand,
                nextCursor: cursor => entries.get(key(cursor))?.nextCursor ?? null,
                acquire: (cursor, pageDemand) => acquire<DeploymentDomainReadPageV1>({
                    key: key(cursor), kind: 'domains', environmentId, previousPage: cursor !== undefined,
                    read: signal => transport.listDomains?.(scope, environmentId, cursor === undefined ? {} : { cursor }, { signal })
                        ?? Promise.resolve({ ok: false, failure: { code: 'deployment_unavailable', retryable: false } }),
                    // Domain wire/content admission belongs to the typed host transport.
                    admit: value => value,
                }, pageDemand) });
        },
        acquireCollection(query, demand) {
            const { cursor: initialCursor, environmentIds: suppliedEnvironmentIds,
                previewPullRequestIds: suppliedPreviewPullRequestIds, ...filters } = query;
            const environmentIds = suppliedEnvironmentIds === undefined ? undefined : [...new Set(suppliedEnvironmentIds)].sort();
            const previewPullRequestIds = suppliedPreviewPullRequestIds === undefined ? undefined : [...new Set(suppliedPreviewPullRequestIds)].sort();
            const previewIds = new Set(previewPullRequestIds);
            const key = (cursor: string | undefined) => JSON.stringify(['collection', cursor ?? null, filters.machineId ?? null, environmentIds ?? null,
                filters.previewRepositoryId ?? null, previewPullRequestIds ?? null, filters.previewTemplateEnvironmentId ?? null]);
            return createDeploymentReadPageLease<DeploymentEnvironmentReadCollectionV1>({ initialCursor, demand,
                nextCursor: cursor => entries.get(key(cursor))?.nextCursor ?? null,
                acquire: (cursor, pageDemand) => acquire<DeploymentEnvironmentReadCollectionV1>({
                key: key(cursor), kind: 'collection',
                ...(environmentIds === undefined ? {} : { environmentIds: new Set(environmentIds) }), previousPage: cursor !== undefined,
                read: signal => transport.listEnvironments(scope, { ...filters,
                    ...(environmentIds === undefined ? {} : { environmentIds }),
                    ...(previewPullRequestIds === undefined ? {} : { previewPullRequestIds }),
                    ...(cursor === undefined ? {} : { cursor }) }, { signal }),
                admit(value) {
                    const page = DeploymentEnvironmentCollectionV1Schema.parse(value);
                    if (!page.items.every(row => environmentMatches(row.environment))) throw new Error('Foreign Environment');
                    if (filters.previewRepositoryId !== undefined && !page.items.every(({ environment }) => environment.purpose === 'preview'
                        && environment.previewRepositoryId === filters.previewRepositoryId
                        && previewIds.has(environment.previewPullRequestId!))) throw new Error('Foreign preview');
                    if (filters.previewTemplateEnvironmentId !== undefined && !page.items.every(({ environment }) => environment.purpose === 'preview'
                        && environment.previewTemplateEnvironmentId === filters.previewTemplateEnvironmentId)) throw new Error('Foreign preview template');
                    return page;
                },
            }, pageDemand) });
        },
        acquireEnvironment(environmentId, demand, options) {
            return acquire<DeploymentEnvironmentReadDetailV1>({
                key: JSON.stringify(['environment', environmentId]), kind: 'environment', environmentId,
                read: signal => transport.readEnvironment(scope, environmentId, { signal }),
                admit(value) {
                    const detail = DeploymentEnvironmentDetailV1Schema.parse(value);
                    if (!environmentMatches(detail.environment) || detail.environment.id !== environmentId
                        || !detail.targetLinks.every(link => link.targetLink.environmentId === environmentId)) throw new Error('Foreign Environment');
                    const aggregate = detail.healthAggregate;
                    if (aggregate && (aggregate.environmentId !== detail.environment.id
                        || aggregate.targetLinkId !== detail.environment.runtimeTargetLinkId
                        || aggregate.protection !== detail.environment.protection
                        || !detail.targetLinks.some(link => link.targetLink.id === aggregate.targetLinkId))) throw new Error('Foreign health aggregate');
                    return detail;
                },
            }, demand, options?.health === true);
        },
        acquireActivity(demand) {
            return acquire({ key: 'activity', kind: 'activity',
                read: signal => transport.readActivity?.(scope, { signal }) ?? Promise.resolve({ ok: false,
                    failure: { code: 'deployment_unavailable', retryable: false } }),
                admit: value => value,
            }, demand);
        },
        acquireHistory(environmentId, query, demand) {
            const key = (cursor: string | undefined) => JSON.stringify(['history', environmentId, cursor ?? null]);
            return createDeploymentReadPageLease<DeploymentHistoryPageV1>({ initialCursor: query.cursor, demand,
                nextCursor: cursor => entries.get(key(cursor))?.nextCursor ?? null,
                acquire: (cursor, pageDemand) => acquire<DeploymentHistoryPageV1>({
                key: key(cursor), kind: 'history', environmentId, previousPage: cursor !== undefined,
                read: signal => transport.listHistory(scope, environmentId, cursor === undefined ? {} : { cursor }, { signal }),
                admit(value) {
                    const page = DeploymentReceiptHistoryV1Schema.parse(value);
                    if (!page.items.every(row => row.environmentId === environmentId)) throw new Error('Foreign receipt');
                    return page;
                },
            }, pageDemand) });
        },
        acquireReceipt(environmentId, deploymentId, demand) {
            return acquire<DeploymentReceiptReadDetailV1>({
                key: JSON.stringify(['receipt', environmentId, deploymentId]), kind: 'receipt', environmentId, deploymentId,
                read: signal => transport.readReceipt(scope, environmentId, deploymentId, { signal }),
                admit(value) {
                    const detail = DeploymentReceiptDetailV1Schema.parse(value);
                    if (detail.deployment.environmentId !== environmentId || detail.deployment.id !== deploymentId) throw new Error('Foreign receipt');
                    return detail;
                },
            }, demand);
        },
        acquireReceiptChip(environmentId, deploymentId, demand) {
            return createDeploymentReadFactLeaseV1(controller.acquireReceipt(environmentId, deploymentId, demand), detail => detail.chip);
        },
        invalidate(change) {
            if (retired) return;
            const hints = ('environmentId' in change ? [change] : change).filter(hint =>
                scope.projectSourceId === undefined || hint.projectSourceId === undefined
                    || hint.projectSourceId === scope.projectSourceId);
            if (hints.length === 0) return;
            for (const entry of entries.values()) {
                const resource = entry.resource;
                const collection = resource.kind === 'collection'
                    ? entry.projection.getSnapshot().value as DeploymentEnvironmentReadCollectionV1 | null : null;
                // Receipt stages also feed the collection's latest-attempt row.
                // Only pages containing that Environment need the header refresh.
                const affected = hints.some(hint => resource.kind === 'activity' ? hint.activityChanged === true
                    : hint.activityChanged === true ? false : resource.kind === 'collection'
                    ? resource.environmentIds !== undefined
                        ? hint.deploymentId === undefined && resource.environmentIds.has(hint.environmentId)
                        : hint.deploymentId === undefined || collection === null || collection.items.some(row => row.environment.id === hint.environmentId)
                    : resource.environmentId === hint.environmentId && (hint.deploymentId === undefined
                        ? resource.kind === 'environment' || resource.kind === 'domains'
                        : resource.kind === 'history' || (resource.kind === 'receipt' && resource.deploymentId === hint.deploymentId)));
                if (affected) { entry.dirty = true; stopRead(entry); stopObservation(entry); void refresh(entry); }
            }
        },
        refreshDemanded: () => Promise.all([...entries.values()].map(entry => {
            entry.dirty = true;
            return refresh(entry, true);
        })).then(() => {}),
        retire() {
            if (retired) return;
            retired = true;
            for (const entry of entries.values()) {
                stopRead(entry); stopObservation(entry);
                stopDeploymentEnvironmentHealthObservationV1(entry);
                entry.projection.publish(retiredSnapshot);
            }
            observationDemand.clear();
        },
    };
    return controller;
}
