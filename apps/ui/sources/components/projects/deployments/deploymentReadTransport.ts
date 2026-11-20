import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { DeploymentPendingDeployStoredIntentV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1,
    databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { DatabaseTargetsListResultV1Schema, type DatabaseTargetsListResultV1 } from '@happier-dev/plugin-sdk/database';
import {
    readAutomationDatabaseSubjectV1,
    type AutomationDatabaseSubjectReadV1,
} from '@happier-dev/plugin-sdk/automations';
import {
    DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentDataSizeResultV1Schema,
    DeploymentReceiptGetResultV1Schema, DeploymentReceiptListResultV1Schema,
    DeploymentDomainListResultV1Schema, DeploymentDomainPageResultV1Schema, DeploymentDataPageResultV1Schema,
    DeploymentTargetLinksListResultV1Schema, type DeploymentTargetLinksListInputV1,
    type DeploymentDataPageSuccessV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    readDeploymentReceiptArtifactV1, readDeploymentTargetLinkArtifactV1,
} from '@happier-dev/deployment-protocol/v1';
import { projectDeploymentCancellationConsequenceV1 } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentEnvironmentArtifactHeaderV1, readDeploymentEnvironmentArtifactV1, readDeploymentReceiptArtifactHeaderV1, readDeploymentDomainArtifactV1 } from '@happier-dev/deployments';
import type {
    DeploymentReadTransportV1, DeploymentReadScopeV1, DeploymentReadOptionsV1, DeploymentReadResultV1,
} from '@happier-dev/deployments';
import type { DeploymentEnvironmentCollectionV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { domainHealthObserver, environmentCollectionHealthObserver, environmentHealthObserver } from './observeEnvironmentHealth';
import { projectDeploymentReceiptHistoryEntryV1, projectDeploymentReceiptUrlFactsV1, projectDeploymentReceiptSourceFactsV1,
    deploymentDataTargetOperands, selectDeploymentRuntimeTargetLinkV1, isDeploymentDatabaseMoveCandidateV1, findExistingDeploymentTargetLinkV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { deploymentLiveAddressDemand, resolveDeploymentLiveAddress } from './deploymentLiveAddressFacts';

function failure(code: string, retryable = false): Extract<DeploymentReadResultV1<never>, { ok: false }> {
    return { ok: false, failure: { code, retryable } };
}

function failureFromError(error: unknown): Extract<DeploymentReadResultV1<never>, { ok: false }> {
    if (error instanceof HappyError) return failure(error.code ?? 'deployment_read_failed', error.canTryAgain);
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return failure(error.code);
    return failure('deployment_read_failed', true);
}

function readEnvironmentPresentation(environment: DeploymentEnvironmentCollectionV1['items'][number]['environment'],
    artifact: Parameters<typeof readDeploymentEnvironmentArtifactV1>[1], sourceNames: ReadonlyMap<string, string>) {
    const opened = readDeploymentEnvironmentArtifactV1(environment, artifact);
    const label = opened.ok ? opened : readDeploymentEnvironmentArtifactHeaderV1(environment, artifact);
    return { opened, label, projectSourceName: sourceNames.get(environment.projectSourceId) ?? null };
}

async function readArtifactsByRow<T>(artifactIds: readonly string[], read: (ids: string[]) => Promise<T[]>): Promise<(T | undefined)[]> {
    const ids = [...new Set(artifactIds)];
    const results = await read(ids);
    const byId = new Map(ids.map((id, index) => [id, results[index]]));
    return artifactIds.map(id => byId.get(id));
}

/** Open the same private Link candidates that write admission compares on its executor. */
export async function readExistingPlatformTargetAssociation(
    lifetime: ServerAccountScopeLifetime,
    owner: DeploymentTargetLinksListInputV1['scope'],
    candidate: Omit<Parameters<typeof findExistingDeploymentTargetLinkV1>[0], 'serverId'>,
) {
    const scope = lifetime.scope;
    const account = await captureLazyActionAccountContext(scope.serverId, undefined, undefined, scope);
    try {
        const result = await findExistingDeploymentTargetLinkV1({ ...candidate, serverId: scope.serverId }, {
            async list(selection, cursor) {
                const answer = await requestHomeDomain({ scope, path: '/v1/deployments/targets/list', effect: 'read',
                    requestAuthority: account, schema: DeploymentTargetLinksListResultV1Schema,
                    input: { serverId: account.serverIdentityId ?? scope.serverId, scope: owner, selection, ...(cursor ? { cursor } : {}) } });
                if (!answer.ok) throw new HappyError('Could not read deployment target links', false, { code: homeDomainFailureCode(answer) });
                return answer.value;
            },
            artifact: link => account.readArtifactContent(link.contentArtifactId),
        });
        account.assertCurrent();
        return result;
    } finally {
        account.dispose();
    }
}

export type DeploymentTargetLinkChoiceV1 = Readonly<{
    targetLink: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'];
    title: string;
    content: NonNullable<DeploymentEnvironmentDetailV1['targetLinks'][number]['content']>;
}>;
type EnvironmentPage = Extract<ReturnType<typeof DeploymentEnvironmentListResultV1Schema.parse>, { ok: true }>;
export type DeploymentEnvironmentNamePage = Readonly<Pick<EnvironmentPage, 'nextCursor' | 'coverage'> & {
    items: readonly (EnvironmentPage['items'][number] & Readonly<{ name: string }>)[];
}>;
type UiDeploymentReadTransport = Omit<DeploymentReadTransportV1, 'readEnvironment'> & Readonly<{
    /** Menu pages and saved identities share private, header-only presentation. */
    readEnvironmentNames: (scope: DeploymentReadScopeV1, query: Readonly<{ cursor?: string; environmentId?: string }>,
        options: DeploymentReadOptionsV1) => Promise<DeploymentReadResultV1<DeploymentEnvironmentNamePage>>;
    readEnvironment: (scope: DeploymentReadScopeV1, environmentId: string, options: DeploymentReadOptionsV1)
        => Promise<DeploymentReadResultV1<DeploymentEnvironmentDetailV1>>;
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
            return failureFromError(error);
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
    const readEnvironmentPageMetadata = async (scope: DeploymentReadScopeV1,
        query: Parameters<DeploymentReadTransportV1['listEnvironments']>[1], options: DeploymentReadOptionsV1) => {
        const parsed = DeploymentEnvironmentListResultV1Schema.safeParse(await execute('deployments.environments.list',
            { ...home, projectSourceId: scope.projectSourceId, ...query }, { signal: options.signal }));
        if (!parsed.success) return failure('invalid_response');
        const page = parsed.data;
        if (!page.ok) return failure(page.error);
        const requestedEnvironmentIds = query.environmentIds === undefined ? undefined : new Set(query.environmentIds);
        if (!page.items.every(row => (scope.projectSourceId === undefined || row.projectSourceId === scope.projectSourceId)
            && (requestedEnvironmentIds === undefined || requestedEnvironmentIds.has(row.id))
            && areServerProfileIdentifiersEquivalent(row.serverId, lifetime.scope.serverId))) return failure('invalid_response');
        return { ok: true as const, value: page };
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
            const sourceNames = new Map(page.projectSources?.map(source => [source.id, source.name]));
            const items = [];
            let coverage = page.coverage;
            for (const { domain, environment } of page.items) {
                const artifact = byId.get(domain.contentArtifactId);
                const row = readDeploymentDomainArtifactV1(domain, artifact?.status === 'fulfilled' ? artifact.value : null);
                if (!row.ok) { coverage = 'partial'; continue; }
                const environmentArtifact = byId.get(environment.contentArtifactId);
                const presentation = readEnvironmentPresentation(environment,
                    environmentArtifact?.status === 'fulfilled' ? environmentArtifact.value : null, sourceNames);
                if (!presentation.label.ok) { coverage = 'partial'; continue; }
                if (!presentation.opened.ok) coverage = 'partial';
                items.push({ domain, environment, title: row.title, content: row.content,
                    environmentTitle: presentation.label.title, projectSourceName: presentation.projectSourceName });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor, ...(coverage === undefined ? {} : { coverage }) } };
        }),
        listDataServicePage: (scope, query, options) => scoped(scope, options, async account => {
            let page: Pick<DeploymentDataPageSuccessV1, 'items' | 'nextCursor' | 'coverage' | 'projectSources'>;
            let byId: Map<string, Awaited<ReturnType<LazyActionAccountContext['readArtifactContents']>>[number] | undefined>;
            let selectedMetadata: Awaited<ReturnType<typeof readEnvironmentMetadata>> | undefined;
            if (query.environmentId !== undefined) {
                selectedMetadata = await readEnvironmentMetadata(scope, query.environmentId, options);
                if (!selectedMetadata.ok) return selectedMetadata;
                const environment = selectedMetadata.value.environment;
                const [artifact] = await account.readArtifactContents([environment.contentArtifactId], { signal: options.signal });
                page = { items: [{ environment }], nextCursor: null };
                byId = new Map([[environment.contentArtifactId, artifact]]);
            } else {
                const parsed = DeploymentDataPageResultV1Schema.safeParse(await execute('deployments.data.page',
                    { ...home, projectSourceId: scope.projectSourceId, ...query }, { signal: options.signal }));
                if (!parsed.success) return failure('invalid_response');
                if (!parsed.data.ok) return failure(parsed.data.error);
                page = parsed.data;
                if (!page.items.every(({ environment }) => (scope.projectSourceId === undefined || environment.projectSourceId === scope.projectSourceId)
                    && areServerProfileIdentifiersEquivalent(environment.serverId, scope.serverId))) return failure('invalid_response');
                const opened = await account.openArtifactContents(parsed.data.artifacts, { signal: options.signal });
                byId = new Map(parsed.data.artifacts.map((artifact, index) => [artifact.id, opened[index]]));
            }
            const items = [];
            let coverage = page.coverage;
            const sourceNames = new Map(page.projectSources?.map(source => [source.id, source.name]));
            const previousById = new Map(options.previousItems?.map(item => [item.environment.id, item]));
            for (const { environment } of page.items) {
                const artifact = byId.get(environment.contentArtifactId);
                const row = readDeploymentEnvironmentArtifactV1(environment, artifact?.status === 'fulfilled' ? artifact.value : null);
                if (!row.ok) { coverage = 'partial'; continue; }
                const previous = previousById.get(environment.id);
                let databaseTargets: DatabaseTargetsListResultV1 | undefined;
                let databaseSubjectFailure: ReturnType<typeof failure>['failure'] | undefined;
                // The exact Database page reads Automation subjects. Services inventory only reads declared databases and sizes.
                if (query.environmentId !== undefined) {
                    if (environment.controllerMachineId) {
                        try {
                            databaseTargets = DatabaseTargetsListResultV1Schema.parse(await execute('action.invoke', {
                                action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1) },
                                input: { scope: { kind: 'environment', environment: { serverId: environment.serverId,
                                    projectSourceId: environment.projectSourceId, environmentId: environment.id } } },
                            }, { signal: options.signal, externalActionTarget: { kind: 'machine', machineId: environment.controllerMachineId } }));
                        } catch (error) {
                            coverage = 'partial';
                            databaseSubjectFailure = failureFromError(error).failure;
                        }
                    } else {
                        coverage = 'partial';
                        databaseSubjectFailure = failure('machine_unavailable').failure;
                    }
                }
                const databaseSizes: DeploymentDatabaseSizeV1[] = [];
                const data = row.content.template?.data ?? [];
                const metadata = selectedMetadata ?? (data.length > 0
                    ? await readEnvironmentMetadata(scope, environment.id, options) : null);
                const runtimeTargetLink = metadata?.ok ? selectDeploymentRuntimeTargetLinkV1({
                    environment: metadata.value.environment,
                    targetLinks: metadata.value.targetLinks.map(targetLink => ({ targetLink })),
                }) : null;
                const nativeTarget = deploymentDataTargetOperands({ environment,
                    runtimeTargetLink });
                for (const service of data) {
                    const unavailable = (reason: string): DeploymentDatabaseSizeV1 => ({ service: service.service,
                        size: { status: 'unavailable', reason }, growth: { status: 'unavailable', reason } });
                    if (!nativeTarget || !runtimeTargetLink?.activeDeploymentId) {
                        databaseSizes.push(unavailable(metadata && !metadata.ok ? metadata.failure.code : 'active_deployment_required')); continue;
                    }
                    const measured = DeploymentDataSizeResultV1Schema.safeParse(await execute(DEPLOYMENT_DATA_SIZE_ACTION_ID_V1,
                        { ...home, ...nativeTarget, deploymentId: runtimeTargetLink.activeDeploymentId,
                            service: service.service, previous: previous?.databaseSizes?.find(size => size.service === service.service) },
                        { signal: options.signal }));
                    databaseSizes.push(measured.success && measured.data.ok ? measured.data.size
                        : unavailable(measured.success ? measured.data.error : 'invalid_response'));
                }
                const databaseSubjects = Object.fromEntries<AutomationDatabaseSubjectReadV1>((databaseTargets?.targets ?? []).flatMap<readonly [string, AutomationDatabaseSubjectReadV1]>(descriptor => {
                    const target = descriptor.target;
                    // Native deployment_service identity is fully determined by the target. Keep the section visible
                    // when an older daemon omits the optional projected subject; managed targets still require the
                    // producer's explicit read/refusal because their provider identity is not reconstructible here.
                    const automationSubject = descriptor.automationSubject
                        ?? (target.kind === 'deployment_service'
                            ? readAutomationDatabaseSubjectV1(target.environment.serverId, target)
                            : undefined);
                    if (!automationSubject) return [];
                    if (target.kind === 'deployment_service') return [[target.serviceId, automationSubject]];
                    if (target.kind === 'managed_deployment' && !automationSubject.ok) {
                        return [[target.targetLinkId, automationSubject]];
                    }
                    return [];
                }));
                items.push({ environment, title: row.title, content: row.content,
                    projectSourceName: sourceNames.get(environment.projectSourceId) ?? null, databaseSizes, databaseSubjects,
                    ...(databaseSubjectFailure ? { databaseSubjectFailure } : {}) });
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
        observeEnvironmentCollectionHealth: environmentCollectionHealthObserver(lifetime),
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
        listEnvironments: (scope, query, options): Promise<DeploymentReadResultV1<DeploymentEnvironmentCollectionV1>> => query.environmentIds?.length === 0 || query.previewPullRequestIds?.length === 0
            ? Promise.resolve({ ok: true, value: { items: [], nextCursor: null } })
            : scoped(scope, options, async account => {
            const metadata = await readEnvironmentPageMetadata(scope, query, options);
            if (!metadata.ok) return metadata;
            const page = metadata.value;
            const environmentsById = new Map(page.items.map(row => [row.id, row]));
            if (page.runtimeTargetLinks?.some(link => environmentsById.get(link.environmentId)?.runtimeTargetLinkId !== link.id)) return failure('invalid_response');
            const runtimeByEnvironment = new Map(page.runtimeTargetLinks?.map(link => [link.environmentId, link]));
            const sourceNames = new Map(page.projectSources?.map(source => [source.id, source.name]));
            const receipts = query.environmentIds === undefined
                ? (page.currentDeployments ?? []).filter(row => environmentsById.has(row.environmentId)) : [];
            const currentByEnvironment = new Map(receipts.map((receipt, index) => [receipt.environmentId, { receipt, index }]));
            const addressMetadata = query.environmentIds === undefined && page.servingDeployments !== undefined
                && page.liveAddressDomains !== undefined && page.runtimeTargetLinks !== undefined;
            const serving = addressMetadata ? page.servingDeployments ?? [] : [];
            if (serving.some(receipt => {
                const runtime = runtimeByEnvironment.get(receipt.environmentId);
                return runtime?.activeDeploymentId !== receipt.id || runtime.id !== receipt.targetLinkId;
            })) return failure('invalid_response');
            const servingById = new Map(serving.map((receipt, index) => [receipt.id, { receipt, index }]));
            const servingEnvironments = new Set(serving.map(receipt => receipt.environmentId));
            const domains = addressMetadata ? (page.liveAddressDomains ?? []).filter(domain => servingEnvironments.has(domain.environmentId)) : [];
            const servingOffset = page.items.length + receipts.length;
            const domainOffset = servingOffset + serving.length;
            // Existing headers predate configured-backup membership. Open the visible page once,
            // including current/serving receipts and current Domains without per-row reads.
            const contents = await readArtifactsByRow([...page.items.map(row => row.contentArtifactId),
                ...receipts.map(row => row.contentArtifactId), ...serving.map(row => row.contentArtifactId),
                ...domains.map(row => row.contentArtifactId)], ids => account.readArtifactContents(ids, { signal: options.signal }));
            const items = [];
            let coverage = page.coverage;
            const domainsByEnvironment = new Map<string, { items: Parameters<typeof resolveDeploymentLiveAddress>[1][number][]; complete: boolean }>();
            for (const [index, domain] of domains.entries()) {
                let group = domainsByEnvironment.get(domain.environmentId);
                if (!group) { group = { items: [], complete: true }; domainsByEnvironment.set(domain.environmentId, group); }
                const read = contents[domainOffset + index];
                const opened = readDeploymentDomainArtifactV1(domain, read?.status === 'fulfilled' ? read.value : null);
                if (opened.ok) group.items.push({ domain, content: opened.content });
                else { group.complete = false; coverage = 'partial'; }
            }
            for (const [index, environment] of page.items.entries()) {
                const read = contents[index];
                if (!read || read.status !== 'fulfilled') { coverage = 'partial'; continue; }
                const artifact = read.value;
                const { opened, label, projectSourceName } = readEnvironmentPresentation(environment, artifact, sourceNames);
                if (!label.ok) { coverage = 'partial'; continue; }
                if (!opened.ok) coverage = 'partial';
                const current = currentByEnvironment.get(environment.id);
                let currentDeployment: DeploymentEnvironmentCollectionV1['items'][number]['currentDeployment'] = null;
                if (current) {
                    const receiptHeader = contents[page.items.length + current.index];
                    const artifact = receiptHeader?.status === 'fulfilled' ? receiptHeader.value : null;
                    const projection = readDeploymentReceiptArtifactHeaderV1(current.receipt, artifact);
                    if (projection.ok) {
                        const opened = readDeploymentReceiptArtifactV1(current.receipt, artifact);
                        currentDeployment = { ...current.receipt, title: projection.title, steps: projection.steps,
                            ...(opened.ok ? projectDeploymentReceiptSourceFactsV1(opened.content) : {}) };
                        if (!opened.ok) coverage = 'partial';
                    } else coverage = 'partial';
                }
                const runtimeTargetLink = runtimeByEnvironment.get(environment.id) ?? null;
                let liveAddress: string | null | undefined;
                if (addressMetadata && (runtimeTargetLink || environment.runtimeTargetLinkId === undefined)) {
                    if (!runtimeTargetLink?.activeDeploymentId) liveAddress = null;
                    else {
                        const active = servingById.get(runtimeTargetLink.activeDeploymentId);
                        if (active) {
                            const read = contents[servingOffset + active.index];
                            const opened = readDeploymentReceiptArtifactV1(active.receipt, read?.status === 'fulfilled' ? read.value : null);
                            if (opened.ok) {
                                const receipt = { deployment: active.receipt, content: opened.content,
                                    facts: projectDeploymentReceiptUrlFactsV1(opened.content) };
                                const domains = domainsByEnvironment.get(environment.id);
                                const resolved = resolveDeploymentLiveAddress(receipt, domains?.items ?? [], true);
                                if (resolved) liveAddress = resolved.url;
                                else if (!deploymentLiveAddressDemand(receipt, true)
                                    || (page.coverage !== 'partial' && domains?.complete !== false)) liveAddress = null;
                            } else coverage = 'partial';
                        }
                    }
                }
                items.push({ environment, title: label.title, projectSourceName,
                    ...(opened.ok ? { backupConfigured: opened.content.backup !== undefined
                        && !('notNeeded' in opened.content.backup),
                        databaseMoveCandidate: await isDeploymentDatabaseMoveCandidateV1(opened.content, runtimeTargetLink),
                        previewTemplateConfigured: opened.content.previewTemplate !== undefined,
                        ...(opened.content.template ? { catalogTemplate: { sourceId: opened.content.template.templateRef.sourceId,
                            itemId: opened.content.template.templateRef.itemId, version: opened.content.template.templateRef.version } } : {}) } : {}),
                    liveVersionTitle: currentDeployment && runtimeTargetLink?.activeDeploymentId === currentDeployment.id
                        ? currentDeployment.title ?? null : null,
                    ...(liveAddress === undefined ? {} : { liveAddress }),
                    ...(page.runtimeTargetLinks === undefined ? {} : { runtimeTargetLink }),
                    currentDeployment });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor,
                ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
                ...(coverage === undefined ? {} : { coverage }) } };
        }),
        readEnvironment: (scope, environmentId, options) => scoped(scope, options, async account => {
            const metadata = await readEnvironmentMetadata(scope, environmentId, options);
            if (!metadata.ok) return metadata;
            const detail = metadata.value;
            const targetLinks: DeploymentEnvironmentDetailV1['targetLinks'] = detail.targetLinks.map(targetLink => ({ targetLink }));
            const runtime = selectDeploymentRuntimeTargetLinkV1({ environment: detail.environment, targetLinks });
            const platformLink = runtime?.source.kind === 'plugin' ? runtime : undefined;
            // Send consumes its selected platform's authored method. Open that
            // link in the Environment batch, leaving retained link bodies closed.
            const [artifact, linkArtifact] = await account.readArtifactContents([detail.environment.contentArtifactId,
                ...(platformLink ? [platformLink.contentArtifactId] : [])], { signal: options.signal,
                ...(detail.pendingDeploy ? { includeAssociatedContentOpener: true } : {}) });
            if (!artifact || artifact.status === 'rejected') return failure('deployment_content_unavailable');
            const environment = readDeploymentEnvironmentArtifactV1(detail.environment, artifact.value);
            if (!environment.ok) return failure(environment.error);
            let pendingDeployment: DeploymentEnvironmentDetailV1['pendingDeployment'];
            if (detail.pendingDeploy) {
                try {
                    const opened = await artifact.value?.openAssociatedContent?.(detail.pendingDeploy);
                    const intent = DeploymentPendingDeployStoredIntentV1Schema.safeParse(opened);
                    if (!intent.success) pendingDeployment = { status: 'unavailable', reason: 'deployment_content_unavailable' };
                    else if (!detail.pendingAdmission) pendingDeployment = { status: 'unavailable', reason: 'operation_unavailable' };
                    else if (intent.data.actionOperationId !== detail.pendingAdmission.actionOperationId
                        || intent.data.requestKey !== detail.pendingAdmission.requestKey) {
                        pendingDeployment = { status: 'unavailable', reason: 'deployment_conflict' };
                    } else pendingDeployment = { status: 'ready', intent: intent.data, admission: detail.pendingAdmission };
                } catch {
                    pendingDeployment = { status: 'unavailable', reason: 'deployment_content_unavailable' };
                }
            }
            if (platformLink) {
                const opened = readDeploymentTargetLinkArtifactV1(platformLink,
                    linkArtifact?.status === 'fulfilled' ? linkArtifact.value : null);
                if (!opened.ok) return failure(opened.error);
                const row = targetLinks.find(row => row.targetLink.id === platformLink.id);
                if (row) row.content = opened.content;
            }
            return { ok: true, value: { environment: detail.environment, content: environment.content, targetLinks,
                databaseMoveCandidate: await isDeploymentDatabaseMoveCandidateV1(environment.content, runtime),
                ...(pendingDeployment === undefined ? {} : { pendingDeployment }),
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
            for (const [index, row] of page.items.entries()) {
                // The History view projects the recorded Artifact failure.
                const { requiredFact: _requiredFact, remedy: _remedy, ...receipt }:
                    typeof row & { requiredFact?: string; remedy?: string } = row;
                const read = contents[index];
                if (!read || read.status !== 'fulfilled') { coverage = 'partial'; continue; }
                const opened = readDeploymentReceiptArtifactV1(receipt, read.value);
                if (!opened.ok) { coverage = 'partial'; continue; }
                const facts = projectDeploymentReceiptHistoryEntryV1({ deployment: receipt, content: opened.content });
                items.push({ ...receipt, title: facts.historyTitle ?? opened.title, source: facts.source, failure: facts.failure,
                    machineIds: [...facts.machineIds], steps: [...facts.steps] });
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
        readEnvironmentNames: (scope, query, options) => scoped(scope, options, async account => {
            const metadata = query.environmentId === undefined
                ? await readEnvironmentPageMetadata(scope, query, options)
                : await readEnvironmentMetadata(scope, query.environmentId, options);
            if (!metadata.ok) return metadata;
            const page = 'items' in metadata.value ? metadata.value
                : { items: [metadata.value.environment], nextCursor: null, coverage: undefined };
            const headers = await readArtifactsByRow(page.items.map(row => row.contentArtifactId),
                ids => account.readArtifactHeaders(ids, { signal: options.signal }));
            const sourceNames = new Map('projectSources' in page ? page.projectSources?.map(source => [source.id, source.name]) : undefined);
            const items: DeploymentEnvironmentNamePage['items'][number][] = [];
            let coverage = page.coverage;
            for (const [index, environment] of page.items.entries()) {
                const result = headers[index];
                const artifact = result?.status === 'fulfilled' ? result.value : null;
                const presentation = readEnvironmentPresentation(environment,
                    artifact?.isDecrypted && artifact.rawHeader && artifact.bodyVersion !== undefined ? {
                        artifactId: artifact.id, header: artifact.rawHeader, body: null,
                        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
                    } : null, sourceNames);
                if (!presentation.label.ok) { coverage = 'partial'; continue; }
                items.push({ ...environment, name: presentation.label.title });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor, coverage } };
        }),
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
        let totalCount: number | undefined;
        let cursor = pageQuery.cursor;
        do {
            const page = await transport.listEnvironments(scope, { ...pageQuery, cursor }, options);
            if (!page.ok) return page;
            if (totalCount === undefined) totalCount = page.value.totalCount;
            items.push(...page.value.items);
            if ('coverage' in page.value && page.value.coverage === 'partial') coverage = 'partial';
            cursor = page.value.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return { ok: true, value: { items, nextCursor: null, ...(totalCount === undefined ? {} : { totalCount }),
            ...(coverage === undefined ? {} : { coverage }) } };
    } };
}
