import {
    DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema,
    DeploymentReceiptGetResultV1Schema, DeploymentReceiptListResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    readDeploymentEnvironmentArtifactHeaderV1, readDeploymentEnvironmentArtifactV1, readDeploymentReceiptArtifactHeaderV1,
    readDeploymentReceiptArtifactV1,
    type DeploymentArtifactHeaderV1,
} from '@happier-dev/deployment-protocol/v1';
import type {
    DeploymentReadTransportV1, DeploymentReadScopeV1, DeploymentReadOptionsV1, DeploymentReadResultV1,
} from '@happier-dev/deployments';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { projectDeploymentReceiptHistoryEntryV1 } from '@happier-dev/deployments';

function failure(code: string, retryable = false): Extract<DeploymentReadResultV1<never>, { ok: false }> {
    return { ok: false, failure: { code, retryable } };
}

/** The shared controller consumes the existing Action and mode-aware Account Artifact owners. */
export function createDeploymentReadTransport(lifetime: ServerAccountScopeLifetime): DeploymentReadTransportV1 {
    const execute = createFrontDoorUiActionExecutor(undefined, {
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    });
    async function scoped<T>(scope: DeploymentReadScopeV1, options: DeploymentReadOptionsV1,
        read: (account: LazyActionAccountContext) => Promise<DeploymentReadResultV1<T>>): Promise<DeploymentReadResultV1<T>> {
        let account: LazyActionAccountContext | undefined;
        const current = () => lifetime.isCurrent() && scope.accountId === lifetime.scope.accountId
            && areServerProfileIdentifiersEquivalent(scope.serverId, lifetime.scope.serverId);
        try {
            if (!current()) return failure('action_account_scope_changed');
            options.signal.throwIfAborted();
            account = await captureLazyActionAccountContext(lifetime.scope.serverId, options.signal);
            if (!current() || account.accountId !== lifetime.scope.accountId) return failure('action_account_scope_changed');
            const result = await read(account);
            if (!current()) return failure('action_account_scope_changed');
            account.assertCurrent();
            options.signal.throwIfAborted();
            return result;
        } catch (error) {
            if (!current()) return failure('action_account_scope_changed');
            if (options.signal.aborted) return failure('cancelled');
            if (error instanceof HappyError) return failure(error.code ?? 'deployment_read_failed', error.canTryAgain);
            if (error instanceof Error && 'code' in error && typeof error.code === 'string') return failure(error.code);
            return failure('deployment_read_failed', true);
        } finally { account?.dispose(); }
    }
    const home = { serverId: lifetime.scope.serverId };
    return {
        // [] is internal zero demand, never serialized as an omitted selector.
        // Public Actions require a nonempty exact vector; All omits it.
        listEnvironments: (scope, query, options) => query.environmentIds?.length === 0 || query.previewPullRequestIds?.length === 0
            ? Promise.resolve({ ok: true, value: { items: [], nextCursor: null } })
            : scoped(scope, options, async account => {
            const parsed = DeploymentEnvironmentListResultV1Schema.safeParse(await execute('deployments.environments.list',
                { ...home, projectSourceId: scope.projectSourceId, ...query }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const page = parsed.data;
            if (!page.ok) return failure(page.error);
            const requestedEnvironmentIds = query.environmentIds === undefined ? undefined : new Set(query.environmentIds);
            if (!page.items.every(row => (scope.projectSourceId === undefined || row.projectSourceId === scope.projectSourceId)
                && (requestedEnvironmentIds === undefined || requestedEnvironmentIds.has(row.id))
                && areServerProfileIdentifiersEquivalent(row.serverId, lifetime.scope.serverId))) return failure('invalid_response');
            const environmentsById = new Map(page.items.map(row => [row.id, row]));
            if (page.runtimeTargetLinks?.some(link => environmentsById.get(link.environmentId)?.runtimeTargetLinkId !== link.id)) return failure('invalid_response');
            const runtimeByEnvironment = new Map(page.runtimeTargetLinks?.map(link => [link.environmentId, link]));
            const sourceNames = new Map(page.projectSources?.map(source => [source.id, source.name]));
            const receipts = query.environmentIds === undefined
                ? (page.currentDeployments ?? []).filter(row => environmentsById.has(row.environmentId)) : [];
            const currentByEnvironment = new Map(receipts.map((receipt, index) => [receipt.environmentId, { receipt, index }]));
            const headers = await account.readArtifactHeaders([...page.items.map(row => row.contentArtifactId),
                ...receipts.map(row => row.contentArtifactId)], { signal: options.signal });
            const items = [];
            for (const [index, environment] of page.items.entries()) {
                const read = headers[index];
                if (!read || read.status !== 'fulfilled') return failure('deployment_content_unavailable');
                const artifact = read.value;
                const opened: DeploymentArtifactHeaderV1 | null = artifact?.isDecrypted && artifact.rawHeader && artifact.bodyVersion !== undefined
                    ? { artifactId: artifact.id, header: artifact.rawHeader,
                        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } } : null;
                const label = readDeploymentEnvironmentArtifactHeaderV1(environment, opened);
                if (!label.ok) return failure(label.error);
                const current = currentByEnvironment.get(environment.id);
                let currentDeployment: DeploymentEnvironmentCollectionV1['items'][number]['currentDeployment'] = null;
                if (current) {
                    const receiptHeader = headers[page.items.length + current.index];
                    if (!receiptHeader || receiptHeader.status !== 'fulfilled') return failure('deployment_content_unavailable');
                    const artifact = receiptHeader.value;
                    const opened: DeploymentArtifactHeaderV1 | null = artifact?.isDecrypted && artifact.rawHeader && artifact.bodyVersion !== undefined
                        ? { artifactId: artifact.id, header: artifact.rawHeader,
                            revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } } : null;
                    const projection = readDeploymentReceiptArtifactHeaderV1(current.receipt, opened);
                    if (!projection.ok) return failure(projection.error);
                    currentDeployment = { ...current.receipt, title: projection.title, steps: projection.steps };
                }
                const runtimeTargetLink = runtimeByEnvironment.get(environment.id) ?? null;
                items.push({ environment, title: label.title, projectSourceName: sourceNames.get(environment.projectSourceId) ?? null,
                    liveVersionTitle: currentDeployment && runtimeTargetLink?.activeDeploymentId === currentDeployment.id
                        ? currentDeployment.title ?? null : null,
                    ...(page.runtimeTargetLinks === undefined ? {} : { runtimeTargetLink }),
                    currentDeployment });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor,
                ...(page.coverage === undefined ? {} : { coverage: page.coverage }) } };
        }),
        readEnvironment: (scope, environmentId, options) => scoped(scope, options, async account => {
            const parsed = DeploymentEnvironmentGetResultV1Schema.safeParse(await execute('deployments.environments.get',
                { ...home, environmentId }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const detail = parsed.data;
            if (!detail.ok) return failure(detail.error);
            if (detail.environment.id !== environmentId
                || (scope.projectSourceId !== undefined && detail.environment.projectSourceId !== scope.projectSourceId)
                || !areServerProfileIdentifiersEquivalent(detail.environment.serverId, lifetime.scope.serverId)
                || !detail.targetLinks.every(link => link.environmentId === environmentId)) return failure('invalid_response');
            // The selected page consumes Environment content and custody headers,
            // not private bodies from every retained TargetLink.
            const [artifact] = await account.readArtifactContents([detail.environment.contentArtifactId], { signal: options.signal });
            if (!artifact || artifact.status === 'rejected') return failure('deployment_content_unavailable');
            const environment = readDeploymentEnvironmentArtifactV1(detail.environment, artifact.value);
            if (!environment.ok) return failure(environment.error);
            const targetLinks = detail.targetLinks.map(targetLink => ({ targetLink }));
            return { ok: true, value: { environment: detail.environment, content: environment.content, targetLinks } };
        }),
        listHistory: (scope, environmentId, query, options) => scoped(scope, options, async account => {
            const parsed = DeploymentReceiptListResultV1Schema.safeParse(await execute('deployments.receipts.list',
                { ...home, environmentId, ...query }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const page = parsed.data;
            if (!page.ok) return failure(page.error);
            if (!page.items.every(row => row.environmentId === environmentId)) return failure('invalid_response');
            // Visible attempts need their revision and recorded failure, which legacy headers do not carry.
            // Open this one page in a batch through the mode-aware Account owner, never one request per row.
            const contents = await account.readArtifactContents(page.items.map(row => row.contentArtifactId), { signal: options.signal });
            const items = [];
            for (const [index, receipt] of page.items.entries()) {
                const read = contents[index];
                if (!read || read.status !== 'fulfilled') return failure('deployment_content_unavailable');
                const opened = readDeploymentReceiptArtifactV1(receipt, read.value);
                if (!opened.ok) return failure(opened.error);
                const facts = projectDeploymentReceiptHistoryEntryV1({ deployment: receipt, content: opened.content });
                items.push({ ...receipt, title: facts.historyTitle ?? opened.title, source: facts.source });
            }
            return { ok: true, value: { ...page, items } };
        }),
        readReceipt: (scope, environmentId, deploymentId, options) => scoped(scope, options, async account => {
            const parsed = DeploymentReceiptGetResultV1Schema.safeParse(await execute('deployments.receipts.get',
                { ...home, environmentId, deploymentId }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const receipt = parsed.data;
            if (!receipt.ok) return failure(receipt.error);
            if (receipt.deployment.environmentId !== environmentId || receipt.deployment.id !== deploymentId) return failure('invalid_response');
            const artifact = await account.readArtifactContent(receipt.deployment.contentArtifactId, { signal: options.signal });
            const content = readDeploymentReceiptArtifactV1(receipt.deployment, artifact);
            return content.ok ? { ok: true, value: { deployment: receipt.deployment, content: content.content,
                ...(receipt.cancellable === undefined ? {} : { cancellable: receipt.cancellable }) } } : failure(content.error);
        }),
    };
}
