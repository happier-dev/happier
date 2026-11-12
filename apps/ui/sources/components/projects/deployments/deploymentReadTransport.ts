import {
    DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema,
    DeploymentReceiptGetResultV1Schema, DeploymentReceiptListResultV1Schema,
    DeploymentDomainListResultV1Schema, DeploymentDomainPageResultV1Schema, DeploymentDataPageResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    readDeploymentEnvironmentArtifactHeaderV1, readDeploymentEnvironmentArtifactV1, readDeploymentReceiptArtifactHeaderV1,
    readDeploymentReceiptArtifactV1,
    readDeploymentDomainArtifactV1, readDeploymentTargetLinkArtifactV1,
    projectDeploymentCancellationConsequenceV1,
} from '@happier-dev/deployment-protocol/v1';
import type {
    DeploymentReadTransportV1, DeploymentReadScopeV1, DeploymentReadOptionsV1, DeploymentReadResultV1,
} from '@happier-dev/deployments';
import type { DeploymentEnvironmentCollectionV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { domainHealthObserver, environmentHealthObserver } from './observeEnvironmentHealth';
import { projectDeploymentReceiptHistoryEntryV1 } from '@happier-dev/deployments';

function failure(code: string, retryable = false): Extract<DeploymentReadResultV1<never>, { ok: false }> {
    return { ok: false, failure: { code, retryable } };
}

async function readArtifactsByRow<T>(artifactIds: readonly string[], read: (ids: string[]) => Promise<T[]>): Promise<(T | undefined)[]> {
    const ids = [...new Set(artifactIds)];
    const results = await read(ids);
    const byId = new Map(ids.map((id, index) => [id, results[index]]));
    return artifactIds.map(id => byId.get(id));
}

export type DeploymentTargetLinkChoiceV1 = Readonly<{
    targetLink: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'];
    title: string;
    content: NonNullable<DeploymentEnvironmentDetailV1['targetLinks'][number]['content']>;
}>;
type UiDeploymentReadTransport = DeploymentReadTransportV1 & Readonly<{
    readTargetLinks: (scope: DeploymentReadScopeV1,
        targetLinks: readonly DeploymentTargetLinkChoiceV1['targetLink'][], options: DeploymentReadOptionsV1)
        => Promise<DeploymentReadResultV1<readonly DeploymentTargetLinkChoiceV1[]>>;
}>;

/** The shared controller consumes the existing Action and mode-aware Account Artifact owners. */
export function createDeploymentReadTransport(lifetime: ServerAccountScopeLifetime): UiDeploymentReadTransport {
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
    const readEnvironmentMetadata = async (scope: DeploymentReadScopeV1, environmentId: string, options: DeploymentReadOptionsV1) => {
        const parsed = DeploymentEnvironmentGetResultV1Schema.safeParse(await execute('deployments.environments.get',
            { ...home, environmentId }, { signal: options.signal }));
        if (!parsed.success) return failure('invalid_response');
        const detail = parsed.data;
        if (!detail.ok) return failure(detail.error);
        if (detail.environment.id !== environmentId
            || (scope.projectSourceId !== undefined && detail.environment.projectSourceId !== scope.projectSourceId)
            || !areServerProfileIdentifiersEquivalent(detail.environment.serverId, lifetime.scope.serverId)
            || !detail.targetLinks.every(link => link.environmentId === environmentId)) return failure('invalid_response');
        return { ok: true as const, value: detail };
    };
    const transport = {
        listDomainPage: (scope, query, options) => scoped(scope, options, async account => {
            const parsed = DeploymentDomainPageResultV1Schema.safeParse(await execute('deployments.domains.page',
                { ...home, projectSourceId: scope.projectSourceId, ...query }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const page = parsed.data;
            if (!page.ok) return failure(page.error);
            if (!page.items.every(({ domain, environment }) => domain.environmentId === environment.id
                && (scope.projectSourceId === undefined || environment.projectSourceId === scope.projectSourceId)
                && areServerProfileIdentifiersEquivalent(environment.serverId, scope.serverId))) return failure('invalid_response');
            const opened = await account.openArtifactContents(page.artifacts, { signal: options.signal });
            const byId = new Map(page.artifacts.map((artifact, index) => [artifact.id, opened[index]]));
            const items = [];
            let coverage = page.coverage;
            for (const { domain, environment } of page.items) {
                const artifact = byId.get(domain.contentArtifactId);
                const row = readDeploymentDomainArtifactV1(domain, artifact?.status === 'fulfilled' ? artifact.value : null);
                if (!row.ok) { coverage = 'partial'; continue; }
                items.push({ domain, environment, title: row.title, content: row.content });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor, ...(coverage === undefined ? {} : { coverage }) } };
        }),
        listDataServicePage: (scope, query, options) => scoped(scope, options, async account => {
            const parsed = DeploymentDataPageResultV1Schema.safeParse(await execute('deployments.data.page',
                { ...home, projectSourceId: scope.projectSourceId, ...query }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const page = parsed.data;
            if (!page.ok) return failure(page.error);
            if (!page.items.every(({ environment }) => (scope.projectSourceId === undefined || environment.projectSourceId === scope.projectSourceId)
                && areServerProfileIdentifiersEquivalent(environment.serverId, scope.serverId))) return failure('invalid_response');
            const opened = await account.openArtifactContents(page.artifacts, { signal: options.signal });
            const byId = new Map(page.artifacts.map((artifact, index) => [artifact.id, opened[index]]));
            const items = [];
            let coverage = page.coverage;
            for (const { environment } of page.items) {
                const artifact = byId.get(environment.contentArtifactId);
                const row = readDeploymentEnvironmentArtifactV1(environment, artifact?.status === 'fulfilled' ? artifact.value : null);
                if (!row.ok) { coverage = 'partial'; continue; }
                items.push({ environment, title: row.title, content: row.content });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor, ...(coverage === undefined ? {} : { coverage }) } };
        }),
        listDomains: (scope, environmentId, query, options) => scoped(scope, options, async account => {
            const parsed = DeploymentDomainListResultV1Schema.safeParse(await execute('deployments.domains.list',
                { ...home, environmentId, ...query }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            const page = parsed.data;
            if (!page.ok) return failure(page.error);
            if (page.environmentId !== environmentId || page.domains.some(domain => domain.environmentId !== environmentId)) {
                return failure('invalid_response');
            }
            const contents = await readArtifactsByRow(page.domains.map(domain => domain.contentArtifactId),
                ids => account.readArtifactContents(ids, { signal: options.signal }));
            const items = [];
            let coverage: DeploymentEnvironmentCollectionV1['coverage'];
            for (const [index, domain] of page.domains.entries()) {
                const artifact = contents[index];
                if (!artifact || artifact.status === 'rejected') { coverage = 'partial'; continue; }
                const opened = readDeploymentDomainArtifactV1(domain, artifact.value);
                if (!opened.ok) { coverage = 'partial'; continue; }
                items.push({ domain, title: opened.title, content: opened.content });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor,
                ...(coverage === undefined ? {} : { coverage }) } };
        }),
        observeEnvironmentHealth: environmentHealthObserver(lifetime),
        observeDomainHealth: domainHealthObserver(lifetime, (scope, environmentId, options) =>
            scoped(scope, options, () => readEnvironmentMetadata(scope, environmentId, options))),
        readActivity: (scope, options) => scoped(scope, options, async () => {
            const parsed = DeploymentEnvironmentListResultV1Schema.safeParse(await execute('deployments.environments.list',
                { ...home, projectSourceId: scope.projectSourceId, projection: 'activity' }, { signal: options.signal }));
            if (!parsed.success) return failure('invalid_response');
            if (!parsed.data.ok) return failure(parsed.data.error);
            return parsed.data.activity ? { ok: true, value: parsed.data.activity } : failure('deployment_unavailable');
        }),
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
            // Existing headers predate configured-backup membership. Open the visible page once,
            // including current receipt headers, so old configurations need no rewrite or per-row read.
            const contents = await readArtifactsByRow([...page.items.map(row => row.contentArtifactId),
                ...receipts.map(row => row.contentArtifactId)], ids => account.readArtifactContents(ids, { signal: options.signal }));
            const items = [];
            let coverage = page.coverage;
            for (const [index, environment] of page.items.entries()) {
                const read = contents[index];
                if (!read || read.status !== 'fulfilled') { coverage = 'partial'; continue; }
                const artifact = read.value;
                const opened = readDeploymentEnvironmentArtifactV1(environment, artifact);
                const label = opened.ok ? opened : readDeploymentEnvironmentArtifactHeaderV1(environment, artifact);
                if (!label.ok) { coverage = 'partial'; continue; }
                if (!opened.ok) coverage = 'partial';
                const current = currentByEnvironment.get(environment.id);
                let currentDeployment: DeploymentEnvironmentCollectionV1['items'][number]['currentDeployment'] = null;
                if (current) {
                    const receiptHeader = contents[page.items.length + current.index];
                    const artifact = receiptHeader?.status === 'fulfilled' ? receiptHeader.value : null;
                    const projection = readDeploymentReceiptArtifactHeaderV1(current.receipt, artifact);
                    if (projection.ok) currentDeployment = { ...current.receipt, title: projection.title, steps: projection.steps };
                    else coverage = 'partial';
                }
                const runtimeTargetLink = runtimeByEnvironment.get(environment.id) ?? null;
                items.push({ environment, title: label.title, projectSourceName: sourceNames.get(environment.projectSourceId) ?? null,
                    ...(opened.ok ? { backupConfigured: opened.content.backup !== undefined
                        && !('notNeeded' in opened.content.backup),
                        previewTemplateConfigured: opened.content.previewTemplate !== undefined } : {}),
                    liveVersionTitle: currentDeployment && runtimeTargetLink?.activeDeploymentId === currentDeployment.id
                        ? currentDeployment.title ?? null : null,
                    ...(page.runtimeTargetLinks === undefined ? {} : { runtimeTargetLink }),
                    currentDeployment });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor,
                ...(coverage === undefined ? {} : { coverage }) } };
        }),
        readEnvironment: (scope, environmentId, options) => scoped(scope, options, async account => {
            const metadata = await readEnvironmentMetadata(scope, environmentId, options);
            if (!metadata.ok) return metadata;
            const detail = metadata.value;
            // The selected page consumes Environment content and custody headers,
            // not private bodies from every retained TargetLink.
            const [artifact] = await account.readArtifactContents([detail.environment.contentArtifactId], { signal: options.signal });
            if (!artifact || artifact.status === 'rejected') return failure('deployment_content_unavailable');
            const environment = readDeploymentEnvironmentArtifactV1(detail.environment, artifact.value);
            if (!environment.ok) return failure(environment.error);
            const targetLinks = detail.targetLinks.map(targetLink => ({ targetLink }));
            return { ok: true, value: { environment: detail.environment, content: environment.content, targetLinks,
                ...(detail.savedSecretRevisions === undefined ? {} : { savedSecretRevisions: detail.savedSecretRevisions }),
                ...(detail.controller ? { controller: detail.controller } : {}) } };
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
            const contents = await readArtifactsByRow(page.items.map(row => row.contentArtifactId),
                ids => account.readArtifactContents(ids, { signal: options.signal }));
            const items = [];
            let coverage: DeploymentEnvironmentCollectionV1['coverage'];
            for (const [index, receipt] of page.items.entries()) {
                const read = contents[index];
                if (!read || read.status !== 'fulfilled') { coverage = 'partial'; continue; }
                const opened = readDeploymentReceiptArtifactV1(receipt, read.value);
                if (!opened.ok) { coverage = 'partial'; continue; }
                const facts = projectDeploymentReceiptHistoryEntryV1({ deployment: receipt, content: opened.content });
                items.push({ ...receipt, title: facts.historyTitle ?? opened.title, source: facts.source, failure: facts.failure });
            }
            return { ok: true, value: { ...page, items, ...(coverage === undefined ? {} : { coverage }) } };
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
            if (!content.ok) return failure(content.error);
            const cancellationConsequence = projectDeploymentCancellationConsequenceV1({
                deployment: receipt.deployment, content: content.content,
            });
            return { ok: true, value: { deployment: receipt.deployment, content: content.content,
                ...(receipt.cancellable === undefined ? {} : { cancellable: receipt.cancellable }),
                ...(cancellationConsequence ? { cancellationConsequence } : {}) } };
        }),
    } satisfies DeploymentReadTransportV1;
    return { ...transport,
        readTargetLinks: (scope, targetLinks, options) => scoped(scope, options, async account => {
            if (targetLinks.length === 0) return { ok: true, value: [] };
            const artifacts = await readArtifactsByRow(targetLinks.map(link => link.contentArtifactId),
                ids => account.readArtifactContents(ids, { signal: options.signal }));
            const rows: DeploymentTargetLinkChoiceV1[] = [];
            for (const [index, targetLink] of targetLinks.entries()) {
                const artifact = artifacts[index];
                const opened = readDeploymentTargetLinkArtifactV1(targetLink, artifact?.status === 'fulfilled' ? artifact.value : null);
                if (!opened.ok) return failure(opened.error);
                rows.push({ targetLink, title: opened.title, content: opened.content });
            }
            return { ok: true, value: rows };
        }),
        async listEnvironments(scope, query, options) {
        const { allPages, ...pageQuery } = query;
        if (!allPages) return transport.listEnvironments(scope, pageQuery, options);
        const items: DeploymentEnvironmentCollectionV1['items'][number][] = [];
        let coverage: DeploymentEnvironmentCollectionV1['coverage'];
        let cursor = pageQuery.cursor;
        do {
            const page = await transport.listEnvironments(scope, { ...pageQuery, cursor }, options);
            if (!page.ok) return page;
            items.push(...page.value.items);
            if (page.value.coverage === 'partial') coverage = 'partial';
            cursor = page.value.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return { ok: true, value: { items, nextCursor: null, ...(coverage === undefined ? {} : { coverage }) } };
    } };
}
