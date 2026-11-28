import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentHeaderV1, DeploymentReceiptHistoryV1 } from '@happier-dev/deployments/contracts/v1';
import type { ActionOperationListV2Request, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentActivityItemV1, DeploymentActivityPageV1, DeploymentActivityQueryV1, DeploymentActivityCursorV1 } from '@happier-dev/protocol/deployments/deploymentActivityPageV1';
import type { DeploymentReadScopeV1 } from '../controller/deploymentReadControllerTypes.js';
import { DeploymentActivityQueryV1Schema } from '@happier-dev/protocol/deployments/deploymentActivityPageV1';
import { isDeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null; coverage?: 'complete' | 'partial' }>;
type Receipt = DeploymentReceiptHistoryV1['items'][number];
export type DeploymentActivityReadOwnersV1 = Readonly<{
    listEnvironments(cursor?: string): Promise<Page<DeploymentEnvironmentHeaderV1>>;
    listReceipts(environmentId: string, cursor?: string,
        filters?: Pick<DeploymentActivityQueryV1, 'actorAccountId' | 'requestedAtFromMs' | 'requestedAtToMs'>): Promise<Page<Receipt>>;
    listOperations(machineId: string, cursor?: string,
        filters?: Pick<ActionOperationListV2Request, 'actorAccountId' | 'createdAtFromMs' | 'createdAtToMs'>): Promise<Page<ActionOperationSnapshotV1>>;
}>;
export type { DeploymentActivityItemV1, DeploymentActivityPageV1 } from '@happier-dev/protocol/deployments/deploymentActivityPageV1';
/** Receipts use their existing newest-request-first order; operation lists may be active-first.
 * No background work: the host invokes this read on demand or its existing typed push. */
export async function readDeploymentActivityPageV1(input: Readonly<{
    scope: DeploymentReadScopeV1; owners: DeploymentActivityReadOwnersV1;
    machineIds: readonly string[]; query: DeploymentActivityQueryV1; signal?: AbortSignal;
}>): Promise<DeploymentActivityPageV1> {
    const { scope, owners, signal } = input;
    const query = DeploymentActivityQueryV1Schema.parse(input.query);
    const receiptFilters = { actorAccountId: query.actorAccountId,
        requestedAtFromMs: query.requestedAtFromMs, requestedAtToMs: query.requestedAtToMs };
    const operationFilters = { actorAccountId: query.actorAccountId,
        createdAtFromMs: query.requestedAtFromMs, createdAtToMs: query.requestedAtToMs };
    const items: DeploymentActivityItemV1[] = [];
    const unavailableSources: Array<DeploymentActivityPageV1['unavailableSources'][number]> = [];
    let partial = false;
    let more = false;
    const after = (row: DeploymentActivityCursorV1) => !query.cursor
        || row.requestedAtMs < query.cursor.requestedAtMs
        || row.requestedAtMs === query.cursor.requestedAtMs && row.id < query.cursor.id;
    const failed = (kind: 'environment' | 'machine', id: string, error: unknown) => {
        signal?.throwIfAborted();
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : error instanceof Error ? error.name : 'Error';
        unavailableSources.push({ kind, id, code });
        partial = true;
    };
    const environments = new Map<string, DeploymentEnvironmentHeaderV1>();
    const representedOperations = new Set<string>();
    let cursor: string | undefined;
    do {
        signal?.throwIfAborted();
        // A failed discovery cannot claim an empty history: it propagates to the host read state.
        const page = await owners.listEnvironments(cursor);
        partial ||= page.coverage === 'partial';
        for (const environment of page.items) {
            if ((scope.projectSourceId === undefined || environment.projectSourceId === scope.projectSourceId)
                && (query.projectSourceId === undefined || environment.projectSourceId === query.projectSourceId)
                && (query.environmentId === undefined || environment.id === query.environmentId)) environments.set(environment.id, environment);
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    // Each stream contributes at most one visible page; deeper receipt pages are read only as needed.
    await Promise.all([...environments.values()].map(async environment => {
        let cursor: string | undefined;
        let count = 0;
        try {
            do {
                signal?.throwIfAborted();
                const page = await owners.listReceipts(environment.id, cursor, receiptFilters);
                partial ||= page.coverage === 'partial';
                for (const receipt of page.items) {
                    representedOperations.add(receipt.actionOperationId);
                    if (query.kind === 'operation') continue;
                    const row = { id: `receipt:${receipt.id}`, requestedAtMs: receipt.requestedAtMs,
                        kind: 'receipt' as const, environment, receipt };
                    if (!after(row)) continue;
                    if (query.machineId) {
                        if (!receipt.machineIds) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_content_unavailable', error: 'deployment_content_unavailable' });
                        if (!receipt.machineIds.includes(query.machineId)) continue;
                    }
                    if (count === query.limit) { more = true; break; }
                    items.push(row);
                    count++;
                }
                // Operation-only reads use one receipt page for invocation dedupe,
                // without making receipt continuation part of their output demand.
                if (query.kind === 'operation') break;
                cursor = page.nextCursor ?? undefined;
                if (count === query.limit) { more ||= cursor !== undefined; break; }
            } while (cursor);
        } catch (error) { failed('environment', environment.id, error); }
    }));
    const machineIds = query.kind === 'receipt' ? [] : query.machineId ? [query.machineId] : [...new Set(input.machineIds)];
    await Promise.all(machineIds.map(async machineId => {
        let cursor: string | undefined;
        try {
            do {
                signal?.throwIfAborted();
                const page = await owners.listOperations(machineId, cursor, operationFilters);
                partial ||= page.coverage === 'partial';
                for (const operation of page.items) {
                    if (operation.scope.accountId !== scope.accountId || operation.scope.machineId !== machineId) continue;
                    const domain = operation.domainRef;
                    // A receipt represents its recorded invocation, not every operation
                    // that later refers to it (a repeated teardown may reuse the receipt).
                    if (representedOperations.has(operation.operationId)) continue;
                    const environmentId = domain?.kind === 'deploymentTargetLink' || domain?.kind === 'deployment'
                        ? domain.environmentId : undefined;
                    if (query.environmentId || query.projectSourceId || scope.projectSourceId) {
                        if (!environmentId || !environments.has(environmentId)) continue;
                    }
                    if (!operation.actionId.startsWith('machines.') && !isDeploymentActionIdV1(operation.actionId)) continue;
                    const row = { id: `operation:${machineId}:${operation.operationId}`, requestedAtMs: operation.createdAt,
                        kind: 'operation' as const, operation };
                    if (after(row)) items.push(row);
                }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
        } catch (error) { failed('machine', machineId, error); }
    }));
    signal?.throwIfAborted();
    items.sort((a, b) => b.requestedAtMs - a.requestedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    return { items: page, nextCursor: last && (more || items.length > query.limit)
        ? { requestedAtMs: last.requestedAtMs, id: last.id } : null,
        coverage: partial ? 'partial' : 'complete', unavailableSources };
}
