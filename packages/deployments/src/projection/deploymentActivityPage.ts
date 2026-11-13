import type { DeploymentEnvironmentHeaderV1, DeploymentReceiptHistoryV1 } from '@happier-dev/deployment-protocol/v1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DeploymentActivityQueryV1, DeploymentActivityCursorV1 } from '@happier-dev/protocol/deployments/deploymentActivityPageV1';
import type { DeploymentReadScopeV1 } from '../controller/deploymentReadControllerTypes.js';
import { DeploymentActivityQueryV1Schema } from '@happier-dev/protocol/deployments/deploymentActivityPageV1';
import { isDeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null; coverage?: 'complete' | 'partial' }>;
type Receipt = DeploymentReceiptHistoryV1['items'][number];
export type DeploymentActivityReadOwnersV1 = Readonly<{
    listEnvironments(cursor?: string): Promise<Page<DeploymentEnvironmentHeaderV1>>;
    listReceipts(environmentId: string, cursor?: string): Promise<Page<Receipt>>;
    listOperations(machineId: string, cursor?: string): Promise<Page<ActionOperationSnapshotV1>>;
}>;
export type DeploymentActivityItemV1 = Readonly<{ id: string; requestedAtMs: number }> & (
    | Readonly<{ kind: 'receipt'; environment: DeploymentEnvironmentHeaderV1; receipt: Receipt }>
    | Readonly<{ kind: 'operation'; operation: ActionOperationSnapshotV1 }>
);
export type DeploymentActivityPageV1 = Readonly<{
    items: readonly DeploymentActivityItemV1[];
    nextCursor: DeploymentActivityCursorV1 | null;
    coverage: 'complete' | 'partial';
    unavailableSources: readonly Readonly<{ kind: 'environment' | 'machine'; id: string; code: string }>[];
}>;
/** Receipts use their existing newest-request-first order; operation lists may be active-first.
 * No background work: the host invokes this read on demand or its existing typed push. */
export async function readDeploymentActivityPageV1(input: Readonly<{
    scope: DeploymentReadScopeV1; owners: DeploymentActivityReadOwnersV1;
    machineIds: readonly string[]; query: DeploymentActivityQueryV1; signal?: AbortSignal;
}>): Promise<DeploymentActivityPageV1> {
    const { scope, owners, signal } = input;
    const query = DeploymentActivityQueryV1Schema.parse(input.query);
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
                const page = await owners.listReceipts(environment.id, cursor);
                partial ||= page.coverage === 'partial';
                for (const receipt of page.items) {
                    representedOperations.add(receipt.actionOperationId);
                    const row = { id: `receipt:${receipt.id}`, requestedAtMs: receipt.requestedAtMs,
                        kind: 'receipt' as const, environment, receipt };
                    if (!after(row)) continue;
                    if (query.machineId) {
                        if (!receipt.machineIds) throw Object.assign(new Error('deployment_content_unavailable'), { code: 'deployment_content_unavailable' });
                        if (!receipt.machineIds.includes(query.machineId)) continue;
                    }
                    if (count === query.limit) { more = true; break; }
                    items.push(row);
                    count++;
                }
                cursor = page.nextCursor ?? undefined;
                if (count === query.limit) { more ||= cursor !== undefined; break; }
            } while (cursor);
        } catch (error) { failed('environment', environment.id, error); }
    }));
    const machineIds = query.machineId ? [query.machineId] : [...new Set(input.machineIds)];
    await Promise.all(machineIds.map(async machineId => {
        let cursor: string | undefined;
        try {
            do {
                signal?.throwIfAborted();
                const page = await owners.listOperations(machineId, cursor);
                partial ||= page.coverage === 'partial';
                for (const operation of page.items) {
                    if (operation.scope.accountId !== scope.accountId || operation.scope.machineId !== machineId) continue;
                    const domain = operation.domainRef;
                    // The deployment receipt is the canonical history for this same invocation.
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
