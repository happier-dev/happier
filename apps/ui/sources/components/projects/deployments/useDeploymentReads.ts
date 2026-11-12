import * as React from 'react';
import type { DeploymentUiRollbackInput } from './deploymentActions';
import type { DeploymentEnvironmentCollectionV1, DeploymentPreMigrationBackupV1 } from '@happier-dev/deployment-protocol/v1';
import { useRegistryAppUpdate } from '@/registries/useRegistryUpdateCheck';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useEnvironmentHealthNotices } from './useEnvironmentHealthNotices';
import { selectDeploymentReceiptRetainedHistoryV1 } from '@happier-dev/deployments';
import type {
    DeploymentReadControllerV1, DeploymentReadDemandV1, DeploymentReadLeaseV1, DeploymentReadSnapshotV1,
    DeploymentReadPageFactsV1, DeploymentReadPageLeaseV1,
    DeploymentCollectionQueryV1, DeploymentHistoryQueryV1,
    DeploymentEnvironmentHealthMemberV1,
} from '@happier-dev/deployments';

const IDLE = Object.freeze({ status: 'idle' as const, value: null, failure: null });
const INACTIVE = Object.freeze({ mounted: false, visible: false, focused: false });
const NO_TAB_ITEMS: readonly never[] = Object.freeze([]);

/** Presentation states consume the controller's decision; they never authorize a read. */
export type DeploymentEnvironmentTabResult<T> = Readonly<{ items: readonly T[] }> & (
    | Readonly<{ status: 'loading' | 'ready' | 'empty' }>
    | Readonly<{ status: 'unavailable'; reason: string; retryable: boolean; retry(): Promise<void> }>
    | Readonly<{ status: 'denied' }>
);

export function projectDeploymentEnvironmentTabResult<T>(snapshot: Pick<DeploymentReadSnapshotV1<unknown>, 'status' | 'failure'>,
    items: readonly T[], retry: () => Promise<void>, coverage?: DeploymentEnvironmentCollectionV1['coverage']): DeploymentEnvironmentTabResult<T> {
    if (snapshot.status === 'unavailable') {
        if (snapshot.failure?.code === 'deployment_access_denied') return { status: 'denied', items: NO_TAB_ITEMS };
        return { status: 'unavailable', items, reason: snapshot.failure?.code ?? 'deployment_unavailable',
            retryable: snapshot.failure?.retryable ?? false, retry };
    }
    if (snapshot.status !== 'ready') return { status: 'loading', items };
    if (coverage === 'partial') return { status: 'unavailable', items, reason: 'deployment_content_unavailable',
        retryable: true, retry };
    return { status: items.length ? 'ready' : 'empty', items };
}

/** The controller spends private continuation state only for explicit navigation intent. */
function useDeploymentPage<T extends DeploymentReadPageFactsV1>(
    acquire: (() => DeploymentReadPageLeaseV1<T>) | null, demand: DeploymentReadDemandV1,
) {
    const lease = useDeploymentLeaseBinding(acquire);
    const read = useDeploymentSnapshot<T>(lease, demand);
    const nextPage = React.useCallback(() => lease?.nextPage(), [lease]);
    const previousPage = React.useCallback(() => lease?.previousPage(), [lease]);
    return { ...read, hasNextPage: read.snapshot.status === 'ready' && (read.snapshot.value?.hasNextPage ?? false),
        hasPreviousPage: read.snapshot.value?.hasPreviousPage ?? false, nextPage, previousPage };
}

function useDeploymentLeaseBinding<L extends DeploymentReadLeaseV1<unknown>>(acquire: (() => L) | null) {
    const [binding, setBinding] = React.useState<Readonly<{
        acquire: typeof acquire; lease: L | null;
    }> | null>(null);
    // Acquire only after commit: abandoned/StrictMode renders own no demand.
    React.useEffect(() => {
        const lease = acquire?.() ?? null;
        setBinding({ acquire, lease });
        return () => { lease?.release(); };
    }, [acquire]);
    // A changed resource cannot briefly disclose the previous resource's body.
    return binding?.acquire === acquire ? binding.lease : null;
}

/** React owns presentation demand; the shared controller owns all records and reads. */
function useDeploymentSnapshot<T>(lease: DeploymentReadLeaseV1<T> | null, demand: DeploymentReadDemandV1) {
    React.useEffect(() => {
        lease?.setDemand({ mounted: demand.mounted, visible: demand.visible, focused: demand.focused });
        return () => { lease?.setDemand(INACTIVE); };
    }, [lease, demand.mounted, demand.visible, demand.focused]);
    const subscribe = React.useCallback((listener: () => void) => lease?.subscribe(listener) ?? (() => {}), [lease]);
    const getSnapshot = React.useCallback((): DeploymentReadSnapshotV1<T> => lease?.getSnapshot() ?? IDLE, [lease]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const refresh = React.useCallback(() => lease?.refresh({ supersede: true }) ?? Promise.resolve(), [lease]);
    return { snapshot, refresh };
}

function useDeploymentLease<T>(acquire: (() => DeploymentReadLeaseV1<T>) | null, demand: DeploymentReadDemandV1) {
    return useDeploymentSnapshot(useDeploymentLeaseBinding(acquire), demand);
}

export function useDeploymentCollection(controller: DeploymentReadControllerV1 | null, demand: DeploymentReadDemandV1,
    query: DeploymentCollectionQueryV1 = {}) {
    const environmentIds = query.environmentIds === undefined ? undefined : [...new Set(query.environmentIds)].sort();
    const environmentIdsKey = JSON.stringify(environmentIds);
    const previewPullRequestIds = query.previewPullRequestIds === undefined ? undefined : [...new Set(query.previewPullRequestIds)].sort();
    const previewPullRequestIdsKey = JSON.stringify(previewPullRequestIds);
    const acquire = React.useMemo(() => controller ? () =>
        controller.acquireCollection({ cursor: query.cursor, machineId: query.machineId, environmentIds,
            previewRepositoryId: query.previewRepositoryId, previewPullRequestIds,
            previewTemplateEnvironmentId: query.previewTemplateEnvironmentId }, INACTIVE) : null,
        // The canonical set key preserves the lease across equivalent inline vectors.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [controller, query.cursor, query.machineId, environmentIdsKey, query.previewRepositoryId, previewPullRequestIdsKey,
            query.previewTemplateEnvironmentId]);
    return useDeploymentPage(acquire, demand);
}

/** Navigation consumes the owner's stable summary, never folds receipt rows itself. */
export function useDeploymentActivity(controller: DeploymentReadControllerV1 | null, demand: DeploymentReadDemandV1) {
    const acquire = React.useMemo(() => controller ? () => controller.acquireActivity(INACTIVE) : null, [controller]);
    return useDeploymentLease(acquire, demand);
}

export function useDeploymentChip(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    deploymentId: string | null, demand: DeploymentReadDemandV1) {
    const acquire = React.useMemo(() => controller && environmentId && deploymentId
        ? () => controller.acquireReceiptChip(environmentId, deploymentId, INACTIVE) : null,
    [controller, environmentId, deploymentId]);
    return useDeploymentLease(acquire, demand);
}

/** Input is a record from useSessionActionOperations; its domain ref is the requested deployment, not the Session's Project. */
export function useSessionDeploymentChip(controller: DeploymentReadControllerV1 | null,
    operation: ActionOperationProjection | null, demand: DeploymentReadDemandV1) {
    const reference = operation?.snapshot.domainRef;
    return useDeploymentChip(controller, reference?.kind === 'deployment' ? reference.environmentId : null,
        reference?.kind === 'deployment' ? reference.deploymentId : null, demand);
}

/** The Environment record alone, for consumers that only name it (an API token's grant). */
export function useDeploymentEnvironmentRecord(controller: DeploymentReadControllerV1 | null, environmentId: string | null, demand: DeploymentReadDemandV1) {
    return useEnvironmentRead(controller, environmentId, demand, false);
}

function useEnvironmentRead(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    demand: DeploymentReadDemandV1, health: boolean) {
    const acquire = React.useMemo(() => controller && environmentId
        ? () => controller.acquireEnvironment(environmentId, INACTIVE, { health }) : null,
    [controller, environmentId, health]);
    return useDeploymentLease(acquire, demand);
}

/** Names and retained captures consume the same exact record leases as detail pages. */
export type DeploymentReferenceResult<T> =
    | Readonly<{ status: 'loading'; value: null }>
    | Readonly<{ status: 'ready'; value: T }>
    | Readonly<{ status: 'unavailable'; value: T | null; reason: string; retryable: boolean }>;

export type DeploymentRetainedBackupSummary = Readonly<{
    deploymentId: string;
    targetLinkId: string;
    backupId: string;
    /** Native capture time is the retained label; snapshots have no user-authored name. */
    label: string;
    /** Historical evidence; prepare verifies that the native snapshot is still usable. */
    capture: DeploymentPreMigrationBackupV1;
}>;

function referenceResult<T>(snapshot: Pick<DeploymentReadSnapshotV1<unknown>, 'status' | 'failure'>,
    value: T | null, absentReason: string): DeploymentReferenceResult<T> {
    if (snapshot.status === 'unavailable') return { status: 'unavailable', value,
        reason: snapshot.failure?.code ?? 'deployment_unavailable', retryable: snapshot.failure?.retryable ?? false };
    if (snapshot.status !== 'ready') return { status: 'loading', value: null };
    return value === null ? { status: 'unavailable', value: null, reason: absentReason, retryable: false }
        : { status: 'ready', value };
}

/** No inventory, registry update check or health observation for an approval's name. */
export function useDeploymentEnvironmentName(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    demand: DeploymentReadDemandV1) {
    const read = useDeploymentEnvironmentRecord(controller, environmentId, demand);
    const result: DeploymentReferenceResult<string> = !controller || !environmentId
        ? { status: 'unavailable', value: null, reason: 'deployment_unavailable', retryable: false }
        : referenceResult(read.snapshot, read.snapshot.value?.content.name ?? null, 'deployment_unavailable');
    return { result, retry: read.refresh };
}

/** Receipt ids come from the existing Environment history page or the restore input.
 * An optional snapshot id selects that exact retained capture; no older receipt search.
 * After prepare, consume its source/destination/safetyBackup evidence directly. */
export function useEnvironmentBackupSummary(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    receiptId: string | null, demand: DeploymentReadDemandV1, backupId?: string | null) {
    const read = useReceiptRead(controller, environmentId, receiptId, demand);
    const receipt = read.snapshot.value;
    const capture = receipt?.content.ownServer?.preMigrationBackup;
    const summary: DeploymentRetainedBackupSummary | null = receipt && capture
        && (backupId == null || capture.source.snapshot.snapshotId === backupId)
        ? { deploymentId: receipt.deployment.id, targetLinkId: receipt.deployment.targetLinkId,
            backupId: capture.source.snapshot.snapshotId, label: capture.source.snapshot.time, capture } : null;
    const result: DeploymentReferenceResult<DeploymentRetainedBackupSummary> = !controller || !environmentId || !receiptId
        ? { status: 'unavailable', value: null, reason: 'backup_receipt_required', retryable: false }
        : referenceResult(read.snapshot, summary, 'backup_required');
    return { result, retry: read.refresh };
}

/** Native current facts only. OPS-P50's unpublished monitor kinds are not inferred from notices. */
export function useDeploymentEnvironmentChecks(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    demand: DeploymentReadDemandV1) {
    const read = useEnvironmentRead(controller, environmentId, demand, true);
    const feed = read.snapshot.value?.healthFeed;
    const items = feed?.members ?? NO_TAB_ITEMS;
    let result: DeploymentEnvironmentTabResult<DeploymentEnvironmentHealthMemberV1>;
    if (read.snapshot.status !== 'ready') result = projectDeploymentEnvironmentTabResult(read.snapshot, items, read.refresh);
    else if (feed?.status === 'loading') result = { status: 'loading', items };
    else if (!feed || feed.status === 'partial' || feed.status === 'unavailable') {
        const failure = feed?.members.find(member => member.failure)?.failure;
        result = projectDeploymentEnvironmentTabResult({ status: 'unavailable', failure: failure ?? null }, items, read.refresh);
    } else result = projectDeploymentEnvironmentTabResult(read.snapshot, items, read.refresh);
    return { result, retry: read.refresh, feed: feed ?? null };
}

export function useDeploymentEnvironmentDomains(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    demand: DeploymentReadDemandV1, query: Readonly<{ cursor?: string }> = {}) {
    const acquire = React.useMemo(() => controller && environmentId
        ? () => controller.acquireDomains(environmentId, query, INACTIVE) : null,
    [controller, environmentId, query.cursor]);
    const read = useDeploymentPage(acquire, demand);
    return { ...read, result: projectDeploymentEnvironmentTabResult(read.snapshot, read.snapshot.value?.items ?? NO_TAB_ITEMS,
        read.refresh, read.snapshot.value?.coverage),
        retry: read.refresh };
}

/** Configuration belongs to the Environment; retained status belongs to the selected receipt. */
export function useDeploymentEnvironmentBackups(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    demand: DeploymentReadDemandV1, receiptId: string | null = null) {
    const read = useEnvironmentRead(controller, environmentId, demand, false);
    const retained = useEnvironmentBackupSummary(controller, environmentId, receiptId, demand);
    const backup = read.snapshot.value?.content.backup;
    const items = React.useMemo(() => backup === undefined ? NO_TAB_ITEMS : [backup], [backup]);
    const retry = React.useCallback(() => Promise.all([read.refresh(), retained.retry()]).then(() => {}),
        [read.refresh, retained.retry]);
    return { result: projectDeploymentEnvironmentTabResult(read.snapshot, items, retry), retry,
        statusRead: retained.result };
}

export function useDeploymentEnvironment(controller: DeploymentReadControllerV1 | null, environmentId: string | null, demand: DeploymentReadDemandV1) {
    const read = useEnvironmentRead(controller, environmentId, demand, true);
    const catalogUpdate = useRegistryAppUpdate(read.snapshot.value, demand.mounted && demand.visible && demand.focused);
    const healthNotices = useEnvironmentHealthNotices(controller?.scope ?? null, environmentId, read.snapshot, demand);
    return { ...read, catalogUpdate, healthFeed: read.snapshot.value?.healthFeed ?? null, healthNotices };
}

const NO_HISTORY_QUERY: DeploymentHistoryQueryV1 = Object.freeze({});

export function useDeploymentHistory(controller: DeploymentReadControllerV1 | null, environmentId: string | null, demand: DeploymentReadDemandV1,
    query: DeploymentHistoryQueryV1 = NO_HISTORY_QUERY) {
    const { cursor, state, actorAccountId, operation } = query;
    // The read owner applies the narrowing before paging; each distinct query is its own keyed page lease.
    const acquire = React.useMemo(() => controller && environmentId
        ? () => controller.acquireHistory(environmentId, { ...(cursor === undefined ? {} : { cursor }),
            ...(state === undefined ? {} : { state }), ...(actorAccountId === undefined ? {} : { actorAccountId }),
            ...(operation === undefined ? {} : { operation }) }, INACTIVE) : null,
    [controller, environmentId, cursor, state, actorAccountId, operation]);
    const read = useDeploymentPage(acquire, demand);
    return { ...read, result: projectDeploymentEnvironmentTabResult(read.snapshot, read.snapshot.value?.items ?? NO_TAB_ITEMS,
        read.refresh, read.snapshot.value?.coverage) };
}

function useReceiptRead(controller: DeploymentReadControllerV1 | null, environmentId: string | null, deploymentId: string | null,
    demand: DeploymentReadDemandV1) {
    const acquire = React.useMemo(() => controller && environmentId && deploymentId
        ? () => controller.acquireReceipt(environmentId, deploymentId, INACTIVE) : null,
    [controller, environmentId, deploymentId]);
    return useDeploymentLease(acquire, demand);
}

export function useDeploymentReceipt(controller: DeploymentReadControllerV1 | null, environmentId: string | null, deploymentId: string | null,
    demand: DeploymentReadDemandV1) {
    const read = useReceiptRead(controller, environmentId, deploymentId, demand);
    const environment = useEnvironmentRead(controller, environmentId, demand, true);
    const history = useDeploymentHistory(controller, deploymentId ? environmentId : null, demand);
    const detail = environment.snapshot.value;
    const runtime = detail?.runtimeTargetLink;
    const value = read.snapshot.value;
    const selection = React.useMemo(() => value && detail && runtime && history.snapshot.status === 'ready' && history.snapshot.value
        ? selectDeploymentReceiptRetainedHistoryV1({ receipt: value.deployment, items: history.snapshot.value.items,
            complete: !history.snapshot.value.hasNextPage && history.snapshot.value.coverage !== 'partial',
            runtime, targetLinks: detail.targetLinks.map(row => row.targetLink),
            retainPreviousDeployments: detail.content.retainPreviousDeployments }) : null,
    [value, detail, runtime, history.snapshot]);
    const snapshot = React.useMemo(() => !value ? read.snapshot : { ...read.snapshot, value: { ...value,
        facts: selection ? { ...value.facts, ...selection } : value.facts } }, [read.snapshot, value, selection]);
    return { ...read, snapshot, retainedHistory: history.snapshot, environmentSnapshot: environment.snapshot, healthFeed: detail?.healthFeed ?? null,
        refresh: React.useCallback(() => Promise.all([read.refresh(), environment.refresh(), history.refresh()]).then(() => {}),
            [read.refresh, environment.refresh, history.refresh]) };
}

export type EnvironmentRollbackMenuResult =
    | Readonly<{ status: 'idle' | 'loading' | 'empty' }>
    | Readonly<{ status: 'unavailable'; reason: string; retryable: boolean }>
    | Readonly<{ status: 'ready'; target: NonNullable<NonNullable<ReturnType<typeof useDeploymentReceipt>['snapshot']['value']>['facts']['retainedRollbackTarget']>;
        input: DeploymentUiRollbackInput }>;

/** Menus share the receipt owner's retained target. Closed menus acquire no record or history leases.
 * Submit the returned operands through the existing rollback Action/review/receipt lifecycle. */
export function useEnvironmentRollbackMenu(controller: DeploymentReadControllerV1 | null, environmentId: string | null,
    receiptId: string | null, open: boolean) {
    const read = useDeploymentReceipt(open ? controller : null, open ? environmentId : null, open ? receiptId : null,
        open ? { mounted: true, visible: true, focused: true } : INACTIVE);
    let result: EnvironmentRollbackMenuResult;
    const failed = [read.snapshot, read.environmentSnapshot, read.retainedHistory].find(snapshot => snapshot.status === 'unavailable');
    if (!open) result = { status: 'idle' };
    else if (!environmentId || !receiptId) result = { status: 'empty' };
    else if (failed) result = { status: 'unavailable', reason: failed.failure?.code ?? 'deployment_unavailable',
        retryable: failed.failure?.retryable ?? false };
    else if (read.snapshot.status !== 'ready' || read.environmentSnapshot.status !== 'ready' || read.retainedHistory.status !== 'ready') result = { status: 'loading' };
    else {
        const facts = read.snapshot.value?.facts;
        const target = facts?.retainedRollbackTarget;
        result = target ? { status: 'ready', target, input: { environmentId, deploymentId: target.deploymentId } }
            : facts?.retainedPreviousCount === null ? { status: 'unavailable', reason: 'deployment_content_unavailable', retryable: true }
                : { status: 'empty' };
    }
    return { result, retry: read.refresh };
}
