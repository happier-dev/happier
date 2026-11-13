import { readDeploymentActivityPageV1 } from '@happier-dev/deployments';
import { DeploymentEnvironmentCollectionV1Schema,
    DeploymentReceiptHistoryV1Schema } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentActivityQueryV1 } from '@happier-dev/protocol/deployments/deploymentActivityPageV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { listActionOperations } from '@/sync/ops/actionOperations';
import { createDeploymentReadTransport } from './deploymentReadTransport';

/** One finite history read for Services, Project and Machine; presentation owns its existing push demand.
 * machineIds is the mounted host's authenticated Machine inventory, never another discovery registry. */
export async function readDeploymentActivityPage(lifetime: ServerAccountScopeLifetime,
    query: DeploymentActivityQueryV1, machineIds: readonly string[], options: Readonly<{ signal: AbortSignal }>) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    const retirement = lifetime.onRetire(cancel);
    const readOptions = { signal: controller.signal };
    const transport = createDeploymentReadTransport(lifetime);
    const scope = { ...lifetime.scope, projectSourceId: query.projectSourceId };
    const unwrap = <T>(result: { ok: true; value: T } | { ok: false; failure: { code: string } }): T => {
        if (!result.ok) throw Object.assign(new Error(result.failure.code), { code: result.failure.code });
        return result.value;
    };
    try {
        if (!lifetime.isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        const page = await readDeploymentActivityPageV1({ scope, query, machineIds, signal: controller.signal, owners: {
            async listEnvironments(cursor) {
                const page = DeploymentEnvironmentCollectionV1Schema.parse(unwrap(await transport.listEnvironments(scope,
                    { cursor, ...(query.environmentId ? { environmentIds: [query.environmentId] } : {}) }, readOptions)));
                return { ...page, items: page.items.map(item => item.environment) };
            },
            async listReceipts(environmentId, cursor) {
                return DeploymentReceiptHistoryV1Schema.parse(unwrap(await transport.listHistory(scope, environmentId, { cursor }, readOptions)));
            },
            async listOperations(machineId, cursor) {
                return listActionOperations({ ...lifetime.scope, machineId, request: { cursor },
                    requireCurrentDomainFacts: true, signal: controller.signal });
            },
        } });
        controller.signal.throwIfAborted();
        if (!lifetime.isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        return page;
    } finally {
        retirement.dispose();
        options.signal.removeEventListener('abort', cancel);
    }
}
