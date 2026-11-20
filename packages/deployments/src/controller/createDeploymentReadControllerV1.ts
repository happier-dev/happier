import { withActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { DeploymentEnvironmentDetailV1Schema, DeploymentEnvironmentCollectionV1Schema, DeploymentReceiptDetailV1Schema, DeploymentReceiptHistoryV1Schema, type DeploymentEnvironmentHeaderV1, type DeploymentEnvironmentDetailV1, type DeploymentEnvironmentCollectionV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentProjectionV1 } from '../projection/deploymentStore.js';
import { deriveDeploymentMemberVersionsV1 } from '../projection/deploymentStepProjection.js';
import { selectDeploymentRuntimeTargetLinkV1 } from '../projection/deploymentSelectors.js';
import { isDeploymentReadDemandActiveV1 } from './deploymentObservationDemand.js';
import { createDeploymentReadPageLease } from './deploymentReadPageLease.js';
import { createDeploymentReadFactLeaseV1 } from './deploymentReadFactLease.js';
import { projectDeploymentChipV1 } from '../projection/deploymentSurfaceFacts.js';
import { projectDeploymentReceiptFactsV1, projectDeploymentReceiptUrlFactsV1 } from '../projection/deploymentReceiptFacts.js';
import { readDeploymentSecretRevisionFacts } from '../secrets/readDeploymentSecretRevisionFacts.js';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { deploymentEnvironmentHealthBasisV1, reconcileDeploymentEnvironmentHealthObservationV1,
    reconcileDeploymentDomainHealthObservationV1,
    stopDeploymentEnvironmentHealthObservationV1, type DeploymentEnvironmentHealthObservationV1 } from './deploymentEnvironmentHealthObservation.js';
import type {
    DeploymentReadControllerV1, DeploymentReadDemandV1, DeploymentReadFailureV1,
    DeploymentReadLeaseV1, DeploymentReadResultV1, DeploymentReadScopeV1,
    DeploymentReadSnapshotV1, DeploymentReadTransportV1, DeploymentHistoryPageV1,
    DeploymentEnvironmentReadDetailV1, DeploymentEnvironmentReadCollectionV1, DeploymentReceiptReadDetailV1,
    DeploymentDomainReadPageV1, DeploymentAccountDomainReadPageV1, DeploymentDataServiceReadPageV1,
    DeploymentDataServiceQueryV1,
} from './deploymentReadControllerTypes.js';

type Resource = Readonly<{
    key: string;
    kind: 'activity' | 'collection' | 'environment' | 'history' | 'receipt' | 'domains' | 'domainPage' | 'dataServicePage';
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
    healthObservation: DeploymentEnvironmentHealthObservationV1 | undefined;
    nextCursor: string | null;
    dirty: boolean;
    /** A newer read started by a wake while `request` is still in flight. */
    overlap: { abort: AbortController; request: Promise<void> } | undefined;
    /** A wake arrived while both reads were in flight: read once more after they settle. */
    rereadWhenSettled: boolean;
};
const invalidResponse: DeploymentReadFailureV1 = { code: 'invalid_response', retryable: false };
const unavailable: DeploymentReadFailureV1 = { code: 'deployment_read_failed', retryable: true };
const retiredSnapshot: DeploymentReadSnapshotV1<never> = { status: 'unavailable', value: null, failure: { code: 'authority_changed', retryable: false } };
const releasedSnapshot: DeploymentReadSnapshotV1<never> = { status: 'idle', value: null, failure: null };

function collectionRowHealthBasis(row: DeploymentEnvironmentCollectionV1['items'][number]): string {
    const { environment, runtimeTargetLink: link } = row;
    return JSON.stringify([environment.id, environment.protection,
        environment.ingress?.kind === 'edgeCaddy' ? [environment.controllerMachineId, environment.ingress.edgeMachineId] : null,
        link?.id, link?.revision, link?.targetKind,
        link?.members.filter(member => member.state === 'active')
            .map(member => JSON.stringify([member.machineId, member.installationId])).sort()]);
}

/** One authenticated Home/Account, optionally narrowed to a Source; no persistence or timer owner. */
export function createDeploymentReadControllerV1({ scope: suppliedScope, transport }: Readonly<{
    scope: DeploymentReadScopeV1; transport: DeploymentReadTransportV1;
}>): DeploymentReadControllerV1 {
    const scope = Object.freeze({ ...suppliedScope });
    const entries = new Map<string, Entry>();
    const observeCollectionHealth = transport.observeEnvironmentCollectionHealth;
    let retired = false;
    const active = (entry: Entry) => !retired && [...entry.demands].some(demand => isDeploymentReadDemandActiveV1(demand.current));
    const syncHealthObservation = (entry: Entry, collectionWasActive?: boolean) => {
        if (entry.resource.kind === 'environment') reconcileDeploymentEnvironmentHealthObservationV1(entry,
            !retired && [...entry.demands].some(demand => demand.consumeHealth && isDeploymentReadDemandActiveV1(demand.current)), scope, transport,
            observeCollectionHealth ? undefined : publishCollectionHealth);
        if (entry.resource.kind === 'collection' && collectionWasActive !== active(entry)) reconcileCollectionHealthObservation(entry);
        if (entry.resource.kind === 'domains') reconcileDeploymentDomainHealthObservationV1(entry, active(entry),
            scope, entry.resource.environmentId!, transport);
    };
    const environmentMatches = (row: DeploymentEnvironmentHeaderV1) => row.serverId === scope.serverId
        && (scope.projectSourceId === undefined || row.projectSourceId === scope.projectSourceId);
    function fail(entry: Entry, failure: DeploymentReadFailureV1) {
        const value = failure.retryable ? entry.projection.getSnapshot().value : null;
        entry.projection.publish({ status: 'unavailable', value, failure });
        if (value === null) stopDeploymentEnvironmentHealthObservationV1(entry);
        if (entry.resource.kind === 'receipt' && value === null) refreshMemberVersions(entry.resource.environmentId!);
    }
    function stopRead(entry: Entry) {
        entry.rereadWhenSettled = false;
        if (entry.request) entry.dirty = true;
        entry.overlap?.abort.abort();
        entry.overlap = undefined;
        entry.abort?.abort();
        entry.abort = undefined;
        entry.request = undefined;
        if (entry.projection.getSnapshot().status === 'loading') entry.projection.publish(releasedSnapshot);
    }
    /**
     * Withdrawn presentation starts no further reads, but a read in flight still answers for the record. Aborting it
     * on every hide or remount (viewport/theme changes, QA #63) discarded each completed read and held the page on
     * Loading; letting it land means the next borrower joins it and sees the admitted value.
     */
    function pauseRead(entry: Entry) {
        entry.rereadWhenSettled = false;
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
        const memberVersions = link ? deriveDeploymentMemberVersionsV1(link, retained,
            detail.targetLinks.map(item => item.targetLink)) : {};
        const serving = link && retained.find(receipt => receipt.deployment.id === link.activeDeploymentId
            && receipt.deployment.targetLinkId === link.id);
        const builtInUrls = serving ? projectDeploymentReceiptUrlFactsV1(serving.content).builtInUrls : null;
        const secretRevisions = Object.values(memberVersions).map(member => {
            const generation = member.uncertain ? undefined : retained.find(receipt => receipt.deployment.id === member.deploymentId);
            const runningBindings = generation?.content.ownServer?.approvedInputBasis?.bindings;
            return { machineId: member.machineId, installationId: member.installationId,
                facts: readDeploymentSecretRevisionFacts({ bindings: detail.content.bindings,
                    ...(runningBindings === undefined ? {} : { runningBindings }),
                    ...(detail.savedSecretRevisions === undefined ? {} : { savedSecretRevisions: detail.savedSecretRevisions }) }) };
        });
        return { ...detail, runtimeTargetLink: link, builtInUrls, memberVersions, secretRevisions };
    }
    function refreshMemberVersions(environmentId: string) {
        for (const entry of entries.values()) {
            if (entry.resource.kind !== 'environment' || entry.resource.environmentId !== environmentId || !active(entry)) continue;
            const snapshot = entry.projection.getSnapshot();
            if (snapshot.value) entry.projection.publish({ ...snapshot, value: withMemberVersions(snapshot.value as DeploymentEnvironmentDetailV1) });
        }
    }
    function currentEnvironmentHealth(environmentId: string): DeploymentEnvironmentDetailV1['healthAggregate'] | undefined {
        const entry = [...entries.values()].find(candidate => candidate.resource.kind === 'environment'
            && candidate.resource.environmentId === environmentId);
        return (entry?.projection.getSnapshot().value as DeploymentEnvironmentDetailV1 | null)?.healthAggregate;
    }
    function publishCollectionHealth(environmentId: string, healthAggregate: DeploymentEnvironmentDetailV1['healthAggregate'] | undefined) {
        for (const collection of entries.values()) {
            if (collection.resource.kind !== 'collection' || !active(collection)) continue;
            const snapshot = collection.projection.getSnapshot();
            const page = snapshot.value as DeploymentEnvironmentReadCollectionV1 | null;
            if (!page || !page.items.some(row => row.environment.id === environmentId)) continue;
            const items = page.items.map(row => {
                if (row.environment.id !== environmentId) return row;
                if (healthAggregate) return { ...row, healthAggregate };
                const { healthAggregate: _removed, ...withoutHealth } = row;
                return withoutHealth;
            });
            collection.projection.publish({ ...snapshot, value: { ...page, items } });
        }
    }
    function reconcileCollectionHealthObservation(entry: Entry) {
        const page = entry.projection.getSnapshot().value as DeploymentEnvironmentReadCollectionV1 | null;
        if (!observeCollectionHealth || !active(entry) || !page?.items.length) {
            stopDeploymentEnvironmentHealthObservationV1(entry);
            return;
        }
        const basis = JSON.stringify(page.items.map(collectionRowHealthBasis).sort());
        if (entry.healthObservation?.basis === basis) return;
        stopDeploymentEnvironmentHealthObservationV1(entry);
        const observation: DeploymentEnvironmentHealthObservationV1 = { basis, abort: new AbortController() };
        entry.healthObservation = observation;
        const close = observeCollectionHealth(scope, page.items, (environmentId, aggregate) => {
            if (!observation.abort.signal.aborted) publishCollectionHealth(environmentId, aggregate);
        }, { signal: observation.abort.signal });
        if (observation.abort.signal.aborted) close();
        else observation.stop = close;
    }
    function publishValue(entry: Entry, value: unknown) {
        entry.dirty = false;
        if (entry.resource.kind === 'domains') {
            const page = value as DeploymentDomainReadPageV1;
            const previous = entry.projection.getSnapshot().value as DeploymentDomainReadPageV1 | null;
            const retained = new Map(previous?.items.map(item => [item.domain.id, item]));
            value = { ...page, items: page.items.map(item => {
                const prior = retained.get(item.domain.id);
                return prior?.domain.revision === item.domain.revision ? { ...item,
                    ...(prior.health ? { health: prior.health } : {}),
                    ...(prior.healthUnavailableReason ? { healthUnavailableReason: prior.healthUnavailableReason } : {}) } : item;
            }) };
        }
        if (entry.resource.kind === 'receipt') {
            const detail = value as DeploymentReceiptDetailV1;
            value = { ...detail, chip: projectDeploymentChipV1(detail.deployment), facts: projectDeploymentReceiptFactsV1(detail) };
        }
        if (entry.resource.kind === 'collection') {
            const page = value as DeploymentEnvironmentCollectionV1;
            const previous = entry.projection.getSnapshot().value as DeploymentEnvironmentReadCollectionV1 | null;
            const previousById = new Map(previous?.items.map(row => [row.environment.id, row]));
            value = { ...page, items: page.items.map(row => {
                const prior = previousById.get(row.environment.id);
                const retainedHealth = prior && collectionRowHealthBasis(prior) === collectionRowHealthBasis(row)
                    ? prior.healthAggregate : undefined;
                const healthAggregate = retainedHealth ?? (observeCollectionHealth ? undefined : currentEnvironmentHealth(row.environment.id));
                return { ...row, chip: row.currentDeployment ? projectDeploymentChipV1(row.currentDeployment) : null,
                    ...(healthAggregate ? { healthAggregate } : {}) };
            }) };
        }
        if (entry.resource.kind === 'collection' || entry.resource.kind === 'history' || entry.resource.kind === 'domains' || entry.resource.kind === 'domainPage' || entry.resource.kind === 'dataServicePage') {
            const { nextCursor, ...facts } = value as { nextCursor: string | null };
            // Even an equal page refresh replaces request state without publishing it.
            entry.nextCursor = nextCursor;
            value = { ...facts, hasNextPage: nextCursor !== null, hasPreviousPage: entry.resource.previousPage === true };
        }
        if (entry.resource.kind === 'environment') {
            const detail = withMemberVersions(value as DeploymentEnvironmentDetailV1);
            const previous = entry.projection.getSnapshot().value as DeploymentEnvironmentReadDetailV1 | null;
            value = previous?.healthFeed && deploymentEnvironmentHealthBasisV1(previous) === deploymentEnvironmentHealthBasisV1(detail)
                ? { ...detail, healthFeed: previous.healthFeed, healthAggregate: previous.healthAggregate } : detail;
        }
        entry.projection.publish({ status: 'ready', value, failure: null });
        syncHealthObservation(entry);
        if (entry.resource.kind === 'receipt') refreshMemberVersions(entry.resource.environmentId!);
    }
    function refresh(entry: Entry, supersede = false): Promise<void> {
        if (!active(entry)) return Promise.resolve();
        if (entry.request && !supersede) return entry.request;
        if (supersede) {
            entry.abort?.abort();
            entry.overlap?.abort.abort();
            entry.overlap = undefined;
            stopDeploymentEnvironmentHealthObservationV1(entry);
        }
        const abort = new AbortController();
        entry.abort = abort;
        if (entry.projection.getSnapshot().value === null) entry.projection.publish({ status: 'loading', value: null, failure: null });
        const request = startRead(entry, abort);
        entry.request = request;
        return request;
    }
    function startRead(entry: Entry, abort: AbortController): Promise<void> {
        const current = () => !retired && !abort.signal.aborted && (entry.abort === abort || entry.overlap?.abort === abort);
        /** The newer read speaks for the record: an older one still running is abandoned, never published later. */
        const settle = () => {
            if (entry.overlap?.abort === abort) {
                entry.abort?.abort();
                entry.abort = abort;
                entry.request = entry.overlap.request;
                entry.overlap = undefined;
            }
        };
        const perform = async () => {
            try {
                const response = await entry.resource.read(abort.signal);
                if (!current()) return;
                // A failed older read says nothing while the newer one can still answer.
                if (!response.ok && entry.abort === abort && entry.overlap) return;
                settle();
                if (!response.ok) { fail(entry, response.failure); return; }
                let value: unknown;
                try { value = entry.resource.admit(response.value); }
                catch { fail(entry, invalidResponse); return; }
                publishValue(entry, value);
            } catch {
                if (!current() || (entry.abort === abort && entry.overlap)) return;
                settle();
                fail(entry, unavailable);
            }
        };
        return perform().finally(() => {
            if (entry.abort !== abort) return;
            // The newer read that was overlapping this one now owns the record.
            if (entry.overlap) { entry.abort = entry.overlap.abort; entry.request = entry.overlap.request; entry.overlap = undefined; return; }
            entry.abort = undefined; entry.request = undefined;
            if (entry.rereadWhenSettled) { entry.rereadWhenSettled = false; void refresh(entry); }
        });
    }
    /**
     * A wake says something may have changed, not that the read in flight is wrong. Aborting it let wakes arriving
     * faster than a read completes (a reconnecting socket, QA #60/#62) keep a page on Loading or a stale value. So a
     * wake starts one newer read beside it: whichever settles first publishes, and a stalled older read cannot hold
     * recovery back or speak after the newer one. Further wakes coalesce into one re-read when those settle.
     */
    function revalidate(entry: Entry): Promise<void> {
        if (!active(entry)) return Promise.resolve();
        if (!entry.request) return refresh(entry);
        if (entry.overlap) { entry.rereadWhenSettled = true; return entry.overlap.request; }
        const abort = new AbortController();
        const overlap: NonNullable<Entry['overlap']> = { abort, request: Promise.resolve() };
        entry.overlap = overlap;
        overlap.request = startRead(entry, abort);
        return overlap.request;
    }
    function acquire<T>(resource: Resource, initialDemand: DeploymentReadDemandV1, consumeHealth = false): DeploymentReadLeaseV1<T> {
        let entry = entries.get(resource.key);
        if (!entry) {
            entry = { resource, projection: createDeploymentProjectionV1(), demands: new Set(), abort: undefined, request: undefined,
                healthObservation: undefined,
                nextCursor: null, dirty: true, overlap: undefined, rereadWhenSettled: false };
            entries.set(resource.key, entry);
        }
        const held = entry;
        const wasActive = active(held);
        const demand = { current: { ...initialDemand }, consumeHealth };
        const subscriptions = new Map<() => void, () => void>();
        let released = false;
        held.demands.add(demand);
        if (retired) held.projection.publish(retiredSnapshot);
        // Changes arrive as pushed hints (invalidate/refreshDemanded mark the record dirty), so returning to a clean ready
        // record reads nothing (QA #65: each detail return repeated the held receipt's GET).
        else if (active(held) && ((!wasActive && (held.dirty || held.projection.getSnapshot().status !== 'ready'))
            || held.projection.getSnapshot().status === 'idle')) void refresh(held);
        syncHealthObservation(held, wasActive);
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
                syncHealthObservation(held, entryWasActive);
                if (!active(held)) pauseRead(held);
                else if (!wasActive && isDeploymentReadDemandActiveV1(next)) {
                    // Deliver the current shared value when presentation resumes,
                    // even if the following read returns an equal ready snapshot.
                    for (const listener of subscriptions.values()) listener();
                    if ((!entryWasActive && (held.dirty || held.projection.getSnapshot().status !== 'ready'))
                        || held.projection.getSnapshot().status === 'idle') void refresh(held);
                }
            },
            release() {
                if (released) return;
                const entryWasActive = active(held);
                released = true;
                for (const unsubscribe of subscriptions.keys()) unsubscribe();
                subscriptions.clear();
                held.demands.delete(demand);
                syncHealthObservation(held, entryWasActive);
                // Records stay with this Home/Source controller so a remount shows the admitted value while it
                // re-reads (QA #63, #64). A retained receipt only adds to member versions, which take the newest first.
                if (!active(held)) pauseRead(held);
            },
        };
    }
    /** An Environment holds databases when its definition declares data services (the Databases page's rows). */
    const holdsDatabases = (item: DeploymentDataServiceReadPageV1['items'][number]) => (item.content.template?.data?.length ?? 0) > 0;
    function acquireAccountPage<T extends DeploymentAccountDomainReadPageV1 | DeploymentDataServiceReadPageV1>(
        kind: 'domainPage' | 'dataServicePage', query: DeploymentDataServiceQueryV1, demand: DeploymentReadDemandV1,
    ) {
        const key = (cursor: string | undefined) => JSON.stringify([kind, cursor ?? null, query.limit ?? null, query.environmentId ?? null]);
        return createDeploymentReadPageLease<T>({ initialCursor: query.cursor, demand,
            nextCursor: cursor => entries.get(key(cursor))?.nextCursor ?? null,
            acquire: (cursor, pageDemand) => acquire<T>({ key: key(cursor), kind, previousPage: cursor !== undefined,
                read: async signal => {
                    const unavailable = { ok: false as const,
                        failure: withActionFailureDiagnostic({ code: 'deployment_unavailable', retryable: false },
                            { phase: `deployment.read.${kind}`, causeKind: 'client_required' }) };
                    if (kind === 'domainPage') return await transport.listDomainPage?.(scope, { ...query, cursor }, { signal }) ?? unavailable;
                    const read = transport.listDataServicePage;
                    if (!read) return unavailable;
                    const prior = entries.get(key(cursor))?.projection.getSnapshot().value as DeploymentDataServiceReadPageV1 | undefined;
                    if (query.environmentId !== undefined) return read(scope, query, { signal, ...(prior ? { previousItems: prior.items } : {}) });
                    // The Databases page lists the Environments that hold databases. Their contents are end-to-end
                    // encrypted, so the Home pages every Environment: a page of none is read past here, and a page is
                    // empty only when no Environment after it holds one (owner D3, 11-16).
                    let at = cursor;
                    let partial = false;
                    for (;;) {
                        const result = await read(scope, { ...query, cursor: at }, { signal, ...(prior ? { previousItems: prior.items } : {}) });
                        if (!result.ok) return result;
                        partial ||= result.value.coverage === 'partial';
                        const items = result.value.items.filter(holdsDatabases);
                        if (items.length > 0 || result.value.nextCursor === null) {
                            return { ...result, value: { ...result.value, items, ...(partial ? { coverage: 'partial' as const } : {}) } };
                        }
                        at = result.value.nextCursor;
                    }
                },
                // Typed host transport owns wire and opened Artifact admission.
                admit: value => value,
            }, pageDemand) });
    }
    const controller: DeploymentReadControllerV1 = {
        scope,
        acquireDomainPage: (query, demand) => acquireAccountPage<DeploymentAccountDomainReadPageV1>('domainPage', query, demand),
        acquireDataServicePage: (query, demand) => acquireAccountPage<DeploymentDataServiceReadPageV1>('dataServicePage', query, demand),
        acquireDomains(environmentId, query, demand) {
            const key = (cursor: string | undefined) => JSON.stringify(['domains', environmentId, cursor ?? null]);
            return createDeploymentReadPageLease<DeploymentDomainReadPageV1>({ initialCursor: query.cursor, demand,
                nextCursor: cursor => entries.get(key(cursor))?.nextCursor ?? null,
                acquire: (cursor, pageDemand) => acquire<DeploymentDomainReadPageV1>({
                    key: key(cursor), kind: 'domains', environmentId, previousPage: cursor !== undefined,
                    read: signal => transport.listDomains?.(scope, environmentId, cursor === undefined ? {} : { cursor }, { signal })
                        ?? Promise.resolve({ ok: false, failure: withActionFailureDiagnostic({ code: 'deployment_unavailable', retryable: false },
                            { phase: 'deployment.read.domains', causeKind: 'client_required' }) }),
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
            const key = (cursor: string | undefined, option?: 'includeTotal') => JSON.stringify(['collection', cursor ?? null,
                filters.machineId ?? null, environmentIds ?? null, filters.previewRepositoryId ?? null, previewPullRequestIds ?? null,
                filters.previewTemplateEnvironmentId ?? null, filters.previewRepository ?? null, filters.allPages ?? false, filters.limit ?? null,
                filters.includeDeleted ?? false, filters.includeTotal ?? option ?? false]);
            return createDeploymentReadPageLease<DeploymentEnvironmentReadCollectionV1, 'includeTotal'>({
                initialCursor, demand,
                nextCursor: (cursor, option) => entries.get(key(cursor, option))?.nextCursor ?? null,
                acquire: (cursor, pageDemand, option) => {
                    // A navigation opt-in applies to the visible continuation read once. Push reconciliation
                    // can run after the count line is hidden, so it follows the collection's ordinary query.
                    let includeTotalOnRead = option === 'includeTotal';
                    return acquire<DeploymentEnvironmentReadCollectionV1>({
                        key: key(cursor, option), kind: 'collection',
                        ...(environmentIds === undefined ? {} : { environmentIds: new Set(environmentIds) }), previousPage: cursor !== undefined,
                        read(signal) {
                            const includeTotal = includeTotalOnRead || filters.includeTotal;
                            includeTotalOnRead = false;
                            return transport.listEnvironments(scope, { ...filters,
                                ...(includeTotal ? { includeTotal } : {}),
                                ...(environmentIds === undefined ? {} : { environmentIds }),
                                ...(previewPullRequestIds === undefined ? {} : { previewPullRequestIds }),
                                ...(cursor === undefined ? {} : { cursor }) }, { signal });
                        },
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
                    }, pageDemand);
                },
            });
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
                    failure: withActionFailureDiagnostic({ code: 'deployment_unavailable', retryable: false },
                        { phase: 'deployment.read.activity', causeKind: 'client_required' }) }),
                admit: value => value,
            }, demand);
        },
        acquireHistory(environmentId, query, demand) {
            const { cursor: initialCursor, ...filters } = query;
            const key = (cursor: string | undefined) => JSON.stringify(['history', environmentId,
                query.state ?? null, query.actorAccountId ?? null, query.operation ?? null,
                query.requestedAtFromMs ?? null, query.requestedAtToMs ?? null, cursor ?? null]);
            return createDeploymentReadPageLease<DeploymentHistoryPageV1>({ initialCursor, demand,
                nextCursor: cursor => entries.get(key(cursor))?.nextCursor ?? null,
                acquire: (cursor, pageDemand) => acquire<DeploymentHistoryPageV1>({
                key: key(cursor), kind: 'history', environmentId, previousPage: cursor !== undefined,
                read: signal => transport.listHistory(scope, environmentId,
                    { ...filters, ...(cursor === undefined ? {} : { cursor }) }, { signal }),
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
                    : hint.activityChanged === true ? false : resource.kind === 'domainPage' || resource.kind === 'dataServicePage' ? true : resource.kind === 'collection'
                    ? resource.environmentIds !== undefined
                        ? hint.deploymentId === undefined && resource.environmentIds.has(hint.environmentId)
                        : hint.deploymentId === undefined || collection === null || collection.items.some(row => row.environment.id === hint.environmentId)
                    : resource.environmentId === hint.environmentId && (hint.deploymentId === undefined
                        ? resource.kind === 'environment' || resource.kind === 'domains'
                        : resource.kind === 'history' || (resource.kind === 'receipt' && resource.deploymentId === hint.deploymentId)));
                if (affected) { entry.dirty = true; void revalidate(entry); }
            }
        },
        invalidateSavedSecrets(resourceIds) {
            if (retired) return;
            const ids = resourceIds === undefined ? undefined : new Set(resourceIds);
            for (const entry of entries.values()) {
                if (entry.resource.kind !== 'environment') continue;
                const detail = entry.projection.getSnapshot().value as DeploymentEnvironmentDetailV1 | null;
                // An initial read has no binding evidence yet; its existing demand still owns reconciliation.
                if (detail && !detail.content.bindings.some(binding => {
                    if (binding.source.kind !== 'secret') return false;
                    const reference = parseSavedSecretRefV1(binding.source.ref);
                    return reference.kind === 'shared_resource' && (ids === undefined || ids.has(reference.resourceId));
                })) continue;
                entry.dirty = true;
                void revalidate(entry);
            }
        },
        refreshDemanded: () => Promise.all([...entries.values()].map(entry => {
            entry.dirty = true;
            return revalidate(entry);
        })).then(() => {}),
        retire() {
            if (retired) return;
            retired = true;
            for (const entry of entries.values()) {
                stopRead(entry);
                stopDeploymentEnvironmentHealthObservationV1(entry);
                entry.projection.publish(retiredSnapshot);
            }
        },
    };
    return controller;
}
