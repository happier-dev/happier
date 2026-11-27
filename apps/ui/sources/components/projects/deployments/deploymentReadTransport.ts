import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { AutomationDatabaseSubjectV1Schema } from '@happier-dev/protocol/automations/automationSubjectV1';
import { DeploymentPendingDeployStoredIntentV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1,
    databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { DatabaseTargetsListResultV1Schema, type DatabaseTargetsListResultV1, type DatabaseTargetsListInputV1 } from '@happier-dev/plugin-sdk/database';
import {
    readAutomationDatabaseSubjectV1,
    type AutomationDatabaseSubjectReadV1,
} from '@happier-dev/plugin-sdk/automations';
import {
    DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentDataSizeResultV1Schema,
    DeploymentReceiptGetResultV1Schema, decodeDeploymentReceiptHistoryPageV1,
    DeploymentDomainListResultV1Schema, DeploymentDomainPageResultV1Schema, DeploymentDataPageResultV1Schema,
    type DeploymentDataPageSuccessV1, hasDeploymentReceiptContentV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    readDeploymentReceiptArtifactV1, readDeploymentTargetLinkArtifactV1,
} from '@happier-dev/deployment-protocol/v1';
import { projectDeploymentCancellationConsequenceV1 } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentEnvironmentArtifactHeaderV1, readDeploymentEnvironmentArtifactV1, readDeploymentReceiptArtifactHeaderV1, readDeploymentDomainArtifactV1 } from '@happier-dev/deployments';
import type {
    DeploymentReadTransportV1, DeploymentReadScopeV1, DeploymentReadOptionsV1, DeploymentReadResultV1, DeploymentWorkbenchTargetReadV1,
    DeploymentDataServiceReadItemV1, DeploymentSelectedDatabaseV1,
} from '@happier-dev/deployments';
import type { DeploymentEnvironmentCollectionV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { domainHealthObserver, environmentCollectionHealthObserver, environmentHealthObserver } from './observeEnvironmentHealth';
import { projectDeploymentReceiptHistoryEntryV1, projectDeploymentReceiptUrlFactsV1, projectDeploymentReceiptSourceFactsV1,
    deploymentDataTargetOperands, readDeploymentDatabaseRuntimeNameV1, selectDeploymentRuntimeTargetLinkV1, isDeploymentDatabaseMoveCandidateV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, DEPLOYMENT_DOMAIN_LIST_ACTION_ID_V1, DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { selectPublicTelemetryCollectorDomainV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import type { DeploymentAppMachineAssociationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { deploymentLiveAddressDemand, resolveDeploymentLiveAddress } from './deploymentLiveAddressFacts';
import { readDeploymentNativeServiceRoster } from './databasePresentation';
import { hasDeploymentManagedDataLink } from './deploymentRestore';
import { readPlatformResourceName } from './platformTargetLink';
import { createDeploymentTargetCatalogV1, listDeploymentTargetsFromManifestsV1, readDeploymentTargetDisplayNameV1 } from '@happier-dev/deployments';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';

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

async function readArtifactsByRow<T>(artifactIds: readonly (string | null)[], read: (ids: string[]) => Promise<T[]>): Promise<(T | undefined)[]> {
    const ids = [...new Set(artifactIds.filter((id): id is string => id !== null))];
    const results = ids.length ? await read(ids) : [];
    const byId = new Map(ids.map((id, index) => [id, results[index]]));
    return artifactIds.map(id => id === null ? undefined : byId.get(id));
}

export type DeploymentTargetLinkChoiceV1 = Readonly<{
    targetLink: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'];
    title: string;
    content: NonNullable<DeploymentEnvironmentDetailV1['targetLinks'][number]['content']>;
}>;

async function openTargetLinks(account: LazyActionAccountContext,
    targetLinks: readonly DeploymentTargetLinkChoiceV1['targetLink'][], signal: AbortSignal):
    Promise<DeploymentReadResultV1<DeploymentTargetLinkChoiceV1[]>> {
    const artifacts = await readArtifactsByRow(targetLinks.map(link => link.contentArtifactId),
        ids => account.readArtifactContents(ids, { signal }));
    const rows: DeploymentTargetLinkChoiceV1[] = [];
    for (const [index, targetLink] of targetLinks.entries()) {
        const artifact = artifacts[index];
        const opened = readDeploymentTargetLinkArtifactV1(targetLink, artifact?.status === 'fulfilled' ? artifact.value : null);
        if (!opened.ok) return failure(opened.error);
        rows.push({ targetLink, title: opened.title, content: opened.content });
    }
    return { ok: true, value: rows };
}

async function readSelectedDatabase(account: LazyActionAccountContext, signal: AbortSignal, key: string,
    data: Extract<DeploymentSelectedDatabaseV1, { kind: 'selfHosted' }>['data'] | undefined,
    links: readonly DeploymentTargetLinkChoiceV1['targetLink'][]): Promise<DeploymentReadResultV1<DeploymentSelectedDatabaseV1 | null>> {
    if (data) return { ok: true, value: { kind: 'selfHosted', data } };
    const target = links.find(link => link.id === key && link.role === 'data' && link.source.kind === 'plugin'
        && link.deletedAtMs === undefined);
    if (!target) return { ok: true, value: null };
    const opened = await openTargetLinks(account, [target], signal);
    if (!opened.ok) return opened;
    const link = opened.value[0];
    if (!link) return failure('deployment_content_unavailable');
    return { ok: true, value: { kind: target.state === 'detached' || target.detachedAtMs !== undefined ? 'detached' : 'managed', link } };
}
type EnvironmentPage = Extract<ReturnType<typeof DeploymentEnvironmentListResultV1Schema.parse>, { ok: true }>;
export type DeploymentEnvironmentNamePage = Readonly<Pick<EnvironmentPage, 'nextCursor' | 'coverage'> & {
    items: readonly (EnvironmentPage['items'][number] & Readonly<{ name: string }>)[];
}>;
function readEnvironmentName(environment: EnvironmentPage['items'][number],
    result: Awaited<ReturnType<LazyActionAccountContext['readArtifactHeaders']>>[number] | undefined) {
    const artifact = result?.status === 'fulfilled' ? result.value : null;
    return readDeploymentEnvironmentArtifactHeaderV1(environment,
        artifact?.isDecrypted && artifact.rawHeader && artifact.bodyVersion !== undefined ? {
            artifactId: artifact.id, header: artifact.rawHeader,
            revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
        } : null);
}

type DeploymentTargetIdentity = Readonly<{
    projectSourceId: string;
    name?: string;
    targetName?: string;
    platform?: string;
}>;
export type PublicCollectorDomainChoice = Readonly<{ domainId: string; endpoint: string }>;
export type PublicCollectorDomainPage = Readonly<{
    app: DeploymentAppMachineAssociationV1 | null;
    items: readonly PublicCollectorDomainChoice[];
    nextCursor: string | null;
}>;

type UiDeploymentReadTransport = Omit<DeploymentReadTransportV1, 'readEnvironment'> & Readonly<{
    listPublicCollectorDomains: (scope: DeploymentReadScopeV1, input: Readonly<{
        serverId: string;
        machineId: string;
        app?: DeploymentAppMachineAssociationV1;
        cursor?: string;
    }>, options: DeploymentReadOptionsV1) => Promise<DeploymentReadResultV1<PublicCollectorDomainPage>>;
    /** Menu pages and saved identities share private, header-only presentation. */
    readEnvironmentNames: (scope: DeploymentReadScopeV1, query: Readonly<{ cursor?: string; environmentId?: string }>,
        options: DeploymentReadOptionsV1) => Promise<DeploymentReadResultV1<DeploymentEnvironmentNamePage>>;
    readEnvironment: (scope: DeploymentReadScopeV1, environmentId: string, options: DeploymentReadOptionsV1)
        => Promise<DeploymentReadResultV1<DeploymentEnvironmentDetailV1>>;
    readEnvironmentTargetIdentity: (scope: DeploymentReadScopeV1, environmentId: string, targetLinkId: string,
        options: DeploymentReadOptionsV1) => Promise<DeploymentReadResultV1<DeploymentTargetIdentity>>;
    readTargetLinks: (scope: DeploymentReadScopeV1,
        targetLinks: readonly DeploymentTargetLinkChoiceV1['targetLink'][], options: DeploymentReadOptionsV1)
        => Promise<DeploymentReadResultV1<readonly DeploymentTargetLinkChoiceV1[]>>;
}>;

export async function readDeploymentDatabaseTargets(
    lifetime: ServerAccountScopeLifetime,
    machineId: string,
    input: DatabaseTargetsListInputV1,
    signal?: AbortSignal,
): Promise<DatabaseTargetsListResultV1> {
    const execute = createFrontDoorUiActionExecutor(undefined, {
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    });
    const result = await execute(ACTION_INVOKE_ACTION_ID_V1, {
        action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1) },
        input,
    }, { signal, externalActionTarget: { kind: 'machine', machineId } });
    return DatabaseTargetsListResultV1Schema.parse(result);
}

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
    const readDomainHeaders = async (environmentId: string, query: Readonly<{ cursor?: string; limit?: number }>,
        options: DeploymentReadOptionsV1) => {
        const parsed = DeploymentDomainListResultV1Schema.safeParse(await execute(DEPLOYMENT_DOMAIN_LIST_ACTION_ID_V1,
            { ...home, environmentId, ...query }, { signal: options.signal }));
        if (!parsed.success) return failure('invalid_response');
        const page = parsed.data;
        if (!page.ok) return failure(page.error);
        if (page.environmentId !== environmentId || page.domains.some(domain => domain.environmentId !== environmentId))
            return failure('invalid_response');
        return { ok: true as const, value: page };
    };
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
        query: Omit<Parameters<DeploymentReadTransportV1['listEnvironments']>[1], 'includeDatabaseMoveCandidates'>
            & Readonly<{ dataTargetLinks?: true }>,
        options: DeploymentReadOptionsV1) => {
        const parsed = DeploymentEnvironmentListResultV1Schema.safeParse(await execute('deployments.environments.list',
            { ...home, projectSourceId: scope.projectSourceId, ...query }, { signal: options.signal }));
        if (!parsed.success) return failure('invalid_response');
        const page = parsed.data;
        if (!page.ok) return failure(page.error);
        const requestedEnvironmentIds = query.environmentIds === undefined ? undefined : new Set(query.environmentIds);
        if (!page.items.every(row => (scope.projectSourceId === undefined || row.projectSourceId === scope.projectSourceId)
            && (requestedEnvironmentIds === undefined || requestedEnvironmentIds.has(row.id))
            && areServerProfileIdentifiersEquivalent(row.serverId, lifetime.scope.serverId))) return failure('invalid_response');
        if (page.runtimeTargetLinks?.length) {
            const environmentsById = new Map(page.items.map(row => [row.id, row]));
            if (page.runtimeTargetLinks.some(link => environmentsById.get(link.environmentId)?.runtimeTargetLinkId !== link.id)) {
                return failure('invalid_response');
            }
        }
        if (page.dataTargetLinks?.some(link => link.role !== 'data' || !page.items.some(row => row.id === link.environmentId))) {
            return failure('invalid_response');
        }
        return { ok: true as const, value: page };
    };
    const readReceiptHeaders = async (environmentId: string,
        query: Parameters<DeploymentReadTransportV1['listHistory']>[2] & Readonly<{ limit?: number }>,
        options: DeploymentReadOptionsV1) => {
        try {
            const page = decodeDeploymentReceiptHistoryPageV1(await execute(DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1,
                { ...home, environmentId, ...query }, { signal: options.signal }), environmentId);
            if (!page.ok) return failure(page.error);
            return { ok: true as const, value: page };
        } catch (error) {
            return failureFromError(error);
        }
    };
    const readReceipt: DeploymentReadTransportV1['readReceipt'] = (scope, environmentId, deploymentId, options) => scoped(scope, options, async account => {
        const parsed = DeploymentReceiptGetResultV1Schema.safeParse(await execute('deployments.receipts.get',
            { ...home, environmentId, deploymentId }, { signal: options.signal }));
        if (!parsed.success) return failure('invalid_response');
        const receipt = parsed.data;
        if (!receipt.ok) return failure(receipt.error);
        if (receipt.deployment.environmentId !== environmentId || receipt.deployment.id !== deploymentId) return failure('invalid_response');
        const cancellation = receipt.cancellable === undefined ? {} : { cancellable: receipt.cancellable };
        if (!hasDeploymentReceiptContentV1(receipt.deployment)) {
            return { ok: true, value: { deployment: receipt.deployment, content: null, ...cancellation } };
        }
        const artifact = await account.readArtifactContent(receipt.deployment.contentArtifactId, { signal: options.signal });
        const content = readDeploymentReceiptArtifactV1(receipt.deployment, artifact);
        if (!content.ok) return failure(content.error);
        const cancellationConsequence = projectDeploymentCancellationConsequenceV1({
            deployment: receipt.deployment, content: content.content,
        });
        return { ok: true, value: { deployment: receipt.deployment, content: content.content,
            ...cancellation,
            ...(cancellationConsequence ? { cancellationConsequence } : {}) } };
    });
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
            let selectedMetadata: Extract<Awaited<ReturnType<typeof readEnvironmentMetadata>>, { ok: true }>['value'] | undefined;
            let selectedContent: Extract<ReturnType<typeof readDeploymentEnvironmentArtifactV1>, { ok: true }> | undefined;
            const { operationalFacts, ...pageQuery } = query;
            if (query.environmentId !== undefined) {
                const metadata = await readEnvironmentMetadata(scope, query.environmentId, options);
                if (!metadata.ok) return metadata;
                selectedMetadata = metadata.value;
                const environment = selectedMetadata.environment;
                const [artifact] = await account.readArtifactContents([environment.contentArtifactId], { signal: options.signal });
                if (query.database !== undefined) {
                    const opened = readDeploymentEnvironmentArtifactV1(environment, artifact?.status === 'fulfilled' ? artifact.value : null);
                    if (!opened.ok) return failure(opened.error);
                    selectedContent = opened;
                }
                page = { items: [{ environment }], nextCursor: null };
                byId = new Map([[environment.contentArtifactId, artifact]]);
            } else {
                const parsed = DeploymentDataPageResultV1Schema.safeParse(await execute('deployments.data.page',
                    { ...home, projectSourceId: scope.projectSourceId, ...pageQuery }, { signal: options.signal }));
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
            const rows = page.items.flatMap(({ environment }) => {
                const artifact = byId.get(environment.contentArtifactId);
                const row = selectedContent ?? readDeploymentEnvironmentArtifactV1(environment,
                    artifact?.status === 'fulfilled' ? artifact.value : null);
                if (!row.ok) { coverage = 'partial'; return []; }
                return [{ environment, title: row.title, content: row.content,
                    projectSourceName: sourceNames.get(environment.projectSourceId) ?? null }];
            });
            if (operationalFacts === false) return { ok: true, value: { items: rows, nextCursor: page.nextCursor, coverage } };
            const databaseEnvironmentIds = rows.flatMap(({ environment, content }) => content.template?.data?.length
                ? [environment.id] : []);
            const pageMetadata = selectedMetadata === undefined && databaseEnvironmentIds.length > 0
                ? await readEnvironmentPageMetadata(scope, { environmentIds: databaseEnvironmentIds }, options) : undefined;
            const metadataEnvironments = new Map(pageMetadata?.ok ? pageMetadata.value.items.map(environment => [environment.id, environment]) : []);
            const runtimeByEnvironment = new Map(pageMetadata?.ok
                ? pageMetadata.value.runtimeTargetLinks?.map(link => [link.environmentId, link]) : []);
            for (const item of rows) {
                const { environment, content } = item;
                const previous = previousById.get(environment.id);
                let databaseTargets: DatabaseTargetsListResultV1 | undefined;
                let databaseSubjectFailure: Extract<DeploymentWorkbenchTargetReadV1, { ok: false }>['failure'] | undefined;
                const templateData = content.template?.data ?? [];
                const data = query.database === undefined ? templateData : templateData.filter(service => service.service === query.database);
                const runtimeLink = runtimeByEnvironment.get(environment.id);
                const runtimeEnvironment = selectedMetadata?.environment ?? metadataEnvironments.get(environment.id);
                const runtimeTargetLink = runtimeEnvironment ? selectDeploymentRuntimeTargetLinkV1({
                    environment: runtimeEnvironment,
                    targetLinks: (selectedMetadata?.targetLinks ?? (runtimeLink ? [runtimeLink] : [])).map(targetLink => ({ targetLink })),
                }) : null;
                let selected: DeploymentDataServiceReadItemV1['selected'];
                if (selectedMetadata && query.database !== undefined) {
                    let declared: (typeof data)[number] | undefined = data[0];
                    if (declared && !runtimeTargetLink?.activeDeploymentId) {
                        // The active pointer can be cleared after a deployment. Only an authoritative empty history
                        // proves that an authored service could not have been started.
                        const history = await readReceiptHeaders(environment.id, { limit: 1 }, options);
                        if (history.ok && history.value.items.length === 0 && history.value.nextCursor === null) declared = undefined;
                    }
                    const result = await readSelectedDatabase(account, options.signal, query.database, declared, selectedMetadata.targetLinks);
                    if (!result.ok) return result;
                    const address = result.value;
                    const selectedLink = address && address.kind !== 'selfHosted' ? address.link : null;
                    const detail: NonNullable<DeploymentDataServiceReadItemV1['selected']>['detail'] = {
                        environment, content, runtimeTargetLink,
                        targetLinks: selectedMetadata.targetLinks.map(targetLink =>
                            selectedLink?.targetLink === targetLink ? selectedLink : { targetLink }),
                        ...(selectedMetadata.savedSecretRevisions === undefined ? {} : { savedSecretRevisions: selectedMetadata.savedSecretRevisions }),
                        ...(selectedMetadata.secretScope === undefined ? {} : { secretScope: selectedMetadata.secretScope }),
                        ...(selectedMetadata.controller ? { controller: selectedMetadata.controller } : {}),
                    };
                    selected = { detail, address };
                    if (!address || address.kind === 'detached') {
                        items.push({ ...item, selected });
                        continue;
                    }
                }
                const databaseSubjects = new Map<string, AutomationDatabaseSubjectReadV1>();
                const projectDeclaredDatabaseSubjects = (bindings: DeploymentEnvironmentDetailV1['content']['bindings'],
                    deployedServices?: readonly string[]) => {
                    const declaredServices = content.template?.services;
                    for (const service of data) {
                        if (service.engine !== 'postgres' && service.engine !== 'mysql') continue;
                        if (!declaredServices?.includes(service.service) || data.filter(other => other.service === service.service).length !== 1) continue;
                        if (deployedServices && !deployedServices.includes(service.service)) continue;
                        const database = readDeploymentDatabaseRuntimeNameV1(service, bindings);
                        if (database === null) continue;
                        const parsed = AutomationDatabaseSubjectV1Schema.safeParse({ kind: 'database', serverId: environment.serverId,
                            target: { kind: 'environment', environmentId: environment.id, service: service.service, database } });
                        if (parsed.success) databaseSubjects.set(service.service, { ok: true, subject: parsed.data });
                    }
                };
                // Before the first deploy the authored declaration owns native identity.
                if (selectedMetadata && !runtimeTargetLink?.activeDeploymentId) projectDeclaredDatabaseSubjects(content.bindings);
                const address = selected?.address;
                const hasManagedData = address ? address.kind === 'managed'
                    : selectedMetadata !== undefined && hasDeploymentManagedDataLink(selectedMetadata.targetLinks);
                const selection = address?.kind === 'selfHosted' ? { kind: 'native_service' as const, service: address.data.service }
                    : address?.kind === 'managed' ? { kind: 'managed_link' as const, targetLinkId: address.link.targetLink.id } : undefined;
                if (selectedMetadata && (hasManagedData || runtimeTargetLink?.activeDeploymentId && (selection === undefined || selection.kind === 'native_service'))) {
                    if (environment.controllerMachineId) {
                        try {
                            databaseTargets = await readDeploymentDatabaseTargets(lifetime, environment.controllerMachineId, {
                                scope: { kind: 'environment', environment: { serverId: environment.serverId,
                                    projectSourceId: environment.projectSourceId, environmentId: environment.id },
                                    ...(selection ? { selection } : {}) },
                            }, options.signal);
                        } catch (error) {
                            databaseSubjectFailure = { ...failureFromError(error).failure,
                                ...(error instanceof HappyError ? { details: error.details, failureCause: error.failureCause,
                                    effectAttempted: error.effectAttempted } : {}) };
                        }
                    } else {
                        databaseSubjectFailure = failure('machine_unavailable').failure;
                    }
                }
                const descriptor = databaseTargets?.completeness.complete && databaseTargets.targets.length === 1
                    ? databaseTargets.targets[0] : undefined;
                const workbenchTarget: DeploymentWorkbenchTargetReadV1 | undefined = selection === undefined ? undefined
                    : descriptor ? { ok: true, value: descriptor }
                        : { ok: false, failure: databaseSubjectFailure ?? failure('database_target_unavailable').failure };
                // The controller can be unavailable while the saved serving receipt still identifies the native Database.
                const selectedNative = selection?.kind === 'native_service' ? selection.service : undefined;
                if ((databaseSubjectFailure || selectedNative && !descriptor)
                    && runtimeTargetLink?.targetKind === 'ownServer' && runtimeTargetLink.activeDeploymentId
                    && data.some(service => service.engine === 'postgres' || service.engine === 'mysql')) {
                    const serving = await readReceipt(scope, environment.id, runtimeTargetLink.activeDeploymentId, options);
                    const roster = readDeploymentNativeServiceRoster(environment.id, runtimeTargetLink, serving.ok ? serving.value : null);
                    if (serving.ok && serving.value.content && serving.value.deployment.targetLinkId === runtimeTargetLink.id) {
                        const basis = serving.value.content.ownServer?.approvedInputBasis;
                        if (basis?.environmentId === environment.id && basis.targetLinkId === runtimeTargetLink.id) {
                            projectDeclaredDatabaseSubjects(basis.bindings, basis.services);
                            if (!hasManagedData && data.every(service => (service.engine !== 'postgres' && service.engine !== 'mysql') || databaseSubjects.has(service.service))) databaseSubjectFailure = undefined;
                        }
                    }
                    if (selectedNative && selected && !descriptor && roster && !roster.includes(selectedNative)) {
                        items.push({ ...item, selected: { ...selected, address: null } });
                        continue;
                    }
                }
                if (databaseSubjectFailure) coverage = 'partial';
                const databaseSizes: DeploymentDatabaseSizeV1[] = [];
                const nativeTarget = deploymentDataTargetOperands({ environment,
                    runtimeTargetLink });
                for (const service of data) {
                    const unavailable = (reason: string): DeploymentDatabaseSizeV1 => ({ service: service.service,
                        size: { status: 'unavailable', reason }, growth: { status: 'unavailable', reason } });
                    if (!nativeTarget || !runtimeTargetLink?.activeDeploymentId) {
                        databaseSizes.push(unavailable(pageMetadata && !pageMetadata.ok ? pageMetadata.failure.code : 'active_deployment_required')); continue;
                    }
                    try {
                        const measured = DeploymentDataSizeResultV1Schema.safeParse(await execute(DEPLOYMENT_DATA_SIZE_ACTION_ID_V1,
                            { ...home, ...nativeTarget, deploymentId: runtimeTargetLink.activeDeploymentId,
                                service: service.service, previous: previous?.databaseSizes?.find(size => size.service === service.service) },
                            { signal: options.signal }));
                        databaseSizes.push(measured.success && measured.data.ok ? measured.data.size
                            : unavailable(measured.success ? measured.data.error : 'invalid_response'));
                    } catch (error) {
                        options.signal.throwIfAborted();
                        // Size telemetry can fail independently of the admitted Database subject.
                        databaseSizes.push(unavailable(failureFromError(error).failure.code));
                    }
                }
                for (const descriptor of databaseTargets?.targets ?? []) {
                    const target = descriptor.target;
                    // Native deployment_service identity is fully determined by the target. Keep the section visible
                    // when an older daemon omits the optional projected subject; managed targets still require the
                    // producer's explicit read/refusal because their provider identity is not reconstructible here.
                    const automationSubject = descriptor.automationSubject
                        ?? (target.kind === 'deployment_service'
                            ? readAutomationDatabaseSubjectV1(target.environment.serverId, target)
                            : undefined);
                    if (!automationSubject) continue;
                    if (target.kind === 'deployment_service') databaseSubjects.set(target.serviceId, automationSubject);
                    if (target.kind === 'managed_deployment' && !automationSubject.ok) databaseSubjects.set(target.targetLinkId, automationSubject);
                }
                items.push({ ...item, databaseSizes, databaseSubjects: Object.fromEntries(databaseSubjects),
                    ...(selected ? { selected } : {}),
                    ...(workbenchTarget ? { workbenchTarget } : {}),
                    ...(databaseSubjectFailure ? { databaseSubjectFailure } : {}) });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor, ...(coverage === undefined ? {} : { coverage }) } };
        }),
        listPublicCollectorDomains: (scope, input, options) => scoped(scope, options, async account => {
            const { machineId, serverId, cursor } = input;
            let app = input.app;
            if (!app) {
                const rows = await readMachineRows({ machineIds: [machineId], request: account.request,
                    readTransport: account.readTransport, signal: options.signal });
                app = rows.get(machineId)?.deploymentApp ?? undefined;
                if (!app) return { ok: true, value: { app: null, items: [], nextCursor: null } };
            }
            const { environmentId, targetLinkId, deploymentId, controller } = app;
            const page = await readDomainHeaders(environmentId, cursor ? { cursor } : {}, options);
            if (!page.ok) return page;
            // The selector admits each private-origin pointer before the Account reader batches it.
            const routes = await Promise.allSettled(page.value.domains.map(async domain => {
                const route = await selectPublicTelemetryCollectorDomainV1({
                    serverId, environmentId, targetLinkId, domainId: domain.id, domain,
                    collector: { machineId, deploymentId, controller },
                    open: async (artifactId, signal) => {
                        const [result] = await account.readArtifactContents([artifactId], { signal });
                        if (result?.status === 'rejected') throw result.reason;
                        return result?.value ?? null;
                    },
                    signal: options.signal,
                });
                return route.kind === 'ready' ? { domainId: domain.id, endpoint: route.endpoint } : null;
            }));
            const items = [];
            for (const route of routes) {
                if (route.status === 'rejected') throw route.reason;
                if (route.value) items.push(route.value);
            }
            return { ok: true, value: { app, items, nextCursor: page.value.nextCursor } };
        }),
        listDomains: (scope, environmentId, query, options) => scoped(scope, options, async account => {
            const headers = await readDomainHeaders(environmentId, query, options);
            if (!headers.ok) return headers;
            const page = headers.value;
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
            const { includeDatabaseMoveCandidates, ...metadataQuery } = query;
            const metadata = await readEnvironmentPageMetadata(scope,
                includeDatabaseMoveCandidates ? { ...metadataQuery, dataTargetLinks: true } : metadataQuery, options);
            if (!metadata.ok) return metadata;
            const page = metadata.value;
            const environmentsById = new Map(page.items.map(row => [row.id, row]));
            const runtimeByEnvironment = new Map(page.runtimeTargetLinks?.map(link => [link.environmentId, link]));
            const managedDataEnvironments = new Map(page.dataTargetLinks?.filter(link => hasDeploymentManagedDataLink([link]))
                .map(link => [link.environmentId, link] as const));
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
                let currentReceiptContent: ReturnType<typeof readDeploymentReceiptArtifactV1> | undefined;
                if (current && hasDeploymentReceiptContentV1(current.receipt)) {
                    const receiptHeader = contents[page.items.length + current.index];
                    const artifact = receiptHeader?.status === 'fulfilled' ? receiptHeader.value : null;
                    const projection = readDeploymentReceiptArtifactHeaderV1(current.receipt, artifact);
                    if (projection.ok) {
                        currentReceiptContent = readDeploymentReceiptArtifactV1(current.receipt, artifact);
                        currentDeployment = { ...current.receipt, title: projection.title, steps: projection.steps,
                            ...(currentReceiptContent.ok ? projectDeploymentReceiptSourceFactsV1(currentReceiptContent.content) : {}) };
                        if (!currentReceiptContent.ok) coverage = 'partial';
                    } else coverage = 'partial';
                } else if (current) currentDeployment = current.receipt;
                const runtimeTargetLink = runtimeByEnvironment.get(environment.id) ?? null;
                const managedDataTargetLink = managedDataEnvironments.get(environment.id);
                let liveAddress: string | null | undefined;
                if (addressMetadata && (runtimeTargetLink || environment.runtimeTargetLinkId === undefined)) {
                    if (!runtimeTargetLink?.activeDeploymentId) liveAddress = null;
                    else {
                        const active = servingById.get(runtimeTargetLink.activeDeploymentId);
                        if (active && hasDeploymentReceiptContentV1(active.receipt)) {
                            const read = contents[servingOffset + active.index];
                            const sameReceipt = current?.receipt.id === active.receipt.id
                                && current.receipt.contentArtifactId === active.receipt.contentArtifactId
                                && current.receipt.contentHeaderVersion === active.receipt.contentHeaderVersion
                                && current.receipt.contentBodyVersion === active.receipt.contentBodyVersion;
                            const opened = (sameReceipt ? currentReceiptContent : undefined)
                                ?? readDeploymentReceiptArtifactV1(active.receipt, read?.status === 'fulfilled' ? read.value : null);
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
                        ...(includeDatabaseMoveCandidates
                            ? { databaseMoveCandidate: managedDataTargetLink !== undefined
                                || await isDeploymentDatabaseMoveCandidateV1(opened.content, runtimeTargetLink),
                                ...(managedDataTargetLink ? { managedDataTargetLink } : {}) } : {}),
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
                ...(pendingDeployment === undefined ? {} : { pendingDeployment }),
                ...(detail.savedSecretRevisions === undefined ? {} : { savedSecretRevisions: detail.savedSecretRevisions }),
                ...(detail.secretScope === undefined ? {} : { secretScope: detail.secretScope }),
                ...(detail.runtimeReinstall === undefined ? {} : { runtimeReinstall: detail.runtimeReinstall }),
                ...(detail.controller ? { controller: detail.controller } : {}) } };
        }),
        listHistory: (scope, environmentId, query, options) => scoped(scope, options, async account => {
            const result = await readReceiptHeaders(environmentId, query, options);
            if (!result.ok) return result;
            const page = result.value;
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
                if (!hasDeploymentReceiptContentV1(receipt)) {
                    items.push(receipt);
                    continue;
                }
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
        readReceipt,
    } satisfies DeploymentReadTransportV1;
    return { ...transport,
        readEnvironmentTargetIdentity: (scope, environmentId, targetLinkId, options) => scoped(scope, options, async account => {
            const metadata = await readEnvironmentMetadata(scope, environmentId, options);
            if (!metadata.ok) return metadata;
            const { environment, targetLinks } = metadata.value;
            const link = targetLinks.find(candidate => candidate.id === targetLinkId);
            const source = link?.source;
            const declarations = readPluginAccountAvailability(account.accountLifetime.scope);
            const [[header], [artifact], manifest] = await Promise.all([
                account.readArtifactHeaders([environment.contentArtifactId], { signal: options.signal }),
                link ? account.readArtifactContents([link.contentArtifactId], { signal: options.signal }) : [],
                source?.kind === 'plugin' ? declarations.ensureAccountTargetDeclarations(source.contribution.pluginId)
                    .then(() => declarations.readCurrentAccountExecutionDeclarations()
                        .find(entry => entry.manifest.id === source.contribution.pluginId), () => undefined) : undefined,
            ]);
            const label = readEnvironmentName(environment, header);
            const platform = source && manifest
                ? createDeploymentTargetCatalogV1(listDeploymentTargetsFromManifestsV1([manifest])).read(source) : null;
            const openedLink = link && readDeploymentTargetLinkArtifactV1(link,
                artifact?.status === 'fulfilled' ? artifact.value : null);
            return { ok: true, value: {
                projectSourceId: environment.projectSourceId,
                ...(label.ok ? { name: label.title } : {}),
                ...(openedLink?.ok ? { targetName: readPlatformResourceName(openedLink.content)
                    ?? openedLink.content.nativeOrigin?.projectName ?? openedLink.title } : {}),
                ...(link ? { platform: platform ? readDeploymentTargetDisplayNameV1(platform) : link.targetKind } : {}),
            } };
        }),
        readEnvironmentNames: (scope, query, options) => scoped(scope, options, async account => {
            // A saved identity is named from the list the person can read: an Environment they only view (a Team member's)
            // refuses its detail read but still lists with its name.
            const metadata = await readEnvironmentPageMetadata(scope, query.environmentId === undefined ? query
                : { environmentIds: [query.environmentId] }, options);
            if (!metadata.ok) return metadata;
            const page = metadata.value;
            const headers = await readArtifactsByRow(page.items.map(row => row.contentArtifactId),
                ids => account.readArtifactHeaders(ids, { signal: options.signal }));
            const items: DeploymentEnvironmentNamePage['items'][number][] = [];
            let coverage = page.coverage;
            for (const [index, environment] of page.items.entries()) {
                const label = readEnvironmentName(environment, headers[index]);
                if (!label.ok) { coverage = 'partial'; continue; }
                items.push({ ...environment, name: label.title });
            }
            return { ok: true, value: { items, nextCursor: page.nextCursor, coverage } };
        }),
        readTargetLinks: (scope, targetLinks, options) => scoped(scope, options, account =>
            openTargetLinks(account, targetLinks, options.signal)),
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
